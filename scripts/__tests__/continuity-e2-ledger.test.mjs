// Faux controller/ledger integration with an inert child identity, not native-SDK subprocess proofs.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { digest } from "../lib/continuity-dataset.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { guardedController } from "../lib/continuity-guarded-controller.mjs";
import { guardedAccounting } from "../lib/continuity-guarded-accounting.mjs";
import { guardedReport } from "../lib/continuity-guarded-report.mjs";
import { lookupProcessStartIdentity } from "../lib/continuity-process-identity.mjs";
import { E2_REGISTRATION_SCHEMA, E2_PLAN_SCHEMA, E2_ASSUMPTIONS, E2_FAUX_AUTHORIZATION, E2_PILOT_IPC } from "../lib/continuity-e2-policy.mjs";
import { e2RequestPrice, loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { writeE2SummaryResult } from "../lib/continuity-e2-summary-receipts.mjs";
import { SOL } from "../lib/continuity-e2-protocol.mjs";
let root, outputRoot, pilot, authorization, journal, worker, seq;
const controller = guardedController("e2-validation"), accounting = guardedAccounting("e2-validation"), reports = guardedReport("e2-validation"), operationDigest = "d".repeat(64);
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "e2-faux-ledger-"))); outputRoot = join(root, "output"); await mkdir(outputRoot, { mode: 0o700 });
  vi.stubEnv("HOME", root); vi.stubEnv("XDG_STATE_HOME", join(root, "state")); seq = 0; journal = undefined; worker = undefined;
  pilot = { schema: E2_REGISTRATION_SCHEMA, registration: { code: { path: ROOT }, catalog: await loadE2Catalog(),
    roles: ["summary", "probe", "continuation"].map(role => ({ role, model: SOL, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 })),
    toolPolicies: { summary: [], proof: ["ConversationHistory"], replay: ["ConversationHistory"], cancelContinuation: ["ConversationHistory", "ProofSentinel"] },
    schedule: [{ slotId: "b".repeat(64), eligible: true, kind: "proof", arm: "switch", budgets: ["summary", "probe", "continuation"].map(paidRole => ({ checkpoint: 0, paidRole, model: SOL, maxRequests: 2 })) }] },
    descriptor: { schema: E2_PLAN_SCHEMA, assumptions: E2_ASSUMPTIONS, capUnits: "10000000000", deadlines: { deadlineMs: 30000, childWatchdogMs: 30000, runDeadlineMs: 60000 } },
    privateFixtureCanary: "FICTIONAL-PRIVATE-REGISTRATION-CANARY" };
  authorization = { schema: E2_FAUX_AUTHORIZATION, authorizationId: `fictional-${randomUUID()}`, outputRoot, pilotSha256: digest(pilot), scenarios: ["settled"], timeoutMs: 30000 };
});
afterEach(async () => {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited; }
  journal?.release(); if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
async function start() {
  authorization.pilotSha256 = digest(pilot); journal = await controller.createLookupPilotController({ real: false, pilot, authorization, outputRoot });
  worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { HOME: root, PATH: "/usr/bin:/bin" } }); await once(worker, "spawn");
  await journal.assign(0, { pid: worker.pid, startIdentity: lookupProcessStartIdentity(worker.pid) });
}
async function rpc(op, payload) { const s = journal.snapshot(); return (await journal.message(0, worker, { version: E2_PILOT_IPC, epoch: s.epoch, slotId: s.slots[0].slotId, seq: seq++, op, payload })).result; }
function admission(paidRole = "probe") {
  const s = journal.snapshot(), round = s.slots[0].holds.length + 1;
  return { requestId: `${s.runId}:${round}`, slotId: s.slots[0].slotId, round, payloadDigest: "a".repeat(64), inputTokens: 100, model: SOL, checkpoint: 0, paidRole,
    reservationUnits: e2RequestPrice(pilot.registration.catalog[0], { inputTokens: 100, maxOutputTokens: 128000 }).reservationUnits };
}
const summaryBegin = () => rpc("compaction", { kind: "begin", checkpoint: 0, operationDigest });
it("consumes the faux two-marker authority exclusively across fresh output roots", async () => {
  await start(); journal.release(); journal = undefined;
  const next = join(root, "next-output"); await mkdir(next, { mode: 0o700 });
  await expect(controller.createLookupPilotController({ real: false, pilot, authorization: { ...authorization, outputRoot: next }, outputRoot: next })).rejects.toMatchObject({ code: "e2_authorization_already_consumed" });
});
it("refuses a ceiling hold that exceeds an exact cap before any consume/send", async () => {
  pilot.descriptor.capUnits = "3919999999"; await start();
  expect(await rpc("admit", admission())).toEqual({ refused: true, code: "not_admitted_cap" });
  expect(journal.snapshot().slots[0].holds).toEqual([]); expect(accounting.accountRun(journal.snapshot().slots).totalUnits).toBe("0");
});
it("retains lost liability after the assigned child crashes mid-request, with observation-only recovery", async () => {
  await start(); const p = admission(), permit = await rpc("admit", p); await rpc("consume", { permit, bodyDigest: p.payloadDigest });
  const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited; await journal.finish(0, "lost"); journal.release(); journal = undefined;
  const report = await controller.reconcileLookupPilot(outputRoot); expect(report.reconciliation).toBe(true); expect(report.costs.retainedUnits).toBe("3920000000");
});
it("refuses a summary outside an actual declared lifecycle, without admitting a hold", async () => {
  await start(); await expect(rpc("admit", admission("summary"))).rejects.toMatchObject({ code: "e2_summary_not_authorized" });
  expect(journal.snapshot().slots[0].holds).toEqual([]);
});
it("keeps full own-cancellation liability instead of releasing the reserve", async () => {
  await start(); const p = admission(), permit = await rpc("admit", p); await rpc("consume", { permit, bodyDigest: p.payloadDigest });
  await rpc("settle", { permit, outcome: { kind: "own_abort_after_send" }, rawUsage: null, tier: null }); await journal.finish(0, "own_abort_after_send");
  expect(accounting.accountRun(journal.snapshot().slots)).toMatchObject({ retainedUnits: "3920000000", consecutiveProviderLosses: 0 });
});
it("retains a forged/missing summary result and never promotes it to probe authority", async () => {
  await start(); await summaryBegin(); const p = admission("summary"), permit = await rpc("admit", p); await rpc("consume", { permit, bodyDigest: p.payloadDigest });
  await expect(rpc("settle", { permit, outcome: { kind: "settled", costUnits: "300000" }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default", evidence: { schema: "continuity-e2-generated-summary-receipt-v1", sha256: "c".repeat(64) } })).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  expect(journal.snapshot().stop).toBe("e2_summary_receipt_invalid"); expect(accounting.accountRun(journal.snapshot().slots)).toMatchObject({ retainedUnits: "3920000000", knownPartialUnits: "300000" });
});
it("requires verified output plus durable-compaction acknowledgment before probes and publishes no canaries", async () => {
  await start(); await summaryBegin(); const p = admission("summary"), permit = await rpc("admit", p); await rpc("consume", { permit, bodyDigest: p.payloadDigest });
  const rawUsage = { input_tokens: 100, output_tokens: 10 }, message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "FICTIONAL-GENERATED-SUMMARY-CANARY" }] };
  const written = await writeE2SummaryResult({ runId: journal.snapshot().runId, slotId: p.slotId, e2: { paidRole: "summary", model: SOL, round: 1, outputRoot } }, message, rawUsage, "default", p.payloadDigest);
  await rpc("settle", { permit, outcome: { kind: "settled", costUnits: "300000" }, rawUsage, tier: "default", evidence: written.evidence });
  expect(journal.snapshot().slots[0].holds[0].summaryReceipt).toMatchObject({ verified: true, durable: false });
  await rpc("compaction", { kind: "durable", checkpoint: 0, operationDigest });
  const probe = admission(), probePermit = await rpc("admit", probe); await rpc("consume", { permit: probePermit, bodyDigest: probe.payloadDigest });
  await rpc("settle", { permit: probePermit, outcome: { kind: "settled", costUnits: "300000" }, rawUsage, tier: "default" }); await journal.finish(0, "completed", 1);
  const state = journal.snapshot(), report = reports.aggregateRun(state, [reports.slotReceipt(state, 0)]);
  expect(report.authorization).toBe(false); expect(report.qualityMeasured).toBe(false); expect(report.costs.completeUnits).toBe("600000");
  expect(report.phases[0].calls.verifiedSummaries).toBe(1);
  for (const secret of [root, "FICTIONAL-PRIVATE-REGISTRATION-CANARY", "FICTIONAL-GENERATED-SUMMARY-CANARY", written.evidence.sha256, authorization.authorizationId]) expect(JSON.stringify(report)).not.toContain(secret);
});

import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { STATISTICAL_SPEC } from "../lib/continuity-holdout-statistics.mjs";
import { loadHoldoutSpec } from "../lib/continuity-holdout-generator.mjs";
import { checkHoldoutOverlap } from "../lib/continuity-holdout-overlap.mjs";
import { jsonBytes, sha256, CHECKOUT } from "../lib/continuity-holdout-files.mjs";
import { fixtureProofRun } from "./fixtures/holdout-proof-output.mjs";
import { syntheticContext } from "./fixtures/holdout-synthetic.mjs";
import { stopReason, spendOf, accountUnits, authFailure, groupAlive, terminateGroup } from "../lib/continuity-holdout-controller.mjs";
import { representatives, checkProofUnit } from "../lib/continuity-holdout-proof.mjs";

let directory, inputs, repo, context, workflow, controller, proof, serial = 0;
const workerURL = new URL("./fixtures/holdout-worker.mjs", import.meta.url);
const parse = async path => JSON.parse(await readFile(path, "utf8"));
async function until(fn) { for (let i = 0; i < 200; i++) { try { const result = await fn(); if (result) return result; } catch { /* Wait for fixture publication. */ } await delay(25); } throw new Error("fixture_deadline"); }
beforeAll(async () => {
  await mkdir(join(CHECKOUT, ".worklab-tmp"), { recursive: true });
  directory = await realpath(await mkdtemp(join(CHECKOUT, ".worklab-tmp/holdout-workflow-")));
  ({ repo, inputs, context, workflow, controller, proof } = await syntheticContext(directory));
}, 30000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function authorization(bundle, path) {
  const record = { planDigest: bundle.plan.confirmation, ceilingUSD: bundle.ceilingUSD, authPathFingerprint: bundle.plan.piAuthFingerprint, approver: "Synthetic custodian", timestamp: "2040-01-01T00:00:00.000Z" };
  await writeFile(path, jsonBytes(record), { mode: 0o600 }); return record;
}
async function options(shard = 1) {
  const output = join(directory, `controller-${++serial}`), authorizationPath = join(inputs, `authorization-${serial}.json`);
  await authorization(context.plans[shard - 1], authorizationPath);
  return { shard, output, authorizationPath, deadlineMs: 5000, workerURL, env: {} };
}
async function run(mode, shard = 1) {
  const opts = await options(shard); opts.env = { HOLDOUT_FIXTURE_MODE: mode };
  return { opts, state: await controller.runController(context, opts) };
}

it("persists every shard plan, catalog, inventory and blocked real confirmation without dispatch", async () => {
  const result = await workflow.preparePlans(context, join(directory, "plans"));
  expect(result.admissible).toBe(true); expect(result.shards).toHaveLength(2);
  for (const row of result.shards) {
    expect(row.upperUSD).toBeLessThan(row.ceilingUSD); expect(row.ceilingUSD).toBe(25);
    const receipt = await parse(join(directory, "plans", `shard-${row.shard}`, "blocked-confirmation.json"));
    expect(receipt).toMatchObject({ planDigest: row.planDigest, modulesBlocked: 1, providerDispatches: 0 });
    const bundle = await parse(join(directory, "plans", `shard-${row.shard}`, "dry-plan.json"));
    expect(bundle.prices[bundle.plan.reader.model].input).toBeGreaterThanOrEqual(0); expect(bundle.inventory).toBeTruthy();
  }
});
it("exposes the portable plan CLI with zero dispatch", () => {
  const o = context.options, output = join(directory, "cli-plans");
  const result = spawnSync(process.execPath, [join(repo, "scripts/continuity-holdout/workflow.mjs"), "plan",
    "--corpus-manifest", o.manifestPath, "--manifest-sha256", o.manifestSha256,
    "--registration", o.registrationPath, "--registration-sha256", o.registrationSha256,
    "--statistical-spec", o.statisticalSpecPath, "--pi-auth-path", o.piAuthPath, "--output", output], { encoding: "utf8", env: {}, timeout: 10000 });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).shards).toHaveLength(2);
});
it("requires an authorization record before creating a controller", async () => {
  const opts = await options(); delete opts.authorizationPath;
  await expect(controller.runController(context, opts)).rejects.toThrow("authorization_required");
});
it.each(["planDigest", "ceilingUSD", "authPathFingerprint", "approver", "timestamp"])("refuses mismatched authorization %s before admission", async key => {
  const opts = await options(), record = await parse(opts.authorizationPath); record[key] = key === "ceilingUSD" ? 24 : "";
  await writeFile(opts.authorizationPath, jsonBytes(record));
  await expect(controller.runController(context, opts)).rejects.toThrow("authorization_mismatch");
  await expect(readFile(join(opts.output, "controller.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("reserves durably before child start, verifies archives, finishes all units, and consumes authorization once", async () => {
  const { opts, state } = await run("valid"); expect(state.stop).toEqual({ reason: "completed", reconciled: true });
  expect(state.chunks).toHaveLength(2); expect(state.spend.admittedUnits).toBe(16); expect(state.spend.invalidUnits).toBe(0);
  expect(state.spend.knownUSD).toBeCloseTo(0.252); expect(state.spend.lostUSD).toBe(0);
  for (const [i, chunk] of state.chunks.entries()) {
    expect(await parse(join(opts.output, "chunks", String(i + 1), "write-ahead-proof.json"))).toMatchObject({ reservationDurable: true, pid: chunk.pid });
    await expect(workflow.verifyArchive(join(opts.output, "chunks", String(i + 1)), chunk.archiveSha256)).resolves.toBeTruthy();
  }
  expect(await controller.runController(context, opts)).toEqual(state);
  await expect(controller.runController(context, { ...opts, output: join(directory, "duplicate-auth-root") })).rejects.toThrow("authorization_already_claimed");
});
it.each(["partial", "failed"])("never readmits %s units on restart", async mode => {
  const { opts, state } = await run(mode);
  expect(state.stop.reason).toBe("invalid_unit_rate"); expect(state.chunks).toHaveLength(1); expect(state.spend.lostUSD).toBeGreaterThan(0);
  expect(await controller.runController(context, opts)).toEqual(state);
});
it.each([[1, 10, null], [1, 9, "invalid_unit_rate"], [8, 80, null], [9, 80, "invalid_unit_rate"]])("uses admitted-unit invalid boundary %i/%i", (invalidUnits, admittedUnits, reason) => {
  expect(stopReason({ invalidUnits, admittedUnits, totalUSD: 0, unpriced: 0, authFailure: false }, 25)).toBe(reason);
});
it("counts known cost, bootstrap/incremental unknown reserves and lost holds separately", () => {
  const bundle = context.plans[0], t = bundle.plan.corpus.traces[0], p = bundle.prices[bundle.plan.upkeep.model];
  const unit = { traceId: t.id, arm: "native", repeat: 1, complete: true, checkpoint: {}, trials: [{ status: "completed", boundary: { verified: true }, usage: { calls: 1, inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.1 } }],
    ...{ checkpoint: { upkeep: { preparations: ["bootstrap", "incremental"].map(budget => ({ receipt: { providerInvoked: true, status: "uncertain", reason: "uncertain" }, journal: { budget } })) } } } };
  const a = accountUnits([unit], bundle);
  expect(a.knownUSD).toBe(0.1); expect(a.unknownCalls).toBe(2);
  expect(a.unknownUSD).toBeCloseTo((192000 * p.input + 8192 * p.output) / 1e6, 12);
  const spend = spendOf([{ state: "failed", reservationUsd: 2, unitFiles: 1, accounting: a }], 8);
  expect(spend.lostUSD).toBe(2); expect(spend.totalUSD).toBeCloseTo(2.1 + a.unknownUSD);
  expect(stopReason({ ...spend, invalidUnits: 0 }, spend.totalUSD + 1, 1)).toBe(null); expect(stopReason({ ...spend, invalidUnits: 0 }, spend.totalUSD + 1, 1.001)).toBe("budget_admission");
});
it("reserves unknown reader usage and rejects absent catalog prices before any dispatch", async () => {
  const bundle = context.plans[0], traceId = bundle.plan.corpus.traces[0].id;
  const a = accountUnits([{ traceId, arm: "native", complete: false, trials: [{ status: "completed" }] }], bundle);
  expect(a.unknownCalls).toBe(1); expect(a.unknownUSD).toBeGreaterThan(0);
  const emptyComponents = accountUnits([{ traceId, arm: "native", complete: false,
    trials: [{ status: "completed", usage: { calls: 1, components: [] } }] }], bundle);
  expect(emptyComponents.unknownCalls).toBe(1); expect(emptyComponents.unknownUSD).toBe(a.unknownUSD);
  const changed = structuredClone(context); changed.plans[0].admissible = false; changed.plans[0].estimate.status = "unknown_price";
  const opts = await options(); const state = await controller.runController(changed, opts);
  expect(state.stop.reason).toBe("unpriced_reservation"); expect(state.chunks).toEqual([]);
  const over = structuredClone(context); over.plans[0].admissible = false;
  const second = await controller.runController(over, await options()); expect(second.stop.reason).toBe("budget_admission");
});
it.each([["auth", "auth_failure"], ["budget", "budget_admission"]])("stops on live %s journal receipts without inspecting quality", async (mode, reason) => {
  const { state } = await run(mode); expect(state.stop).toEqual({ reason, reconciled: true }); expect(state.chunks).toHaveLength(1);
  expect(groupAlive(state.chunks[0].pid)).toBe(false);
});
it("kills only its owned process session on deadline, keeps the full hold and never retries", async () => {
  const sentinel = fork(new URL("./fixtures/holdout-park.mjs", import.meta.url), [], { stdio: "ignore", execArgv: [] });
  try {
    const opts = await options(); opts.deadlineMs = 500; opts.env = { HOLDOUT_FIXTURE_MODE: "park" };
    const state = await controller.runController(context, opts);
    expect(state.stop).toEqual({ reason: "chunk_deadline", reconciled: true }); expect(state.chunks[0].state).toBe("killed");
    const parked = await parse(join(opts.output, "chunks/1/park.json")); expect(parked.pid).toBeGreaterThan(0);
    expect(groupAlive(state.chunks[0].pid)).toBe(false); expect(() => process.kill(sentinel.pid, 0)).not.toThrow();
    expect(state.spend.lostUSD).toBe(state.chunks[0].reservationUsd);
    expect(await controller.runController(context, opts)).toEqual(state);
  } finally { const done = once(sentinel, "exit"); sentinel.kill("SIGKILL"); await done; }
});
it("recovers a crashed controller's durable reservation without dispatching twice", async () => {
  const opts = await options(); opts.deadlineMs = 100000;
  const driver = fork(new URL("./fixtures/holdout-controller-driver.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: {} });
  let pid;
  try {
    const { loaded, ...portable } = context;
    driver.send({ context: portable, modulePath: join(repo, "scripts/lib/continuity-holdout-controller.mjs"), options: { ...opts, workerURL: undefined } });
    pid = await until(async () => { const state = await parse(join(opts.output, "controller.json")); await parse(join(opts.output, "chunks/1/park.json")); return state.chunks[0]?.pid; });
    await expect(controller.runController(context, opts)).rejects.toThrow("controller_locked");
    const exited = once(driver, "exit"); driver.kill("SIGKILL"); await exited;
    await until(() => !groupAlive(pid));
    const state = await controller.runController(context, opts);
    expect(state.stop).toEqual({ reason: "unreconciled_running_chunks", reconciled: true });
    expect(state.chunks).toHaveLength(1); expect(state.chunks[0].state).toBe("lost"); expect(state.spend.lostUSD).toBe(state.chunks[0].reservationUsd);
    expect(await controller.runController(context, opts)).toEqual(state);
  } finally {
    if (driver.exitCode === null && driver.signalCode === null) { const done = once(driver, "exit"); driver.kill("SIGKILL"); await done; }
    if (pid && groupAlive(pid)) await terminateGroup(pid);
  }
});
it("joins validated complete/partial shards into planned statistics and cannot accept absent audit evidence", async () => {
  const first = await run("valid", 1), second = await run("valid", 2);
  const result = await workflow.joinShards(context, [second.opts.output, first.opts.output], join(directory, "joined"));
  expect(result.controllerComplete).toBe(true); expect(result.statistics.integrity.complete).toBe(true); expect(result.statistics.plannedAnswersPerArm).toBe(120);
  expect(result.auditBinding).toBe(null); expect(result.statistics.decision.status).not.toBe("pass"); expect(result.statistics.decision.reasons).toContain("audit-material:inconclusive");
  const partial = await workflow.joinShards(context, [first.opts.output], join(directory, "joined-missing"));
  expect(partial.controllerComplete).toBe(false); expect(partial.statistics.integrity.complete).toBe(false);
  expect(partial.statistics.scopes.combined.plannedAnswers).toBe(120); expect(partial.statistics.decision.status).not.toBe("pass");
  const audit = join(inputs, "audit.json"); await writeFile(audit, jsonBytes({ registrationSha256: context.options.registrationSha256, complete: true, published: 3, audited: 3, labelFindings: 0, contextFindings: 0, falselySupersededCurrent: 0, bindingErrors: 0 }));
  const audited = await workflow.joinShards(context, [first.opts.output, second.opts.output], join(directory, "joined-audit"), audit);
  expect(audited.auditBinding.sha256).toBe(sha256(await readFile(audit))); expect(audited.statistics.decision.reasons).toContain("audit-workflow-pending:inconclusive"); expect(audited.statistics.decision.status).not.toBe("pass");
  await expect(workflow.joinShards(context, [first.opts.output, first.opts.output], join(directory, "duplicate-shard"))).rejects.toThrow("duplicate_or_unknown_shard");
  const copy = join(directory, "mutated"); await cp(first.opts.output, copy, { recursive: true });
  const state = await parse(join(copy, "controller.json")); state.binding = "bad"; await writeFile(join(copy, "controller.json"), jsonBytes(state));
  await expect(workflow.joinShards(context, [copy], join(directory, "bad-bind"))).rejects.toThrow("controller_binding_or_stop_mismatch");
  state.binding = first.state.binding; state.stop.reconciled = false; await writeFile(join(copy, "controller.json"), jsonBytes(state));
  await expect(workflow.joinShards(context, [copy], join(directory, "bad-stop"))).rejects.toThrow("controller_binding_or_stop_mismatch");
  await writeFile(join(copy, "controller.json"), jsonBytes(first.state));
  const files = await readdir(join(copy, "chunks/1/units")); await writeFile(join(copy, "chunks/1/units", files[0]), "{}");
  await expect(workflow.joinShards(context, [copy], join(directory, "tamper"))).rejects.toThrow("archive_content_mismatch");
  const originalUnits = await workflow.chunkUnits(join(first.opts.output, "chunks/1"), context.plans[0].plan, first.state.chunks[0].traceId);
  const unit = structuredClone(originalUnits[0]); unit.trials[0].probeId = "unknown";
  expect(() => workflow.validateUnit(unit, context.plans[0].plan, unit.traceId)).toThrow("trial_membership_mismatch");
  unit.trials = originalUnits[0].trials; unit.traceId = "unregistered";
  expect(() => workflow.validateUnit(unit, context.plans[0].plan, unit.traceId)).toThrow("unit_binding_mismatch");
});
it("never stops on quality and retains known failures from an incomplete join", async () => {
  const { opts, state } = await run("quality_fail"); expect(state.stop.reason).toBe("completed");
  const result = await workflow.joinShards(context, [opts.output], join(directory, "quality-failure"));
  expect(result.statistics.decision.status).toBe("fail"); expect(result.controllerComplete).toBe(false);
  expect(result.statistics.scopes.combined.ledgerWrong).toBeGreaterThan(0);
});
it("keeps even a numerically all-pass candidate inconclusive pending audit certification", () => {
  const candidate = { decision: { status: "pass", gates: [], reasons: [] } };
  workflow.pendingAuditGate(candidate, true);
  expect(candidate.decision.status).toBe("inconclusive"); expect(candidate.decision.reasons).toContain("audit-workflow-pending:inconclusive");
  const failing = { decision: { status: "fail", gates: [], reasons: ["known-failure"] } };
  workflow.pendingAuditGate(failing, false); expect(failing.decision.status).toBe("fail");
});
it("records malformed unit material as stopped, never leaves it readmitted as running", async () => {
  const { state, opts } = await run("malformed"); expect(state.stop).toEqual({ reason: "invalid_unit_material", reconciled: true });
  expect(state.chunks[0].state).toBe("failed"); expect(state.spend.lostUSD).toBeGreaterThan(0);
  expect(await controller.runController(context, opts)).toEqual(state);
});
it("will not signal an unowned live session while reconciling a stale receipt", async () => {
  const { opts, state } = await run("valid");
  const unrelated = fork(new URL("./fixtures/holdout-park.mjs", import.meta.url), [], { detached: true, stdio: "ignore", execArgv: [] });
  try {
    await until(() => groupAlive(unrelated.pid));
    state.stop = null; state.chunks = [{ ...state.chunks[0], state: "running", pid: unrelated.pid }];
    await writeFile(join(opts.output, "controller.json"), jsonBytes(state));
    await expect(controller.runController(context, opts)).rejects.toThrow("unreconciled_running_chunks");
    expect((await parse(join(opts.output, "controller.json"))).stop.reconciled).toBe(false);
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
  } finally { const done = once(unrelated, "exit"); await terminateGroup(unrelated.pid); await done; }
});
it("rejects duplicate trial units and mismatches of every shared shard binding", async () => {
  const { opts, state } = await run("valid"), root = join(opts.output, "chunks/1/units"), name = (await readdir(root))[0];
  await cp(join(root, name), join(root, "duplicate.json"));
  await expect(workflow.chunkUnits(join(opts.output, "chunks/1"), context.plans[0].plan, state.chunks[0].traceId)).rejects.toThrow("duplicate_unit");
  await rm(join(root, "duplicate.json"));
  for (const field of ["codeRevision", "manifestSha256", "registrationSha256", "statisticalSpecSha256"]) {
    const changed = structuredClone(context);
    if (field === "codeRevision") changed.plans[0].plan.codeRevision = "0".repeat(40);
    else changed.plans[0].plan.holdout[field] = "0".repeat(64);
    await expect(workflow.joinShards(changed, [opts.output], join(directory, `mismatch-${field}`))).rejects.toThrow("controller_binding_or_stop_mismatch");
  }
});
it("imports the current degradation vocabulary, not a copied historical list", async () => {
  const { preparationDisposition } = await import("../lib/continuity-runner.mjs");
  for (const reason of ["ledger_payload_budget", "ledger_lineage_budget", "ledger_aggregate_capacity", "source_oversized", "upkeep_dispatch_rejected", "output_overrun"]) expect(preparationDisposition({ status: "skipped", reason })).toBe("degraded");
  expect(preparationDisposition({ status: "skipped", reason: "read_only" })).toBe("integrity");
  expect(preparationDisposition({ status: "skipped", reason: "unrecognized" })).toBe("integrity");
  expect(authFailure({ answer: "provider_auth" })).toBe(false); expect(authFailure({ receipt: { failureKind: "provider_auth" } })).toBe(true);
});
it("validates reduced synthetic proof artifacts through the same all/15-probe checker; full replay is an explicit drill", async () => {
  const selected = representatives(context.registration.conversations, context.registration.seed);
  expect(selected).toEqual(representatives([...context.registration.conversations].reverse(), context.registration.seed)); expect(selected).toHaveLength(2);
  const result = await proof.offlineProof(context, join(directory, "offline"), { run: fixtureProofRun(context) });
  expect(result.qualityMeasured).toBe(false); expect(result.receipts.map(r => r.units)).toEqual([16, 8]);
  const unitFile = (await readdir(join(directory, "offline/all/units"))).find(n => n.endsWith("continuity-ledger-cold.json"));
  const unit = await parse(join(directory, "offline/all/units", unitFile)); checkProofUnit(unit);
  for (const [mutate, code] of [
    [u => { u.checkpoint.upkeep.preparations[1].pid = u.checkpoint.upkeep.preparations[0].pid; }, "offline_preparation_integrity"],
    [u => { u.checkpoint.upkeep.preparations[0].preserved = false; }, "offline_preparation_integrity"],
    [u => { u.checkpoint.upkeep.preparations[0].observed.upkeepScans[0].limits.rows = 0; }, "offline_scan_budget"],
    [u => { u.checkpoint.upkeep.preparations[0].journal.offerCounts[0].offer_count = 3; }, "offline_offer_budget"],
    [u => { u.trials[0].boundary.observed.upkeepScans.push({}); }, "offline_probe_upkeep"],
    [u => { u.trials[0].boundary.observed.continuityPacks = []; }, "offline_injection"],
  ]) { const bad = structuredClone(unit); mutate(bad); expect(() => checkProofUnit(bad)).toThrow(code); }
  const capturePath = join(directory, "offline/all/upkeep-output", `r1-${unit.traceId}-p1.json`), capture = await parse(capturePath);
  capture.ledger.spans[0].owner = false; await writeFile(capturePath, jsonBytes(capture));
  await expect(proof.auditProofOutput(context, join(directory, "offline/all"), context.registration.conversations.map(c => c.id), 1)).rejects.toThrow("offline_host_citation");
});

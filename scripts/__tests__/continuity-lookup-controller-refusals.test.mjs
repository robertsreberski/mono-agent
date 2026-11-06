import { lookupAuthorizationArtifact } from "./fixtures/lookup-authorization-artifact.mjs";
import { expect } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pilotSuite, loadPilot, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_FAUX_AUTHORIZATION_DOMAIN } from "../lib/continuity-lookup-pilot.mjs";

const suite = pilotSuite({scoped: true}), it = suite.test;
async function kernel(capUSD = 100) {
  const f = suite.fixture, options = await runOptions(f);
  options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot);
  const c = await loadPilot(f, "controller"), journal = await c.createLookupPilotController(options); suite.cleanup(() => journal.release());
  const idle = await suite.spawn({ mode: "idle" }), worker = await idle.reply;
  await journal.assign(0, worker);
  return { journal, worker, options, seq: 0 };
}
const hash = "a".repeat(64);
async function message(k, op, payload, overrides = {}) {
  const s = k.journal.snapshot();
  return k.journal.message(s.cursor, k.worker, { version: "lookup-pilot-ipc-v1", epoch: s.epoch, slotId: s.slots[s.cursor].slotId, seq: k.seq++, op, payload, ...overrides });
}
async function admit(k, round = 1) {
  const s = k.journal.snapshot(); return (await message(k, "admit", { requestId: `${s.runId}:${round}`, slotId: s.slots[s.cursor].slotId, round, payloadDigest: hash, rmax: 3.92 })).result;
}
// Sequential cases: parallelism is supplied by Vitest files, never by a queue.

it.each(["stale", "order", "digest", "duplicate", "cost"])("refuses %s messages durably and never repairs the channel", async variant => {
  const k = await kernel(), permit = await admit(k);
  if (variant === "stale") await expect(message(k, "consume", { permit, bodyDigest: hash }, { epoch: "old" })).rejects.toThrow("lookup_ipc_invalid");
  if (variant === "order") await expect(message(k, "consume", { permit, bodyDigest: hash }, { seq: 20 })).rejects.toThrow("lookup_ipc_invalid");
  if (variant === "digest") await expect(message(k, "consume", { permit, bodyDigest: "b".repeat(64) })).rejects.toThrow("lookup_permit_invalid");
  if (variant === "duplicate") { await message(k, "consume", { permit, bodyDigest: hash }); await expect(message(k, "consume", { permit, bodyDigest: hash })).rejects.toThrow("lookup_permit_invalid"); }
  if (variant === "cost") { await message(k, "consume", { permit, bodyDigest: hash }); await expect(message(k, "settle", { permit, outcome: { kind: "settled", cost: 0 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" })).rejects.toThrow("lookup_hold_exceeded"); }
  expect(k.journal.snapshot().stop).not.toBeNull();
});

it("refuses a complete artifact instead of the six-key real locator before any lease or output write", async () => {
  const f = suite.fixture, base = await fs.mkdtemp(join(f.base, "real-refusal-")), outputRoot = join(base, "output");
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const options = { pilot: f.pilot, outputRoot, authorization: lookupAuthorizationArtifact(f.pilot, {
    registrationRawSha256: createHash("sha256").update(JSON.stringify(f.pilot)).digest("hex"), outputRoot, credentialPath: join(base, "fictional-credential.json") }) };
  const p = await suite.spawn({ options }, { CI: "1" }, {deferReplyUntilExit: true});
  expect(await p.reply).toEqual({ failed: "lookup_authorization_binding_mismatch" }); await p.exit;
  expect(await fs.readdir(outputRoot)).toEqual([]);
  for (const path of [join(outputRoot, "controller-lock.sqlite"), join(base, ".lookup-faux-consumed-v1")]) await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`))).ci).toBe("1");
});

it("refuses the exact real locator in a CI child before registration, credentials or lease", async () => {
  const f = suite.fixture, base = await fs.mkdtemp(join(f.base, "real-ci-refusal-")), outputRoot = join(base, "output");
  await fs.mkdir(outputRoot, {mode: 0o700});
  const options = {pilot: f.pilot, outputRoot, authorization: {schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: join(base, "absent-authorization.json"), registrationPath: join(base, "absent-registration.json"), registrationSha256: "a".repeat(64), credentialPath: join(base, "absent-credential.json"), controllerRoot: f.repo}};
  const p = await suite.spawn({options}, {CI: "1"}, {deferReplyUntilExit: true});
  expect(await p.reply).toEqual({failed: "paid_mode_refused_in_ci"}); await p.exit;
  expect(await fs.readdir(outputRoot)).toEqual([]);
});

it("holds the lease for the entire run and refuses competing controllers", async () => {
  const k = await kernel(); const c = await loadPilot(suite.fixture, "controller");
  await expect(c.createLookupPilotController(k.options)).rejects.toThrow("lookup_authorization_lease_invalid");
});

it("rejects a dropped journal replacement in the controller before issuing an ACK", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "premature-ack.json");
  await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "lookup-pilot-controller.json"), revision: 3, action: "skip" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config });
  expect(await p.reply).toMatchObject({ failed: "lookup_persist_failed" }); await p.exit;
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.revision).toBe(2); expect(state.slots[0].holds).toEqual([]);
});

it("does not accept an injected send dependency, even on a faux authorization", async () => {
  const options = await runOptions(suite.fixture), c = await loadPilot(suite.fixture, "controller");
  await expect(c.runLookupPilot({ ...options, send: () => { throw new Error("fictional-forbidden-send"); } })).rejects.toThrow("lookup_pilot_faux_required");
  expect(await fs.readdir(options.outputRoot)).toEqual([]);
});

it("never releases an admitted-but-unsent hold by claiming a pre-admission refusal", async () => {
  const k = await kernel(), permit = await admit(k);
  await expect(message(k, "settle", { permit, outcome: { kind: "refused_pre_send" }, rawUsage: null, tier: null })).rejects.toThrow("lookup_permit_invalid");
  expect(k.journal.snapshot().slots[0].holds[0]).toMatchObject({ reservedUnits: "78400000", consumed: false });
});

it.each(["completed", "budget_admission", "lookup_recovery_only", "lookup_unreconciled_processes", "lookup_run_deadline"])("rejects controller-only IPC stop %s", async code => {
  const k = await kernel(); await expect(message(k, "stop", { code })).rejects.toThrow("lookup_ipc_invalid");
  expect(k.journal.snapshot().stop).toBe("lookup_ipc_invalid");
});

it("refuses a worker with a null start identity", async () => {
  const k = await kernel(); await k.journal.finish(0, "lost");
  await expect(k.journal.assign(1, { ...k.worker, startIdentity: null })).rejects.toThrow("lookup_ipc_invalid");
});

it.each(["unadmitted", "refused_pre_send", "fictional-unknown"])("persists a protocol stop for a child-claimed %s terminal", async terminal => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "settled", cost: .0003 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" });
  await expect(k.journal.finish(0, terminal)).rejects.toThrow("lookup_ipc_invalid");
  expect(k.journal.snapshot().stop).toBe("lookup_ipc_invalid");
});

it("does not continue an untyped zero-hold guard refusal", async () => {
  const k = await kernel();
  await expect(k.journal.finish(0, "refused_pre_send")).rejects.toThrow("lookup_ipc_invalid");
  expect(k.journal.snapshot().stop).toBe("lookup_ipc_invalid");
});

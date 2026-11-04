import { lookupAuthorizationArtifact } from "./fixtures/lookup-authorization-artifact.mjs";
import { it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pilotSuite, loadPilot, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_FAUX_AUTHORIZATION_DOMAIN } from "../lib/continuity-lookup-pilot.mjs";

const suite = pilotSuite(), journals = [];
afterEach(() => { for (const j of journals.splice(0)) j.release(); });
async function kernel(capUSD = 100) {
  const f = suite.fixture, options = await runOptions(f);
  options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot);
  const c = await loadPilot(f, "controller"), journal = await c.createLookupPilotController(options); journals.push(journal);
  const idle = await suite.spawn({ mode: "idle" }), worker = await idle.reply;
  await journal.assign(0, worker);
  return { journal, worker, options, seq: 0 };
}
const hash = "a".repeat(64);
async function message(k, op, payload, overrides = {}) {
  const s = k.journal.snapshot();
  return k.journal.message(s.cursor, k.worker, { version: "lookup-faux-ipc-v1", epoch: s.epoch, slotId: s.slots[s.cursor].slotId, seq: k.seq++, op, payload, ...overrides });
}
async function admit(k, round = 1) {
  const s = k.journal.snapshot(); return (await message(k, "admit", { requestId: `${s.runId}:${round}`, slotId: s.slots[s.cursor].slotId, round, payloadDigest: hash, rmax: 3.92 })).result;
}
it("persists holds, one-time consumption, raw settlement and independent partial receipts before ACK", async () => {
  const k = await kernel(), permit = await admit(k), path = join(k.options.outputRoot, "lookup-pilot-controller.json");
  let disk = JSON.parse(await fs.readFile(path)); expect(disk.slots[0].holds[0].consumed).toBe(false);
  await message(k, "consume", { permit, bodyDigest: hash }); disk = JSON.parse(await fs.readFile(path)); expect(disk.slots[0].holds[0].consumed).toBe(true);
  await message(k, "settle", { permit, outcome: { kind: "settled", cost: .0003 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" });
  disk = JSON.parse(await fs.readFile(path)); expect(disk.slots[0].holds[0].settlement).toMatchObject({ kind: "settled", knownUnits: "6000" });
  const receipt = JSON.parse(await fs.readFile(join(k.options.outputRoot, "slots", `${disk.slots[0].slotId}.json`)));
  expect(receipt.calls).toEqual({ admitted: 1, consumed: 1, settled: 1 }); expect(disk.slots[0].terminal).toBeNull();
});
it("admits cap equality and persists a sticky cap refusal without readmission", async () => {
  const k = await kernel(3.92), permit = await admit(k);
  await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "lost" }, rawUsage: null, tier: null });
  await k.journal.finish(0, "lost"); k.seq = 0; await k.journal.assign(1, k.worker);
  expect(await admit(k)).toEqual({ refused: true, code: "not_admitted_cap" }); expect(k.journal.snapshot().stop).toBe("budget_admission");
});
it("accepts a priced integrity settlement after stop, without reopening admission", async () => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "stop", { code: "lookup_auth_failure" });
  await message(k, "settle", { permit, outcome: { kind: "integrity_stop", code: "lookup_output_envelope_violated" },
    rawUsage: { input_tokens: 272000, output_tokens: 1000000 }, tier: null });
  const s = k.journal.snapshot(); expect(s.stop).toBe("lookup_auth_failure"); expect(BigInt(s.slots[0].holds[0].settlement.knownUnits)).toBeGreaterThan(78400000n);
});
it.each(["stale", "order", "digest", "duplicate", "cost"])("refuses %s messages durably and never repairs the channel", async variant => {
  const k = await kernel(), permit = await admit(k);
  if (variant === "stale") await expect(message(k, "consume", { permit, bodyDigest: hash }, { epoch: "old" })).rejects.toThrow("lookup_ipc_invalid");
  if (variant === "order") await expect(message(k, "consume", { permit, bodyDigest: hash }, { seq: 20 })).rejects.toThrow("lookup_ipc_invalid");
  if (variant === "digest") await expect(message(k, "consume", { permit, bodyDigest: "b".repeat(64) })).rejects.toThrow("lookup_permit_invalid");
  if (variant === "duplicate") { await message(k, "consume", { permit, bodyDigest: hash }); await expect(message(k, "consume", { permit, bodyDigest: hash })).rejects.toThrow("lookup_permit_invalid"); }
  if (variant === "cost") { await message(k, "consume", { permit, bodyDigest: hash }); await expect(message(k, "settle", { permit, outcome: { kind: "settled", cost: 0 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" })).rejects.toThrow("lookup_hold_exceeded"); }
  expect(k.journal.snapshot().stop).not.toBeNull();
});
it("serializes a stop/grant race and rejects consumption after the stop", async () => {
  const k = await kernel(), grant = admit(k), stopped = k.journal.stop("lookup_quota_exhausted");
  const permit = await grant; await stopped;
  expect(k.journal.snapshot().slots[0].holds[0].revoked).toBe(true);
  await expect(message(k, "consume", { permit, bodyDigest: hash })).rejects.toThrow("lookup_permit_invalid");
});
it("refuses a complete real-schema artifact in a CI child before any lease or output write", async () => {
  const f = suite.fixture, base = await fs.mkdtemp(join(f.base, "real-refusal-")), outputRoot = join(base, "output");
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const options = { pilot: f.pilot, outputRoot, authorization: lookupAuthorizationArtifact(f.pilot, {
    registrationRawSha256: createHash("sha256").update(JSON.stringify(f.pilot)).digest("hex"), outputRoot, credentialPath: join(base, "fictional-credential.json") }) };
  const p = await suite.spawn({ options }, { CI: "1" });
  expect(await p.reply).toEqual({ failed: "lookup_pilot_real_route_unavailable" }); await p.exit;
  expect(await fs.readdir(outputRoot)).toEqual([]);
  for (const path of [join(outputRoot, "controller-lock.sqlite"), join(base, ".lookup-faux-consumed-v1")]) await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`))).ci).toBe("1");
});
it("holds the lease for the entire run and refuses competing controllers", async () => {
  const k = await kernel(); const c = await loadPilot(suite.fixture, "controller");
  await expect(c.createLookupPilotController(k.options)).rejects.toThrow("lookup_authorization_lease_invalid");
});
it.each([1, 2, 3, 4, 5, 6, 8])("reconciles only after real SIGKILL before/after state revision %s", async revision => {
  const f = suite.fixture, c = await loadPilot(f, "controller");
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f);
    // The fault configuration is outside the bound output, which must initially be unused.
    const config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "lookup-pilot-controller.json"), revision, phase }), { mode: 0o600 });
    const process = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await process.reply;
    expect((await process.exit).signal).toBe("SIGKILL");
    const path = join(options.outputRoot, "lookup-pilot-controller.json");
    try {
      const state = JSON.parse(await fs.readFile(path)); expect(state.revision).toBe(phase === "after" ? revision : revision - 1);
      const report = await c.reconcileLookupPilot(options.outputRoot); expect(report.reconciliation).toBe(true);
      await expect(c.createLookupPilotController(options)).rejects.toThrow();
    } catch (e) { if (revision !== 1 || phase !== "before" || e.code !== "ENOENT") throw e; }
  }
});
it("rejects a dropped journal replacement in the controller before issuing an ACK", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "premature-ack.json");
  await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "lookup-pilot-controller.json"), revision: 3, action: "skip" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config });
  expect(await p.reply).toMatchObject({ failed: "lookup_persist_failed" }); await p.exit;
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.revision).toBe(2); expect(state.slots[0].holds).toEqual([]);
});
it.each(["authorization-consumed.json", "claim.json"])("burns authorization across before/after %s persistence crashes", async name => {
  const f = suite.fixture;
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f), key = createHash("sha256").update(LOOKUP_FAUX_AUTHORIZATION_DOMAIN + options.authorization.authorizationId).digest("hex");
    const path = name === "claim.json" ? join(f.base, ".lookup-faux-consumed-v1", key, name) : join(options.outputRoot, name);
    const config = join(f.base, `${options.authorization.authorizationId}.fault.json`); await fs.writeFile(config, JSON.stringify({ path, phase }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await p.reply; expect((await p.exit).signal).toBe("SIGKILL");
    expect((await fs.lstat(join(f.base, ".lookup-faux-consumed-v1", key))).isDirectory()).toBe(true);
  }
});

it("retains independently priced partial usage even when the settlement claim lies", async () => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await expect(message(k, "settle", { permit, outcome: { kind: "settled", cost: 0 }, rawUsage: { input_tokens: 272000, output_tokens: 1000000 }, tier: null })).rejects.toThrow("lookup_hold_exceeded");
  expect(BigInt(k.journal.snapshot().slots[0].holds[0].settlement.knownUnits)).toBeGreaterThan(78400000n);
});
it("enforces the registered absolute run deadline before admission", async () => {
  const f = suite.fixture, options = await runOptions(f); options.pilot = structuredClone(options.pilot);
  options.pilot.descriptor.deadlines.runDeadlineMs = 1; options.authorization.pilotSha256 = digest(options.pilot);
  const c = await loadPilot(f, "controller"), journal = await c.createLookupPilotController(options); journals.push(journal);
  const idle = await suite.spawn({ mode: "idle" }), worker = await idle.reply; await journal.assign(0, worker);
  const k = { journal, worker, options, seq: 0 }; expect(await admit(k)).toEqual({ refused: true, code: "lookup_stopped" });
  expect(journal.snapshot().stop).toBe("lookup_run_deadline");
});

it.each([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]])("keeps a conservative journal across before/after partial receipt persistence %j", async (admitted, consumed, settled) => {
  const f = suite.fixture, c = await loadPilot(f, "controller"), first = c.lookupPilotSchedule(f.pilot)[0];
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "slots", `${first.slotId}.json`), phase, calls: { admitted, consumed, settled } }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await p.reply; expect((await p.exit).signal).toBe("SIGKILL");
    const report = await c.reconcileLookupPilot(options.outputRoot);
    if (admitted) expect(report.cost.totalUSD).toBe(3.92);
    else expect(report.counts.admitted).toBe(0);
  }
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

it("reconciles before/after final report persistence without resuming", async () => {
  const f = suite.fixture, c = await loadPilot(f, "controller");
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f), path = join(options.outputRoot, "report.json"), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path, phase }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await p.reply; expect((await p.exit).signal).toBe("SIGKILL");
    if (phase === "after") expect(JSON.parse(await fs.readFile(path)).stop).toBe("budget_admission");
    else await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await c.reconcileLookupPilot(options.outputRoot)).cost.totalUSD).toBe(3.92);
  }
});
it("preserves terminal journal status across before/after completed receipt persistence", async () => {
  const f = suite.fixture, c = await loadPilot(f, "controller"), first = c.lookupPilotSchedule(f.pilot)[0];
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f, ["settled"]), path = join(options.outputRoot, "slots", `${first.slotId}.json`), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path, phase, calls: { admitted: 1, consumed: 1, settled: 1 }, terminal: "completed" }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await p.reply; expect((await p.exit).signal).toBe("SIGKILL");
    expect(JSON.parse(await fs.readFile(path)).terminal).toBe(phase === "after" ? "completed" : null);
    expect((await c.reconcileLookupPilot(options.outputRoot)).counts.completed).toBe(1);
  }
});

it.each(["completed", "budget_admission", "lookup_recovery_only", "lookup_unreconciled_processes", "lookup_run_deadline"])("rejects controller-only IPC stop %s", async code => {
  const k = await kernel(); await expect(message(k, "stop", { code })).rejects.toThrow("lookup_ipc_invalid");
  expect(k.journal.snapshot().stop).toBe("lookup_ipc_invalid");
});
it("derives a zero-hold refusal as unadmitted despite a worker lost claim", async () => {
  const k = await kernel(3.92), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "lost" }, rawUsage: null, tier: null }); await k.journal.finish(0, "lost");
  k.seq = 0; await k.journal.assign(1, k.worker); expect(await admit(k)).toMatchObject({ refused: true }); await k.journal.finish(1, "lost");
  expect(k.journal.snapshot().slots[1]).toMatchObject({ terminal: "unadmitted", admissionRefusal: "budget_admission" });
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
it.each([["two_rounds", 6, "refused_pre_send"], ["lost", 8, "unadmitted"]])("reconciles a crash after %s admission refusal consistently with live classification", async (scenario, revision, terminal) => {
  const f = suite.fixture, options = await runOptions(f, [scenario]), config = join(f.base, `refusal-crash-${scenario}.json`);
  await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "lookup-pilot-controller.json"), revision, phase: "after" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await p.reply; expect((await p.exit).signal).toBe("SIGKILL");
  const c = await loadPilot(f, "controller"), report = await c.reconcileLookupPilot(options.outputRoot);
  expect(report.receipts.at(-1)).toMatchObject({ terminal, terminalCode: "budget_admission" });
  expect(report.counts).toMatchObject({ admitted: 1, incomplete: 1, invalid: 0, unadmitted: terminal === "unadmitted" ? 1 : 0 });
});

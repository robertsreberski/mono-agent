import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Socket } from "node:net";
let runner, mint, fauxMint, restore, send, run, a, state, readState;
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("test_egress_denied"); });
  vi.stubGlobal("fetch", () => { throw Error("test_egress_denied"); });
  const config = { fictional: true }, trace = { id: "trace", probes: [{ id: "probe" }] };
  runner = { productionModules: vi.fn(async () => ({ config: { resolveJsonMonoAgentConfig: () => config } })), configJson: () => ({}), lookupConfig: () => ({}), pilotDispatchConfig: p => p,
    buildCheckpoint: vi.fn(async () => ({ work: "/fictional/checkpoint", snapshot: "/fictional/snapshot", record: { conversationId: "fictional-conversation" } })),
    createJudge: vi.fn(() => null), runProbe: vi.fn(async () => ({ status: "completed", score: { pass: true } })) };
  send = Object.assign(() => {}, { permit: { close: vi.fn(), stop: vi.fn(async () => {}) } }); mint = vi.fn(async () => send);
  vi.doMock("../lib/continuity-runner.mjs", () => runner);
  vi.doMock("../lib/continuity-dataset.mjs", async original => ({ ...await original(), loadTraces: vi.fn(async () => ({ traces: [trace] })) }));
  vi.doMock("../lib/continuity-lookup-real-capability.mjs", () => ({ createLookupRealSend: mint, isRealLookupSend: () => false, realLookupSendForGuard: () => false }));
  state = { schema: "continuity-lookup-controller-v1" };
  fauxMint = vi.fn(async () => send);
  readState = vi.fn(async () => state);
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", () => ({ readPilotPrivate: readState, pilotStatePath: r => r,
    LOOKUP_REAL_CONTROLLER: "continuity-lookup-controller-v1", LOOKUP_FAUX_CONTROLLER: "continuity-lookup-faux-controller-v1" }));
  vi.doMock("../lib/continuity-lookup-faux-capability.mjs", () => ({ createLookupFauxSend: fauxMint }));
  restore = vi.fn(async () => ({ proof: {}, work: "/fictional/checkpoint", manifest: { conversationId: "fictional-conversation", continuity: null } }));
  vi.doMock("../lib/continuity-lookup-preparation.mjs", () => ({ assertLookupPilotArm: arm => { if (arm.restart) throw Object.assign(Error("lookup_pilot_boundary_required"), { code: "lookup_pilot_boundary_required" }); },
    restoreLookupPreparation: restore }));
  ({ runLookupConfiguredProbe: run } = await import("../lib/continuity-lookup-pilot-probe.mjs"));
  a = { outputRoot: "/fictional/output", slotId: "fictional-slot", plan: { judge: null, reader: { model: "openai-codex:gpt-6.1-sol", effort: "high" } },
    authorization: { credentialPath: "/fictional/credential" }, slot: { code: "R0", suite: "holdout", traceId: "trace", probeId: "probe" },
    pilot: { registration: { codes: { R0: { path: "/fictional/r0" } } } }, roleRequest: { binding: { arm: "native-lookup" }, common: { lookupSelection: { seed: 1, perGroup: 2 } } } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of ["runner", "dataset", "lookup-real-capability", "lookup-preparation", "lookup-pilot-state", "lookup-faux-capability"]) vi.doUnmock(`../lib/continuity-${path}.mjs`); });
it("restores before mint and threads the same context through judge and probe without building a checkpoint", async () => {
  expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
  for (const name of ["createJudge", "runProbe"]) expect(mint.mock.invocationCallOrder[0]).toBeLessThan(runner[name].mock.invocationCallOrder[0]);
  expect(restore.mock.invocationCallOrder[0]).toBeLessThan(mint.mock.invocationCallOrder[0]);
  expect(fauxMint).not.toHaveBeenCalled();
  const pilot = runner.runProbe.mock.calls[0][0].pilot;
  expect(pilot).toMatchObject({ routeKind: "real", send }); expect(runner.createJudge.mock.calls[0][0].pilot).toBe(pilot); expect(runner.runProbe.mock.calls[0][0].pilot).toBe(pilot);
  expect(runner.buildCheckpoint).not.toHaveBeenCalled(); expect(send.permit.close).toHaveBeenCalledTimes(1);
});
it("does not enter any helper after mint refusal", async () => {
  mint.mockRejectedValue(Object.assign(Error("lookup_pilot_capability_invalid"), { code: "lookup_pilot_capability_invalid" }));
  await expect(run(a)).rejects.toThrow("lookup_pilot_capability_invalid");
  expect(runner.createJudge).not.toHaveBeenCalled(); expect(runner.buildCheckpoint).not.toHaveBeenCalled(); expect(runner.runProbe).not.toHaveBeenCalled();
});
it("refuses an unserved arm before restoration or mint", async () => {
  a.roleRequest.binding.arm = "restart-switch-compact";
  await expect(run(a)).rejects.toThrow("lookup_pilot_boundary_required"); expect(mint).not.toHaveBeenCalled(); expect(runner.buildCheckpoint).not.toHaveBeenCalled();
});
it("stops a policy-failed trial instead of publishing it as generic loss", async () => {
  runner.runProbe.mockResolvedValue({ status: "failed", failure: "lookup_payload_repeated" });
  expect(await run(a)).toEqual({ terminal: "refused_pre_send", score: null, refusalCode: "lookup_payload_repeated" });
  expect(send.permit.stop).toHaveBeenCalledExactlyOnceWith("lookup_payload_repeated"); expect(send.permit.close).toHaveBeenCalledTimes(1);
});

it.each(["not_admitted_input_envelope", "lookup_request_limit", "not_admitted_cap", "lookup_stopped", "lookup_slot_terminal"])("preserves SDK capacity refusal %s without a policy stop", async code => {
  runner.runProbe.mockResolvedValue({ status: "failed", failure: code });
  expect(await run(a)).toEqual({ terminal: "refused_pre_send", score: null, refusalCode: code }); expect(send.permit.stop).not.toHaveBeenCalled();
});
it("does not classify SDK account mismatch as provider loss", async () => {
  runner.runProbe.mockResolvedValue({ status: "failed", failure: "lookup_account_mismatch" });
  expect(await run(a)).toEqual({ terminal: "integrity_stop", score: null });
});

it.each(["pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified"])("preserves non-provider terminal %s", async terminal => {
  runner.runProbe.mockResolvedValue(terminal === "pilot_empty_final_output" ? { status: "failed", failure: terminal } : { status: terminal });
  expect(await run(a)).toEqual({ terminal, score: null }); expect(send.permit.stop).not.toHaveBeenCalled(); expect(send.permit.close).toHaveBeenCalledTimes(1);
});

it("selects faux mint from durable schema even when assignment claims real authorization", async () => {
  state.schema = "continuity-lookup-faux-controller-v1";
  a.authorization.schema = "continuity-lookup-pilot-authorization-v1";
  expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
  expect(mint).not.toHaveBeenCalled(); expect(fauxMint).toHaveBeenCalledOnce();
  expect(runner.runProbe.mock.calls[0][0].pilot.routeKind).toBe("faux");
});
it("refuses preflight state before restoration or either mint", async () => {
  state.schema = "lookup-preflight-controller-v1";
  await expect(run(a)).rejects.toThrow("lookup_preparation_invalid");
  expect(restore).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled(); expect(fauxMint).not.toHaveBeenCalled();
});

it.each(["lookup_receipt_invalid", "EACCES", "ENOENT"])("maps state read failure %s to the fixed preparation code before mint", async code => {
  readState.mockRejectedValue(Object.assign(Error("fictional private path"), {code}));
  await expect(run(a)).rejects.toThrow("lookup_preparation_invalid");
  expect(restore).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled(); expect(fauxMint).not.toHaveBeenCalled();
});

const SENTINELS = ["chr1_FICTIONAL-RECORD", "a".repeat(64), "b".repeat(64), "c".repeat(64), "MORGAN-7Q4", "/fictional/private-path"];
const snapshot = () => ({ source: { availability: "retained", recordId: SENTINELS[0], sha256: SENTINELS[1], retainedBytes: 99, value: SENTINELS[4], path: SENTINELS[5] },
  initialContextBytes: 1234, initiallyPresent: false, records: [{ recordId: SENTINELS[0], sha256: SENTINELS[2], bytes: 10, chunks: 1, verified: true }], sourceReturned: true,
  calls: 2, bytes: 300, responses: 2, largestResponse: 200, responseBytes: [100, 200], responseSha256: [SENTINELS[3]], searchPages: 1, getChunks: 1, cumulativeBytes: 400,
  exhausted: null, rounds: 3, budgetFeasibility: { classification: "feasible", reasons: [] }, exactAccuracy: true, witnessedRecovery: true });
const projected = { schema: "lookup-pilot-slot-lookup-v1", initiallyPresent: false, initialContextBytes: 1234, sourceAvailability: "retained", sourceReturned: true,
  calls: 2, responses: 2, bytes: 300, searchPages: 1, getChunks: 1, rounds: 3, exhausted: null, witnessedRecovery: true };
async function recordRoot() {
  const { mkdtemp, mkdir, realpath } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join, dirname } = await import("node:path");
  const { lookupPilotWork } = await import("../lib/continuity-lookup-pilot-runtime.mjs");
  a.outputRoot = await realpath(await mkdtemp(join(tmpdir(), "lookup-slot-record-"))); await mkdir(dirname(lookupPilotWork(a)), { recursive: true, mode: 0o700 });
  const { lookupSlotRecordPath } = await import("../lib/continuity-lookup-slot-record.mjs");
  return lookupSlotRecordPath(a);
}
it.each([
  ["completed", { status: "completed", score: { pass: true } }, { terminal: "completed", score: 1 }],
  ["lost budget exhaustion", { status: "failed", failure: "lookup_budget_calls" }, { terminal: "lost", score: null }],
  ["policy refusal", { status: "failed", failure: "lookup_payload_repeated" }, { terminal: "refused_pre_send", score: null, refusalCode: "lookup_payload_repeated" }],
  ["capacity refusal", { status: "failed", failure: "not_admitted_cap" }, { terminal: "refused_pre_send", score: null, refusalCode: "not_admitted_cap" }],
])("writes the private content-free lookup record for a %s trial before classification", async (_name, trial, outcome) => {
  const path = await recordRoot(), { readFile, stat, rm } = await import("node:fs/promises");
  try {
    runner.runProbe.mockResolvedValue({ ...trial, lookup: snapshot() });
    expect(await run(a)).toEqual(outcome);
    const bytes = await readFile(path, "utf8");
    expect(JSON.parse(bytes)).toEqual(projected); expect((await stat(path)).mode & 0o777).toBe(0o600);
    for (const value of SENTINELS) expect(bytes).not.toContain(value);
    expect(bytes).not.toMatch(/[a-f0-9]{64}/u);
  } finally { await rm(a.outputRoot, { recursive: true, force: true }); }
});
it("writes no record without trial lookup evidence and never reclassifies a slot on write failure", async () => {
  const path = await recordRoot(), { readFile, writeFile, rm, access } = await import("node:fs/promises");
  try {
    expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "fictional-existing", { mode: 0o600 });
    runner.runProbe.mockResolvedValue({ status: "completed", score: { pass: false }, lookup: snapshot() });
    expect(await run(a)).toEqual({ terminal: "wrong", score: 0 }); expect(await readFile(path, "utf8")).toBe("fictional-existing");
    runner.runProbe.mockResolvedValue({ status: "completed", score: { pass: true }, lookup: { ...snapshot(), calls: -1 } });
    await rm(path); expect(await run(a)).toEqual({ terminal: "completed", score: 1 });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(a.outputRoot, { recursive: true, force: true }); }
});
it("validates the exact record shape and rejects any non-projected or mistyped field", async () => {
  const { lookupSlotRecord, validateLookupSlotRecord } = await import("../lib/continuity-lookup-slot-record.mjs");
  expect(lookupSlotRecord(snapshot())).toEqual(projected);
  expect(lookupSlotRecord({ source: { availability: "unknown" }, initiallyPresent: "unknown", initialContextBytes: null, sourceReturned: false, calls: 0, responses: 0, bytes: 0,
    searchPages: 0, getChunks: 0, rounds: 0, exhausted: "latency", witnessedRecovery: false })).toMatchObject({ initiallyPresent: "unknown", exhausted: "latency" });
  for (const change of [{ recordId: SENTINELS[0] }, { sha256: SENTINELS[1] }, { records: [] }, { answer: SENTINELS[4] }, { schema: "other" },
    { initiallyPresent: "yes" }, { initialContextBytes: -1 }, { initialContextBytes: null }, { sourceAvailability: "annotated" }, { sourceReturned: 1 },
    { calls: 1.5 }, { bytes: "3" }, { rounds: Number.MAX_SAFE_INTEGER + 1 }, { exhausted: "deadline" }, { witnessedRecovery: "false" },
    { witnessedRecovery: true, initiallyPresent: "unknown" }]) {
    expect(() => validateLookupSlotRecord({ ...projected, ...change }), JSON.stringify(change)).toThrow("lookup_slot_record_invalid");
  }
  const { schema: _schema, ...missing } = projected;
  expect(() => validateLookupSlotRecord(missing)).toThrow("lookup_slot_record_invalid");
  expect(() => validateLookupSlotRecord(Object.assign(Object.create({ inherited: true }), projected))).toThrow("lookup_slot_record_invalid");
});
it("writes the record synchronously, owner-only and exclusively, never following or replacing an entry", async () => {
  const path = await recordRoot(), { readFile, stat, rm, symlink, writeFile, lstat } = await import("node:fs/promises"), { existsSync } = await import("node:fs");
  // readPilotPrivate is mocked in this file; the production reader round-trip is in the pilot-witness test.
  const { writeLookupSlotRecord, validateLookupSlotRecord } = await import("../lib/continuity-lookup-slot-record.mjs");
  try {
    const record = writeLookupSlotRecord(a, snapshot());
    // No promise and no sync/fsync round trips: the file exists before any await, so done is never delayed.
    expect(typeof record?.then).toBe("undefined"); expect(existsSync(path)).toBe(true);
    expect(record).toEqual(projected); expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(validateLookupSlotRecord(JSON.parse(await readFile(path, "utf8")))).toEqual(projected);
    expect(() => writeLookupSlotRecord(a, { ...snapshot(), calls: 9 })).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(JSON.parse(await readFile(path, "utf8")).calls).toBe(2);
    await rm(path); const target = `${path}.fictional-target`; await writeFile(target, "fictional"); await symlink(target, path);
    expect(() => writeLookupSlotRecord(a, snapshot())).toThrow(); expect(await readFile(target, "utf8")).toBe("fictional");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    await rm(path); expect(() => writeLookupSlotRecord(a, { ...snapshot(), rounds: -1 })).toThrow("lookup_slot_record_invalid"); expect(existsSync(path)).toBe(false);
  } finally { await rm(a.outputRoot, { recursive: true, force: true }); }
});

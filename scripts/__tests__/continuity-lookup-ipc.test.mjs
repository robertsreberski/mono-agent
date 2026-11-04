import { it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { pilotSuite, loadPilot, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { fixtureGit } from "./fixtures/holdout-synthetic.mjs";
import { sourceState, assertSource } from "../lib/memory-e2e-build.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
const suite = pilotSuite();
async function run(scenarios, timeoutMs, capUSD, extraEnv = {}) {
  const options = await runOptions(suite.fixture, scenarios, timeoutMs);
  if (capUSD !== undefined) { options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot); }
  const p = await suite.spawn({ options }, extraEnv);
  const result = await p.reply; await p.exit; await suite.witnesses(); return { options, result };
}
it("runs the real forked probe and guard over IPC with persisted arrival witnesses and inherited CI", async () => {
  const { options, result } = await run(["two_rounds", "lost"], undefined, 3.93, { CI: "1" });
  expect(result.failed).toBeUndefined(); expect(result.result.executionKind).toBe("faux-only");
  expect(result.result.receipts[0].calls).toEqual({ admitted: 2, consumed: 2, settled: 2 });
  expect(result.result.counts.incomplete).toBe(1); expect(result.result.stop).toBe("budget_admission");
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].worker.pid).not.toBe(state.controller.pid);
  for (const pid of [state.controller.pid, state.slots[0].worker.pid]) expect(JSON.parse(await fs.readFile(join(suite.fixture.base, "witnesses", `${pid}.json`))).ci).toBe("1");
  expect(new Set(state.slots.filter(s => s.worker).map(s => s.worker.pid)).size).toBe(state.slots.filter(s => s.worker).length);
  expect(state.schedule.every(s => !Object.hasOwn(s, "cacheKey"))).toBe(true);
});
it.each(["disconnect", "die", "hang", "descendant"])("contains a real %s worker without admitting a replacement", async scenario => {
  const { result } = await run([scenario], scenario === "hang" ? 1000 : 5000);
  if (scenario === "descendant") { expect(result).toEqual({ failed: "lookup_unreconciled_processes" }); return; }
  expect(result.failed).toBeUndefined(); expect(result.result.stop).not.toBe("completed");
  expect(result.result.schedule.visited).toBe(1); expect(result.result.counts.invalid).toBe(0);
});
it.each(["auth", "quota", "integrity_stop", "empty"])("persists the sticky %s outcome and partial receipt independently of exit", async scenario => {
  const { result } = await run([scenario]); expect(result.failed).toBeUndefined();
  const report = result.result; expect(report.stop).not.toBe("completed"); expect(report.receipts[0].admitted).toBe(true);
  if (scenario === "integrity_stop") expect(report.cost.knownPartialUSD).toBeGreaterThan(3.92);
  if (scenario === "empty") expect(report.counts.invalid).toBe(1);
});
it("treats a wrong answer as a completed observation rather than invalidity", async () => {
  const { result } = await run(["wrong", "lost"]); expect(result.result.counts.invalid).toBe(0);
  expect(result.result.receipts[0]).toMatchObject({ terminal: "wrong", score: 0 });
});
it("checks the live parent and rejects a directly invoked client without assigned durable state", async () => {
  const { createLookupPilotIPC } = await loadPilot(suite.fixture, "ipc");
  await expect(createLookupPilotIPC({ outputRoot: suite.fixture.base, epoch: "fake", index: 0 })).rejects.toThrow();
});
it("rejects changed controller checkout before consuming a faux authorization", async () => {
  const options = await runOptions(suite.fixture); options.pilot = structuredClone(options.pilot);
  options.pilot.registration.codes.R0.path = suite.fixture.pack; options.authorization.pilotSha256 = digest(options.pilot);
  const { createLookupPilotController } = await loadPilot(suite.fixture, "controller");
  await expect(createLookupPilotController(options)).rejects.toThrow();
  expect(await fs.readdir(options.outputRoot)).toEqual([]);
});
it("reconciles a controller SIGKILL at one faux arrival without ever readmitting or signaling recovery groups", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "arrival-kill.json");
  await fs.writeFile(config, JSON.stringify({ action: "arrival" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await p.reply; expect((await p.exit).signal).toBe("SIGKILL");
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].holds[0].consumed).toBe(true); expect(state.slots[0].holds[0].settlement).toBeNull();
  const { reconcileLookupPilot } = await loadPilot(f, "controller");
  const report = await reconcileLookupPilot(options.outputRoot);
  expect(report.cost.totalUSD).toBe(3.92); expect(report.counts).toMatchObject({ admitted: 1, incomplete: 1 }); expect(report.schedule.visited).toBe(1); expect(report.reconciliation).toBe(true); await suite.witnesses();
});

it.each(["plan", "build", "role", "pid", "epoch", "marker", "debug", "descriptor", "role-id", "registration", "role-build"])("refuses a real child's swapped %s before ready and before admission", async kind => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `swap-${kind}.json`);
  await fs.writeFile(config, JSON.stringify({ action: `swap-${kind}` }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); const reply = await p.reply; await p.exit;
  expect(reply.result.counts.admitted).toBe(0); expect(reply.result.stop).not.toBe("completed"); await suite.witnesses();
});
it.each(["stale", "order", "duplicate", "digest"])("refuses real IPC %s interference with no consumed permit", async kind => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `wire-${kind}.json`);
  await fs.writeFile(config, JSON.stringify({ action: `wire-${kind}` }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); const reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).not.toBe("completed"); expect(reply.result.receipts.every(r => r.calls.consumed === 0)).toBe(true); await suite.witnesses();
});

it.each([
  [["lost", "lost"], 8, "lookup_repeated_loss"],
  [["lost", "own_abort_after_send"], 8, "budget_admission"],
  [["lost", "own_abort_after_send", "lost"], 12, "lookup_repeated_loss"],
  [["own_abort_after_send", "own_abort_after_send", "own_abort_after_send"], 12, "budget_admission"],
  [["lost", "settled", "lost"], 8, "budget_admission"],
])("keeps the loss rule across actual child slots %j", async (scenarios, cap, stop) => {
  const { result } = await run(scenarios, undefined, cap); expect(result.failed).toBeUndefined(); expect(result.result.stop).toBe(stop);
  expect(result.result.counts.admitted).toBe(scenarios.length); expect(result.result.counts.invalid).toBe(0);
});

it("refuses debug presence in a real controller process without touching the output", async () => {
  const options = await runOptions(suite.fixture), p = await suite.spawn({ options }, { CONTINUITY_DEBUG: "" });
  expect(await p.reply).toEqual({ failed: "lookup_debug_forbidden" }); await p.exit; expect(await fs.readdir(options.outputRoot)).toEqual([]);
});

it.each(["ack-tamper-revision", "ack-tamper-permit"])("child refuses %s against its durable ACK", async action => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_ipc_disconnected");
  expect(reply.result.counts.admitted).toBeLessThanOrEqual(1);
  expect(reply.result.receipts[0].calls.consumed).toBe(0); await suite.witnesses();
});
it.each(["ppid", "parent-start", "null-parent-start"])("child refuses swapped parent identity %s", async kind => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `swap-${kind}.json`);
  await fs.writeFile(config, JSON.stringify({ action: `swap-${kind}` }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_ipc_disconnected");
  expect(reply.result.counts.admitted).toBe(0); expect(reply.result.receipts[0].calls.consumed).toBe(0); await suite.witnesses();
});
it.each(["lost", "two_rounds"])("derives cap-refused %s receipts without adding provider losses", async scenario => {
  const { result, options } = await run([scenario], undefined, 3.92), zeroHolds = scenario === "lost";
  expect(result.failed).toBeUndefined(); expect(result.result.stop).toBe("budget_admission");
  expect(result.result.receipts.at(-1)).toMatchObject({ terminal: zeroHolds ? "unadmitted" : "refused_pre_send", terminalCode: "budget_admission" });
  expect(result.result.counts).toMatchObject({ admitted: 1, unadmitted: zeroHolds ? 1 : 0, incomplete: 1, invalid: 0, completed: 0 });
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  const { accountLookupPilot } = await loadPilot(suite.fixture, "pilot-accounting"); expect(accountLookupPilot(state.slots).consecutiveProviderLosses).toBe(zeroHolds ? 1 : 0);
});
it("persists unreconciled containment before surfacing termination failure", async () => {
  const f = suite.fixture, options = await runOptions(f, ["settled"]), config = join(f.base, "terminate-fail.json");
  await fs.writeFile(config, JSON.stringify({ action: "terminate-fail" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); expect(await p.reply).toEqual({ failed: "lookup_unreconciled_processes" }); await p.exit;
  expect(JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))).stop).toBe("lookup_unreconciled_processes");
});
it("settles after IPC stop then contains a stalled group within the settle grace, not the watchdog", async () => {
  const f = suite.fixture, options = await runOptions(f, ["auth"], 10000), config = join(f.base, "stop-hang.json");
  await fs.writeFile(config, JSON.stringify({ action: "stop-hang" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_auth_failure");
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))), pid = state.slots[0].worker.pid;
  expect(state.slots[0].holds[0].settlement).toMatchObject({ kind: "lost" });
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${pid}.json`)));
  expect(witness.terminatedAt - witness.stopSentAt).toBeGreaterThanOrEqual(200);
  expect(witness.terminatedAt - witness.stopSentAt).toBeLessThan(3000);
});
it("refuses a null controller start identity before acquiring a lease", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "null-controller-start.json");
  await fs.writeFile(config, JSON.stringify({ action: "null-controller-start" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); expect(await p.reply).toEqual({ failed: "lookup_ipc_invalid" }); await p.exit;
  expect(await fs.readdir(options.outputRoot)).toEqual([]);
});
it("isolates controller and child HOME and inherited Git configuration", async () => {
  const f = suite.fixture, marker = join(f.base, "fsmonitor-called"), hook = join(f.base, "fictional-fsmonitor"), config = join(f.base, "fictional-gitconfig");
  await fs.writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o700 });
  await fs.writeFile(config, `[core]\nfsmonitor = ${hook}\n`);
  vi.stubEnv("GIT_DIR", "/fictional/not-a-repository"); vi.stubEnv("GIT_CONFIG_GLOBAL", config); vi.stubEnv("HOME", join(f.base, "unused-home"));
  try {
    const { result } = await run(["lost"]); expect(result.failed).toBeUndefined();
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" }); await suite.witnesses();
  } finally { vi.unstubAllEnvs(); }
});

it("refuses a live foreign parent PID even when its intercepted start identity matches", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "foreign-parent.json");
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  await fs.writeFile(config, JSON.stringify({ action: "swap-foreign-ppid", foreignPid: process.pid }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.result.stop).toBe("lookup_ipc_disconnected"); expect(reply.result.counts.admitted).toBe(0);
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${state.slots[0].worker.pid}.json`)));
  expect(witness.foreignIdentityProvided).toBe(true);
});
it("drains a settlement delivered immediately before grace expiry before containing the real child", async () => {
  const f = suite.fixture, options = await runOptions(f, ["auth"], 10000), config = join(f.base, "settle-at-grace.json");
  await fs.writeFile(config, JSON.stringify({ action: "settle-at-grace" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_auth_failure"); expect(reply.result.counts.invalid).toBe(0);
  expect(reply.result.counts.incomplete).toBe(1); expect(reply.result.cost.knownPartialUSD).toBe(.0003);
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].holds[0].settlement).toMatchObject({ kind: "lost", knownUnits: "6000" });
  expect(JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`)))).toMatchObject({ settleDeliveredBeforeGrace: true, settleCheckPending: true });
});
it.each(["unadmitted", "refused_pre_send"])("refuses a real child's forged %s terminal", async terminal => {
  const f = suite.fixture, options = await runOptions(f, ["settled"]), config = join(f.base, `forge-${terminal}.json`);
  await fs.writeFile(config, JSON.stringify({ action: "forge-terminal", terminal }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); expect(await p.reply).toEqual({ failed: "lookup_ipc_invalid" }); await p.exit;
  expect(JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))).stop).toBe("lookup_ipc_invalid");
});
it("classifies an empty-output refusal in a later round as invalid, not an admission refusal", async () => {
  const { result } = await run(["empty_two_rounds"]);
  expect(result.failed).toBeUndefined(); expect(result.result.counts).toMatchObject({ admitted: 1, invalid: 1, incomplete: 0 });
  expect(result.result.receipts[0].terminal).toBe("pilot_empty_final_output");
});
it("isolates production checkout and build-source Git reads without the fixture spawn filter", async () => {
  const f = suite.fixture, marker = join(f.base, "production-fsmonitor-called"), hook = join(f.base, "production-fsmonitor"), config = join(f.base, "production-gitconfig"), dirt = join(f.repo, "fictional-source-dirt");
  await fs.writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o700 }); await fs.writeFile(config, `[core]\nfsmonitor = ${hook}\n`);
  for (const root of [f.repo, f.pack]) fixtureGit(root, ["config", "core.fsmonitor", hook]);
  vi.stubEnv("HOME", f.home); for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) vi.stubEnv(key, f.home);
  vi.stubEnv("GIT_DIR", "/fictional/not-a-repository"); vi.stubEnv("GIT_INDEX_FILE", join(f.base, "nonexistent-index")); vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  try {
    // Direct production functions in this process: no pilotSuite.spawn environment filter runs here.
    const roles = await loadPilot(f, "roles"), { codes } = await roles.prepareLookupCodes(f.pilot.registration.codes);
    expect(codes.R0.revision).toBe(f.pilot.registration.codes.R0.revision);
    expect(sourceState(f.repo)).toEqual({ head: codes.R0.revision, dirty: false });
    await fs.writeFile(dirt, "Fictional untracked source."); expect(sourceState(f.repo).dirty).toBe(true);
    expect(() => assertSource(f.repo, codes.R0.revision)).toThrow("build_source_changed_or_dirty");
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.unstubAllEnvs(); await fs.rm(dirt, { force: true }); for (const root of [f.repo, f.pack]) fixtureGit(root, ["config", "--unset", "core.fsmonitor"]); }
});

it.each(["timeout-before-consume", "timeout-after-consume"])("classifies %s from durable consumption rather than timeout alone", async action => {
  const f = suite.fixture, options = await runOptions(f, ["settled"], 3000), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_worker_timeout");
  const consumed = action === "timeout-after-consume";
  expect(reply.result.receipts[0]).toMatchObject({ terminal: consumed ? "own_abort_after_send" : "lost", calls: { admitted: 1, consumed: consumed ? 1 : 0 }, costs: { retainedUSD: 3.92 } });
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(JSON.parse(await fs.readFile(join(f.base, "witnesses", `${state.slots[0].worker.pid}.json`))).timeoutBoundary).toBe(action);
});
it.each(["arrival-persist", "arrival-receipt"])("makes %s a sticky integrity stop after consumed arrival", async action => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe(action === "arrival-persist" ? "lookup_persist_failed" : "lookup_receipt_invalid");
  expect(reply.result.counts).toMatchObject({ admitted: 1, invalid: 1 }); expect(reply.result.receipts[0]).toMatchObject({ terminal: "integrity_stop", calls: { consumed: 1 }, costs: { retainedUSD: 3.92 } });
});
it.each(["identity-before-term", "identity-before-kill", "identity-before-gone"])("never signals an unproven child group at %s", async action => {
  const f = suite.fixture, options = await runOptions(f, ["auth"], 10000), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config });
  expect(await p.reply).toEqual({ failed: "lookup_unreconciled_processes" }); await p.exit;
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.stop).toBe("lookup_unreconciled_processes"); expect(state.slots[0].unreconciled).toBe(true);
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`)));
  expect(witness.identityRefused).toBe(true); expect(witness.signals ?? []).toEqual(action === "identity-before-term" ? [] : ["SIGTERM"]);
});
it("requires current-process witnesses even when older valid witnesses exist", async () => {
  const older = await suite.spawn({ mode: "idle" }); await older.reply;
  const p = await suite.spawn({ mode: "idle" }); await p.reply;
  const path = join(suite.fixture.base, "witnesses", `${p.child.pid}.json`), bytes = await fs.readFile(path);
  try { await fs.unlink(path); await expect(suite.witnesses()).rejects.toMatchObject({ code: "ENOENT" }); }
  finally { await fs.writeFile(path, bytes, { mode: 0o600 }); }
});

it("invalidates an idle IPC permit source synchronously on close", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "close-idle.json");
  await fs.writeFile(config, JSON.stringify({ action: "close-idle" }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config });
  const reply = await p.reply; await p.exit; expect(reply.failed).toBeUndefined();
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].holds).toHaveLength(1); expect(state.slots[0].nextMessage).toBe(1);
  expect(JSON.parse(await fs.readFile(join(f.base, "witnesses", `${state.slots[0].worker.pid}.json`))).closeCodes).toEqual(Array(4).fill("lookup_ipc_invalid"));
});

it.each(["identity-before-exit", "identity-before-signal-exit"])("reconciles an absent group after %s without further signaling", async action => {
  const f = suite.fixture, options = await runOptions(f, ["auth"], 10000), config = join(f.base, "identity-exit.json");
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_auth_failure");
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`)));
  expect(action === "identity-before-exit" ? witness.leaderExitedAtCheck : witness.signalRacedExit).toBe(true); expect(witness.signals ?? []).toEqual(action === "identity-before-exit" ? [] : ["SIGTERM"]);
});

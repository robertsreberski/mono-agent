import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { pilotSuite, loadPilot, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { fixtureGit } from "./fixtures/holdout-synthetic.mjs";
import { sourceState, assertSource } from "../lib/memory-e2e-build.mjs";
import { groupAlive } from "../lib/continuity-holdout-controller.mjs";
import { lookupProcessGroupSnapshot } from "../lib/continuity-process-identity.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
const suite = pilotSuite({scoped: true});
const it = suite.test;
async function run(scenarios, timeoutMs, capUSD, extraEnv = {}) {
  const options = await runOptions(suite.fixture, scenarios, timeoutMs);
  if (capUSD !== undefined) { options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot); }
  const p = await suite.spawn({ options }, extraEnv);
  const result = await p.reply; await p.exit; await suite.witnesses(); return { options, result };
}
// Sequential cases: parallelism is supplied by Vitest files, never by a queue.

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

it.each(["cache", "plan", "build", "role", "pid", "epoch", "marker", "debug", "descriptor", "role-id", "registration", "role-build"])("refuses a real child's swapped %s before ready and before admission", async kind => {
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

it.each(["unadmitted", "refused_pre_send"])("refuses a real child's forged %s terminal", async terminal => {
  const f = suite.fixture, options = await runOptions(f, ["settled"]), config = join(f.base, `forge-${terminal}.json`);
  await fs.writeFile(config, JSON.stringify({ action: "forge-terminal", terminal }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); expect(await p.reply).toEqual({ failed: "lookup_ipc_invalid" }); await p.exit;
  expect(JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))).stop).toBe("lookup_ipc_invalid");
});

it("isolates production checkout and build-source Git reads without the fixture spawn filter", async () => {
  const f = suite.fixture, marker = join(f.base, "production-fsmonitor-called"), hook = join(f.base, "production-fsmonitor"), config = join(f.base, "production-gitconfig"), dirt = join(f.repo, "fictional-source-dirt");
  await fs.writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o700 }); await fs.writeFile(config, `[core]\nfsmonitor = ${hook}\n`);
  for (const root of [f.repo, f.pack]) fixtureGit(root, ["config", "core.fsmonitor", hook]);
  vi.stubEnv("HOME", f.home); for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) vi.stubEnv(key, f.home);
  vi.stubEnv("GIT_DIR", "/fictional/not-a-repository"); vi.stubEnv("GIT_INDEX_FILE", join(f.base, "nonexistent-index")); vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  try {
    // Direct production functions in this process: no pilotSuite.spawn environment filter runs here.
    const roles = await loadPilot(f, "roles"), { codes } = await roles.prepareLookupCodes(f.pilot.registration.codes).catch(error => { console.error("fixture build stderr:", String(error.stderr ?? ""), "stdout:", String(error.stdout ?? "")); throw error; });
    expect(codes.R0.revision).toBe(f.pilot.registration.codes.R0.revision);
    expect(sourceState(f.repo)).toEqual({ head: codes.R0.revision, dirty: false });
    await fs.writeFile(dirt, "Fictional untracked source."); expect(sourceState(f.repo).dirty).toBe(true);
    expect(() => assertSource(f.repo, codes.R0.revision)).toThrow("build_source_changed_or_dirty");
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.unstubAllEnvs(); await fs.rm(dirt, { force: true }); for (const root of [f.repo, f.pack]) fixtureGit(root, ["config", "--unset", "core.fsmonitor"]); }
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

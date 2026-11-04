import { it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { pilotSuite, loadPilot, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
const suite = pilotSuite();
async function run(scenarios, timeoutMs, capUSD) {
  const options = await runOptions(suite.fixture, scenarios, timeoutMs);
  if (capUSD !== undefined) { options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot); }
  const p = await suite.spawn({ options });
  const result = await p.reply; await p.exit; await suite.witnesses(); return { options, result };
}
it("runs the real forked probe and guard over IPC with persisted arrival witnesses and inherited CI", async () => {
  const { options, result } = await run(["two_rounds", "lost"], undefined, 3.93);
  expect(result.failed).toBeUndefined(); expect(result.result.executionKind).toBe("faux-only");
  expect(result.result.receipts[0].calls).toEqual({ admitted: 2, consumed: 2, settled: 2 });
  expect(result.result.counts.incomplete).toBe(1); expect(result.result.stop).toBe("budget_admission");
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].worker.pid).not.toBe(state.controller.pid);
  expect(new Set(state.slots.filter(s => s.worker).map(s => s.worker.pid)).size).toBe(state.slots.filter(s => s.worker).length);
  expect(state.schedule.every(s => !Object.hasOwn(s, "cacheKey"))).toBe(true);
});
it.each(["disconnect", "die", "hang", "descendant"])("contains a real %s worker without admitting a replacement", async scenario => {
  const { result } = await run([scenario], scenario === "hang" ? 1000 : 5000);
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
  expect(report.cost.totalUSD).toBe(3.92); expect(report.reconciliation).toBe(true); await suite.witnesses();
});

it.each(["plan", "build", "role", "pid", "epoch", "marker", "debug"])("refuses a real child's swapped %s before ready and before admission", async kind => {
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

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
async function run(scenarios, timeoutMs, capUSD, extraEnv = {}, spawnOptions = {}) {
  const options = await runOptions(suite.fixture, scenarios, timeoutMs);
  if (capUSD !== undefined) { options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot); }
  const p = await suite.spawn({ options }, extraEnv, spawnOptions);
  const result = await p.reply; await p.exit; await suite.witnesses(); return { options, result };
}
// Sequential cases: parallelism is supplied by Vitest files, never by a queue.

it("runs the real forked probe and guard over IPC with persisted arrival witnesses and inherited CI", async () => {
  // This positive native-process path includes cold Node imports; do not use
  // the short timeout fixtures' 5s child bound under shared-runner contention.
  const { options, result } = await run(["two_rounds", "lost"], 30000, 3.93, { CI: "1" }, { replyTimeoutMs: 90000 });
  expect(result.failed).toBeUndefined(); expect(result.result.executionKind).toBe("faux-only");
  expect(result.result.receipts[0].calls).toEqual({ admitted: 2, consumed: 2, settled: 2 });
  expect(result.result.counts.incomplete).toBe(1); expect(result.result.stop).toBe("budget_admission");
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].worker.pid).not.toBe(state.controller.pid);
  for (const pid of [state.controller.pid, state.slots[0].worker.pid]) expect(JSON.parse(await fs.readFile(join(suite.fixture.base, "witnesses", `${pid}.json`))).ci).toBe("1");
  expect(new Set(state.slots.filter(s => s.worker).map(s => s.worker.pid)).size).toBe(state.slots.filter(s => s.worker).length);
  expect(state.schedule.every(s => !Object.hasOwn(s, "cacheKey"))).toBe(true);
}, 120000);

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

it.each(["lost", "two_rounds"])("derives cap-refused %s receipts without adding provider losses", async scenario => {
  const { result, options } = await run([scenario], undefined, 3.92), zeroHolds = scenario === "lost";
  expect(result.failed).toBeUndefined(); expect(result.result.stop).toBe("budget_admission");
  expect(result.result.receipts.at(-1)).toMatchObject({ terminal: zeroHolds ? "unadmitted" : "refused_pre_send", terminalCode: "budget_admission" });
  expect(result.result.counts).toMatchObject({ admitted: 1, unadmitted: zeroHolds ? 1 : 0, incomplete: 1, invalid: 0, completed: 0 });
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  const { accountLookupPilot } = await loadPilot(suite.fixture, "pilot-accounting"); expect(accountLookupPilot(state.slots).consecutiveProviderLosses).toBe(zeroHolds ? 1 : 0);
});

it("classifies an empty-output refusal in a later round as invalid, not an admission refusal", async () => {
  const { result } = await run(["empty_two_rounds"]);
  expect(result.failed).toBeUndefined(); expect(result.result.counts).toMatchObject({ admitted: 1, invalid: 1, incomplete: 0 });
  expect(result.result.receipts[0].terminal).toBe("pilot_empty_final_output");
});

it.each(["arrival-persist", "arrival-receipt"])("makes %s a sticky integrity stop after consumed arrival", async action => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe(action === "arrival-persist" ? "lookup_arrival_persist_failed" : "lookup_arrival_receipt_invalid");
  expect(reply.result.counts).toMatchObject({ admitted: 1, invalid: 1 }); expect(reply.result.receipts[0]).toMatchObject({ terminal: "integrity_stop", calls: { consumed: 1 }, costs: { retainedUSD: 3.92 } });
});

it("accepts a real guard pre-send refusal and continues to a final report", async () => {
  const { result, options } = await run(["input_refusal", "lost"]);
  expect(result.failed).toBeUndefined(); expect(result.result.receipts[0]).toMatchObject({ terminal: "unadmitted", terminalCode: "not_admitted_input_envelope" });
  expect(result.result.counts.admitted).toBe(1); expect(result.result.receipts.length).toBeGreaterThan(1);
  expect(JSON.parse(await fs.readFile(join(options.outputRoot, "report.json"))).stop).toBe("budget_admission");
});

it("persists unique bounded ASCII cache keys for every slot", async () => {
  const { options } = await run(["lost"]), state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.cacheKeysUnique).toBe(true); const keys = state.slots.map(s => s.cacheKey); expect(new Set(keys).size).toBe(keys.length);
  expect(keys.every(key => /^[\x21-\x7e]{1,64}$/.test(key))).toBe(true);
});

it("accepts a fixed guard refusal after settled holds without stopping the next slot", async () => {
  const { result, options } = await run(["request_limit", "lost"], undefined, 3.93);
  expect(result.failed).toBeUndefined(); expect(result.result.receipts[0]).toMatchObject({ terminal: "refused_pre_send", terminalCode: "lookup_request_limit", calls: { admitted: 10, consumed: 10, settled: 10 } });
  expect(result.result.counts.invalid).toBe(0); expect(result.result.counts.admitted).toBe(2);
  expect(JSON.parse(await fs.readFile(join(options.outputRoot, "report.json"))).stop).toBe("budget_admission");
});

it.each([["guard-model-switch", "lookup_model_switch_forbidden"], ["guard-cache-key", "lookup_prompt_cache_key_forbidden"], ["guard-after-hold", "lookup_model_switch_forbidden"]])("makes real-child %s policy refusal a sticky stop", async (action, code) => {
  const f = suite.fixture, options = await runOptions(f, [action === "guard-after-hold" ? "two_rounds" : "settled", "lost"]), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe(code); expect(reply.result.schedule.visited).toBe(1);
  const receipt = reply.result.receipts[0]; expect(receipt.terminalCode).toBe(code);
  expect(receipt.terminal).toBe(action === "guard-after-hold" ? "integrity_stop" : "unadmitted");
  expect(receipt.calls.consumed).toBe(action === "guard-after-hold" ? 1 : 0);
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${state.slots[0].worker.pid}.json`))); expect(witness.guardFaultInjected).toBe(true);
  expect(state.slots.filter(slot => slot.worker)).toHaveLength(1);
});

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

it.each(["disconnect", "die", "hang", "descendant"])("contains a real %s worker without admitting a replacement", async scenario => {
  const { result, options } = await run([scenario], scenario === "hang" ? 1000 : 5000);
  expect(result.failed).toBeUndefined(); expect(result.result.stop).not.toBe("completed");
  expect(result.result.schedule.visited).toBe(1); expect(result.result.counts.invalid).toBe(0);
  if (scenario === "descendant") {
    const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))), slot = state.slots[0];
    expect(slot.members.length).toBeGreaterThan(0); expect(slot.members.every(m => m.pgid === slot.worker.pid && m.startIdentity)).toBe(true);
    const child = JSON.parse(await fs.readFile(join(suite.fixture.base, "witnesses", `${slot.worker.pid}.json`))); expect(child.descendantNoDelay).toBe(true);
    const driver = JSON.parse(await fs.readFile(join(suite.fixture.base, "witnesses", `${state.controller.pid}.json`)));
    expect(driver.signals).toContain("SIGTERM"); expect(driver.stopAtSignals).toEqual(driver.signals.map(() => "lookup_worker_lost")); expect(groupAlive(slot.worker.pid)).toBe(false);
  }
});

it("reconciles a controller SIGKILL at one faux arrival without ever readmitting or signaling recovery groups", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, "arrival-kill.json");
  await fs.writeFile(config, JSON.stringify({ action: "arrival" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"}); expect((await p.exit).signal).toBe("SIGKILL");
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots[0].holds[0].consumed).toBe(true); expect(state.slots[0].holds[0].settlement).toBeNull();
  const { reconcileLookupPilot } = await loadPilot(f, "controller");
  const report = await reconcileLookupPilot(options.outputRoot);
  expect(report.cost.totalUSD).toBe(3.92); expect(report.counts).toMatchObject({ admitted: 1, incomplete: 1 }); expect(report.schedule.visited).toBe(1); expect(report.reconciliation).toBe(true); await suite.witnesses();
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

it.each(["timeout-before-consume", "timeout-after-consume"])("classifies %s from durable consumption rather than timeout alone", async action => {
  const f = suite.fixture, options = await runOptions(f, ["settled"], 3000), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_worker_timeout");
  const consumed = action === "timeout-after-consume";
  expect(reply.result.receipts[0]).toMatchObject({ terminal: consumed ? "own_abort_after_send" : "lost", calls: { admitted: 1, consumed: consumed ? 1 : 0 }, costs: { retainedUSD: 3.92 } });
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(JSON.parse(await fs.readFile(join(f.base, "witnesses", `${state.slots[0].worker.pid}.json`))).timeoutBoundary).toBe(action);
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

it.each(["identity-before-exit", "identity-before-signal-exit"])("reconciles an absent group after %s without further signaling", async action => {
  const f = suite.fixture, options = await runOptions(f, ["auth"], 10000), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 }); const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe("lookup_auth_failure");
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`)));
  expect(action === "identity-before-exit" ? witness.leaderExitedAtCheck : witness.signalRacedExit).toBe(true); expect(witness.signals ?? []).toEqual(action === "identity-before-exit" ? [] : ["SIGTERM"]);
});

it("leaves a descendant group unsignalled when recorded membership cannot be re-proven", async () => {
  const f = suite.fixture, options = await runOptions(f, ["descendant"]), config = join(f.base, "descendant-unproven.json");
  await fs.writeFile(config, JSON.stringify({ action: "descendant-unproven" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); expect(await p.reply).toEqual({ failed: "lookup_unreconciled_processes" }); await p.exit;
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))); expect(state.slots[0].members.length).toBeGreaterThan(0);
  const witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`))); expect(witness.descendantUnproven).toBe(true); expect(witness.signals ?? []).toEqual([]);
  expect(lookupProcessGroupSnapshot(state.slots[0].worker.pid).some(now => !now.zombie && state.slots[0].members.some(old => old.pid === now.pid && old.startIdentity === now.startIdentity))).toBe(true);
});

it.each(["descendant-timeout", "descendant-disconnect", "descendant-timeout-unproven"])("persists proven descendants before terminating a worker without done: %s", async action => {
  const f = suite.fixture, options = await runOptions(f, ["settled", "lost"], 4000), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))), slot = state.slots[0];
  const child = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${slot.worker.pid}.json`))), driver = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`)));
  expect(child.descendantWithoutDone).toBe(true); expect(slot.members).toHaveLength(1); expect(slot.members[0]).toMatchObject({ pid: child.descendants[0].pid, startIdentity: child.descendants[0].startIdentity.replace(/\s+/gu, " "), pgid: slot.worker.pid });
  expect(driver.membersAtSignals[0]).toEqual(slot.members); expect(state.slots.filter(s => s.worker)).toHaveLength(1); expect(slot.holds).toHaveLength(0);
  const stop = action === "descendant-disconnect" ? "lookup_ipc_disconnected" : "lookup_worker_timeout";
  if (action.endsWith("unproven")) {
    expect(reply).toEqual({ failed: "lookup_unreconciled_processes" }); expect(state.stop).toBe("lookup_unreconciled_processes");
    expect(driver.signals).toEqual(["SIGTERM"]); expect(driver.stopAtSignals).toEqual([stop]); expect(driver.descendantUnproven).toBe(true);
    expect(lookupProcessGroupSnapshot(slot.worker.pid).some(m => !m.zombie && m.pid === slot.members[0].pid)).toBe(true);
  } else {
    expect(reply.failed).toBeUndefined(); expect(reply.result.stop).toBe(stop); expect(reply.result.schedule.visited).toBe(1);
    expect(driver.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(driver.stopAtSignals).toEqual([stop, stop]); expect(driver.leaderExitedBeforeKill).toBe(true); expect(groupAlive(slot.worker.pid)).toBe(false);
  }
});

it.each(["persist-descendant-timeout", "persist-descendant-done", "persist-descendant-unproven", "sticky-descendant-timeout"])("contains or rejects promptly when member persistence fails: %s", async action => {
  const f = suite.fixture, options = await runOptions(f, [action.endsWith("done") ? "descendant" : "settled", "lost"], 4000), config = join(f.base, `${action}.json`);
  await fs.writeFile(config, JSON.stringify({ action }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }), reply = await p.reply; await p.exit;
  expect(reply).toEqual({ failed: action.endsWith("unproven") ? "lookup_unreconciled_processes" : "lookup_persist_failed" });
  const state = JSON.parse(await fs.readFile(join(options.outputRoot, "lookup-pilot-controller.json"))), slot = state.slots[0];
  const driver = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${p.child.pid}.json`)));
  expect(driver.memberPersistFailed).toBe(true); expect(slot.members ?? []).toEqual([]); expect(state.slots.filter(s => s.worker)).toHaveLength(1);
  expect(driver.signals).toContain("SIGTERM");
  if (action.endsWith("unproven")) { expect(driver.signals).toEqual(["SIGTERM"]); expect(driver.descendantUnproven).toBe(true); }
  else { expect(groupAlive(slot.worker.pid)).toBe(false); if (action === "sticky-descendant-timeout") expect(driver.signals).toEqual(["SIGTERM", "SIGKILL"]); }
  const db = new DatabaseSync(join(options.outputRoot, "controller-lock.sqlite"));
  try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK"); } finally { db.close(); }
});

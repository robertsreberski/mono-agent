import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openMonitorsService } from "../packages/agent-app/dist/monitors-service.js";
import { parseMonitorsSettings } from "../packages/agent-app/dist/monitors-config.js";
import { readMonitorStore } from "../packages/agent-app/dist/monitors-store.js";
import { monitorToolRun } from "../packages/agent-runtime/src/agent/tools/monitor.js";

// Real built host + shipped tool/process runner + real subprocesses. Only the
// provider-facing wake sink is a fixture: this proves pre-inference transport,
// not paid-model response behavior or an adopted consumer runtime.
const stateDir = await mkdtemp(join(tmpdir(), "mono-monitor-efficiency-smoke-"));
// The production host owns server handles; a standalone smoke needs its own
// referenced handle while the service's intentionally unref'ed retry timers run.
const keepAlive = setInterval(() => {}, 1000);
const wakes = [];
const wakeTimes = new Map();
let service;
const origin = {
  conversationId: "telegram:42", baseConversationId: "telegram:42", bucket: null,
  replyToConversationId: "telegram:42", normalizedReplyTarget: "telegram:42",
  runId: "smoke", historyBoundary: "smoke", channel: "telegram",
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function waitFor(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for " + label);
}
async function run(wakePolicy, exitCode) {
  const program = [
    "let count = 0;",
    "const emit = () => {",
    "process.stdout.write((count % 2 ? '\\x1b[2K\\x1b[32m' : '\\x1b]0;status\\x07\\x1b[31m') + 'ready\\x1b[0m\\n');",
    "if (++count === 5) { clearInterval(timer); setTimeout(() => { process.stderr.write('finished'); process.exit(" + exitCode + "); }, 200); }",
    "}; const timer = setInterval(emit, 200); emit();",
  ].join("\n");
  const result = await monitorToolRun({
    command: quote(process.execPath) + " -e " + quote(program),
    description: "Disposable redraw transport smoke", timeout_ms: 10_000, ...wakePolicy,
  }, { ctx: { workspace: stateDir }, monitorsController: service.controller(origin, 0) });
  assert.equal(result.error, false, result.text);
  const id = result.outcome.monitor_id;
  await waitFor(async () => {
    const projection = await service.get(id);
    return projection?.state === "exited"
      && wakes.some((wake) => wake.projection.monitorId === id && wake.projection.state === "exited")
      && projection.counters.linesDelivered + projection.counters.linesSuppressed
        + projection.counters.droppedLines === projection.counters.linesObserved
      && projection.counters.batchesDelivered === wakes.filter((wake) => wake.projection.monitorId === id).length;
  }, "terminal settlement");
  const projection = await service.get(id);
  const emitted = wakes.filter((wake) => wake.projection.monitorId === id);
  assert.equal(emitted.filter((wake) => wake.projection.state === "exited").length, 1);
  assert.equal(projection.exitCode, exitCode);
  assert.equal(projection.counters.linesObserved, 5);
  assert.equal(projection.counters.droppedLines, 0);
  if (wakePolicy.wake_on === "exit") {
    assert.equal(emitted.length, 1);
    assert.equal(projection.counters.linesDelivered, 5);
  } else {
    assert.equal(emitted.length, 2);
    assert.equal(projection.counters.linesSuppressed, 4);
    assert.equal(projection.counters.batchesSuppressed, 4);
  }
  assert.equal(projection.counters.followUpWakes, emitted.length);
  const disk = await readMonitorStore(stateDir);
  assert.equal(disk.corrupt, false, disk.reason);
  await waitFor(async () => (await readMonitorStore(stateDir)).snapshot.records
    .find((record) => record.monitorId === id)?.linesSuppressed === projection.counters.linesSuppressed,
  "durable suppression accounting");
  return { policy: wakePolicy, wakeSinkCalls: emitted.length, counters: projection.counters, exitCode };
}
async function runInterval() {
  const started = Date.now();
  const result = await monitorToolRun({
    command: quote(process.execPath) + " -e " + quote(
      "console.log('first'); setTimeout(() => console.log('second'), 200); "
      + "setTimeout(() => console.log('third'), 400); setTimeout(() => process.exit(0), 1700);"),
    description: "Disposable interval transport smoke", timeout_ms: 10_000, min_wake_interval_ms: 1000,
  }, { ctx: { workspace: stateDir }, monitorsController: service.controller(origin, 0) });
  assert.equal(result.error, false, result.text);
  const id = result.outcome.monitor_id;
  await waitFor(() => wakes.some((wake) => wake.projection.monitorId === id && wake.projection.state === "exited"),
    "interval terminal wake");
  const emitted = wakes.filter((wake) => wake.projection.monitorId === id);
  assert.equal(emitted.length, 3);
  const times = emitted.map((wake) => wakeTimes.get(wake.deliveryKey));
  assert.ok(times[0] - started < 1000, "first batch was delayed by the interval");
  assert.ok(times[1] - times[0] >= 1000, "nonterminal wake violated the interval floor");
  assert.ok(times[2] - times[1] < 1000, "terminal did not bypass the interval floor");
  const events = emitted.map((wake) => JSON.parse(wake.prompt.split("<untrusted_monitor_events>")[1]
    .split("</untrusted_monitor_events>")[0]).events);
  assert.deepEqual(events, [["first"], ["second", "third"], []]);
  return { wakeSinkCalls: emitted.length, firstWakeMs: times[0] - started,
    nonterminalGapMs: times[1] - times[0], terminalGapMs: times[2] - times[1] };
}
try {
  service = await openMonitorsService({
    stateDir, settings: parseMonitorsSettings({ monitors: { enabled: true, coalesceMs: 30 } }),
    wake: async (wake) => {
      wakes.push(wake); wakeTimes.set(wake.deliveryKey, Date.now());
      return { delivered: true, disposition: "follow_up" };
    },
  });
  await service.activateWakes();
  const redraw = await run({ dedupe: "batch" }, 0);
  const exitOnly = await run({ wake_on: "exit" }, 7);
  const interval = await runInterval();
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  console.log(JSON.stringify({
    proof: "built-host-real-subprocess-fixture-wake-sink",
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    worktreeDirty: execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim().length > 0,
    paidModelCalls: 0, redraw, exitOnly, interval,
  }));
} finally {
  try {
    await service?.stop();
    await rm(stateDir, { recursive: true, force: true });
  } finally {
    clearInterval(keepAlive);
  }
}

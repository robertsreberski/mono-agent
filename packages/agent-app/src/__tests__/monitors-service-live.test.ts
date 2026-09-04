import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotifyDeliveryResult } from "@mono-agent/agent-contracts";

import { MONITORS_DEFAULTS, type MonitorsSettings } from "../monitors-config.js";
import { openMonitorsService, type MonitorWakeInput, type MonitorsServiceHandle } from "../monitors-service.js";
import type { ProcessJobOriginRecord } from "../process-jobs-store.js";

// These tests drive the REAL kernel launch path: the same `handOffMonitor` the
// Monitor tool uses, spawning an actual gated process group.
//
// They exist because the fake-handle suite cannot see contract drift between
// what `startPreparedProcess` resolves with and what the service reads from it.
// A hand-written result fake made a monitor whose command exited with no stderr
// look healthy while the real one threw on `undefined.length`, left the record
// `running` forever, and never sent its terminal wake.
const { monitorToolRun } = await import("@mono-agent/agent-runtime/agent/tools/index.js");

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function settings(overrides: Partial<MonitorsSettings> = {}): MonitorsSettings {
  return {
    configured: true,
    enabled: true,
    maxActive: MONITORS_DEFAULTS.maxActive,
    maxActivePerConversation: MONITORS_DEFAULTS.maxActivePerConversation,
    maxRuntimeMs: MONITORS_DEFAULTS.maxRuntimeMs,
    persistentMaxRuntimeMs: MONITORS_DEFAULTS.persistentMaxRuntimeMs,
    coalesceMs: 25,
    maxBatchLines: MONITORS_DEFAULTS.maxBatchLines,
    maxBatchBytes: MONITORS_DEFAULTS.maxBatchBytes,
    maxLineBytes: MONITORS_DEFAULTS.maxLineBytes,
    maxChainDepth: MONITORS_DEFAULTS.maxChainDepth,
    rateLimit: { ...MONITORS_DEFAULTS.rateLimit },
    ...overrides,
  };
}

const ORIGIN: ProcessJobOriginRecord = {
  conversationId: "telegram:42",
  baseConversationId: "telegram:42",
  bucket: null,
  replyToConversationId: "telegram:42",
  normalizedReplyTarget: "telegram:42",
  runId: "run-1",
  historyBoundary: "run-1",
  channel: "telegram",
};

describe("monitors service on the real launch path", () => {
  let stateDir: string;
  let wakes: MonitorWakeInput[];
  let service: MonitorsServiceHandle | undefined;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "mono-monitors-live-"));
    wakes = [];
    service = await openMonitorsService({
      stateDir,
      settings: settings(),
      wake: async (input) => {
        wakes.push(input);
        return { delivered: true, code: "delivered" } satisfies NotifyDeliveryResult;
      },
      operatorSecret: async () => new Uint8Array(32).fill(5),
    });
    await service.activateWakes();
  });

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** Drive the exact tool the model calls, all the way to a real process group. */
  async function startShell(command: string, params: Record<string, unknown> = {}): Promise<void> {
    const result = await monitorToolRun(
      { command, description: "Watching a real shell", ...params },
      {
        ctx: { workspace: stateDir },
        monitorsController: service!.controller(ORIGIN, 0),
      },
    );
    expect(result.error, result.text).toBe(false);
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  }

  it("streams real stdout as events and settles a clean exit with a terminal wake", async () => {
    await startShell("echo alpha; echo beta; sleep 0.2; echo gamma", { timeout_ms: 20_000 });
    await waitFor(() => wakes.some((wake) => wake.projection.state === "exited"));

    const lines = wakes.flatMap((wake) => JSON.parse(fenced(wake.prompt)).events as string[]);
    expect(lines).toEqual(["alpha", "beta", "gamma"]);

    const terminal = wakes.at(-1)!;
    const body = JSON.parse(fenced(terminal.prompt));
    expect(body.state).toBe("exited");
    expect(body.exitCode).toBe(0);
    // The bug this file exists for: a clean exit with EMPTY stderr must settle.
    expect(body.stderrTail).toBe("");
    const projection = await service!.get(terminal.projection.monitorId);
    expect(projection?.state).toBe("exited");
    expect(projection?.timestamps.completedAt).not.toBeNull();
  });

  it("reports a non-zero exit code from the real process", async () => {
    await startShell("echo out; exit 7", { timeout_ms: 20_000 });
    await waitFor(() => wakes.some((wake) => wake.projection.state === "exited"));
    const body = JSON.parse(fenced(wakes.at(-1)!.prompt));
    expect(body.exitCode).toBe(7);
  });

  it("redacts a credential the real process wrote to stderr", async () => {
    await startShell("echo 'api_key=REALSECRET0123' 1>&2; exit 1", { timeout_ms: 20_000 });
    await waitFor(() => wakes.some((wake) => wake.projection.state === "exited"));
    const terminal = wakes.at(-1)!;
    expect(terminal.prompt).not.toContain("REALSECRET0123");
    expect(JSON.parse(fenced(terminal.prompt)).stderrTail).toContain("[REDACTED]");
  });

  it("kills a real watcher at its timeout and reports timed_out", async () => {
    await startShell("echo tick; sleep 30", { timeout_ms: 1_500 });
    await waitFor(() => wakes.some((wake) => wake.projection.state === "timed_out"));
    expect(wakes.at(-1)!.projection.state).toBe("timed_out");
  });

  it("terminates a real watcher on MonitorStop and reports cancelled", async () => {
    await startShell("echo up; sleep 30", { timeout_ms: 20_000 });
    await waitFor(() => wakes.length > 0);
    const monitorId = wakes[0]!.projection.monitorId;
    const stopped = await service!.controller(ORIGIN, 0).stop(monitorId);
    expect(stopped.stopped).toBe(true);
    await waitFor(() => wakes.some((wake) => wake.projection.state === "cancelled"));
    expect((await service!.get(monitorId))?.state).toBe("cancelled");
  });

  it("survives output far larger than any buffered process job would allow", async () => {
    // A buffered run terminates once cumulative bytes cross the buffer bound.
    // A watch must be bounded by its RUNTIME, not by how much it printed.
    // Nine MiB in one physical line also proves the stream path does not turn a
    // chunk boundary into an extra event while discarding the oversized tail.
    await startShell("head -c 9437184 /dev/zero | LC_ALL=C tr '\\000' x; printf '\\n'",
      { timeout_ms: 20_000 });
    await waitFor(() => wakes.some((wake) => wake.projection.state === "exited"));
    const terminal = wakes.at(-1)!;
    expect(JSON.parse(fenced(terminal.prompt)).exitCode).toBe(0);
    const projection = await service!.get(terminal.projection.monitorId);
    expect(projection!.counters.linesObserved).toBe(1);
    expect(projection!.counters.linesDelivered + projection!.counters.droppedLines).toBe(1);
  });
});

function fenced(prompt: string): string {
  const open = prompt.indexOf("<untrusted_monitor_events>");
  const close = prompt.lastIndexOf("</untrusted_monitor_events>");
  return prompt.slice(open + "<untrusted_monitor_events>".length, close).trim();
}

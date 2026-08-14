import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedLaunchdLogWakeState,
  requestLaunchdLogMaintenanceIfNeeded,
  startManagedLaunchdLogMonitor,
} from "../background-log-maintenance.js";
import type { BackgroundLifecycleTarget } from "../background.js";
import { LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS } from "../launchd-logs.js";
import type { LaunchdLogInspection } from "../launchd-logs.js";
import type { LaunchctlRunner } from "../launchd.js";

function target(suffix = "demo-0a1b2c3d"): BackgroundLifecycleTarget {
  const label = `com.mono-agent.${suffix}`;
  return {
    label,
    paths: {
      launchAgentsDir: "/home/u/Library/LaunchAgents",
      logDir: "/home/u/.mono-agent/logs",
      plistPath: `/home/u/Library/LaunchAgents/${label}.plist`,
      stdoutPath: `/home/u/.mono-agent/logs/${label}.out.log`,
      stderrPath: `/home/u/.mono-agent/logs/${label}.err.log`,
    },
  };
}

function inspection(overrides: Partial<LaunchdLogInspection> = {}): LaunchdLogInspection {
  const stream = {
    activeBytes: 0,
    retainedBytes: 0,
    totalBytes: 0,
    byteAccountingComplete: true,
    files: [],
  };
  return {
    stdout: stream,
    stderr: stream,
    present: false,
    canMaintain: true,
    needsMaintenance: false,
    perAgentFileReasons: [],
    sharedDirectoryNeedsMaintenance: false,
    pendingTransaction: false,
    pendingMaintenance: false,
    pendingPreparation: false,
    issues: [],
    ...overrides,
  };
}

function triggerInspection(overrides: Partial<LaunchdLogInspection> = {}): LaunchdLogInspection {
  return inspection({
    present: true,
    needsMaintenance: true,
    perAgentFileReasons: ["stdout active exceeds 5242880 bytes"],
    ...overrides,
  });
}

function recordingRunner(
  calls: string[][],
  result?: (args: readonly string[]) => { code: number; stdout: string; stderr: string },
): LaunchctlRunner {
  return async (args) => {
    calls.push([...args]);
    return result?.(args) ?? {
      code: 0,
      stdout: args[0] === "print" ? "state = waiting\n" : "",
      stderr: "",
    };
  };
}

function dueState(now: () => number) {
  const state = createManagedLaunchdLogWakeState(now);
  state.cooldownDeadlineMonotonicMs = now();
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("managed launchd log monitor", () => {
  it("keeps an 11-agent idle sweep metadata-only and never calls launchctl", async () => {
    const launchctlCalls: string[][] = [];
    let inspections = 0;
    const deps = {
      inspectLaunchdLogs: async () => {
        inspections += 1;
        return inspection();
      },
      runner: recordingRunner(launchctlCalls),
      getuid: () => 501,
    };

    for (let index = 0; index < 11; index += 1) {
      await expect(requestLaunchdLogMaintenanceIfNeeded(target(`agent-${index}`), deps))
        .resolves.toBe("idle");
    }

    expect(inspections).toBe(11);
    expect(launchctlCalls).toEqual([]);
  });

  it("uses only the exact safe per-agent predicate and excludes shared or pending state", async () => {
    const calls: string[][] = [];
    const now = () => 300_000;
    const cases: LaunchdLogInspection[] = [
      inspection({ needsMaintenance: true, sharedDirectoryNeedsMaintenance: true }),
      triggerInspection({ pendingMaintenance: true }),
      triggerInspection({ pendingTransaction: true }),
      triggerInspection({ pendingPreparation: true }),
    ];
    for (const candidate of cases) {
      const state = dueState(now);
      await requestLaunchdLogMaintenanceIfNeeded(target(), {
        inspectLaunchdLogs: async () => candidate,
        runner: recordingRunner(calls),
        getuid: () => 501,
        monotonicNow: now,
      }, state);
    }
    expect(calls).toEqual([]);
  });

  it("enforces the five-minute startup floor and 5/10/20/40/60 monotonic backoff", async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const calls: string[][] = [];
    const state = createManagedLaunchdLogWakeState(now);
    const deps = {
      inspectLaunchdLogs: async () => triggerInspection(),
      runner: recordingRunner(calls),
      getuid: () => 501,
      monotonicNow: now,
    };

    expect(state.cooldownDeadlineMonotonicMs).toBe(5 * 60_000);
    nowMs = state.cooldownDeadlineMonotonicMs - 1;
    await expect(requestLaunchdLogMaintenanceIfNeeded(target(), deps, state)).resolves.toBe("cooldown");
    expect(calls).toEqual([]);

    const observedDelays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      nowMs = state.cooldownDeadlineMonotonicMs;
      await expect(requestLaunchdLogMaintenanceIfNeeded(target(), deps, state)).resolves.toBe("requested");
      observedDelays.push(state.cooldownDeadlineMonotonicMs - nowMs);
    }
    expect(observedDelays).toEqual([10, 20, 40, 60, 60].map((minutes) => minutes * 60_000));
    expect(state.wakeCount).toBe(5);
    expect(calls.filter((call) => call[0] === "kickstart")).toHaveLength(5);
  });

  it("resets cooldown on idle but preserves it for a pending artifact", async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const state = dueState(now);
    state.cooldownIndex = 3;
    state.cooldownDeadlineMonotonicMs = nowMs + 40 * 60_000;
    const runner = recordingRunner([]);

    await requestLaunchdLogMaintenanceIfNeeded(target(), {
      inspectLaunchdLogs: async () => triggerInspection({ pendingMaintenance: true }),
      runner,
      getuid: () => 501,
      monotonicNow: now,
    }, state);
    expect(state.cooldownIndex).toBe(3);
    expect(state.cooldownDeadlineMonotonicMs).toBe(nowMs + 40 * 60_000);

    nowMs += 1;
    await requestLaunchdLogMaintenanceIfNeeded(target(), {
      inspectLaunchdLogs: async () => inspection(),
      runner,
      getuid: () => 501,
      monotonicNow: now,
    }, state);
    expect(state.cooldownIndex).toBe(0);
    expect(state.cooldownDeadlineMonotonicMs).toBe(nowMs + 5 * 60_000);
  });

  it("backs off without kickstart when the helper is unloaded or already running", async () => {
    const now = () => 300_000;
    for (const [stdout, expected] of [
      ["", "helper-unloaded"],
      ["state = running\npid = 4321\n", "helper-running"],
    ] as const) {
      const calls: string[][] = [];
      const result = await requestLaunchdLogMaintenanceIfNeeded(target(), {
        inspectLaunchdLogs: async () => triggerInspection(),
        runner: recordingRunner(calls, (args) => args[0] === "print"
          ? { code: stdout.length === 0 ? 1 : 0, stdout, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }),
        getuid: () => 501,
        monotonicNow: now,
      }, dueState(now));
      expect(result).toBe(expected);
      expect(calls.map((call) => call[0])).toEqual(["print"]);
    }
  });

  it("backs off and reports a kickstart failure", async () => {
    const now = () => 300_000;
    const state = dueState(now);
    await expect(requestLaunchdLogMaintenanceIfNeeded(target(), {
      inspectLaunchdLogs: async () => triggerInspection(),
      runner: recordingRunner([], (args) => args[0] === "print"
        ? { code: 0, stdout: "state = waiting\n", stderr: "" }
        : { code: 5, stdout: "", stderr: "refused" }),
      getuid: () => 501,
      monotonicNow: now,
    }, state)).rejects.toThrow(/kickstart exited 5/u);
    expect(state.lastOutcome).toBe("request-failed");
    expect(state.cooldownDeadlineMonotonicMs).toBe(now() + 10 * 60_000);
  });

  it("reports a later unsafe inventory as inspection-failed after a kickstart failure", async () => {
    vi.useFakeTimers();
    let unsafe = false;
    const reports: string[] = [];
    const outcomes: string[] = [];
    const monitor = startManagedLaunchdLogMonitor(target(), {
      inspectLaunchdLogs: async () => unsafe
        ? triggerInspection({ canMaintain: false, issues: ["stdout: symbolic link"] })
        : triggerInspection(),
      runner: recordingRunner([], (args) => args[0] === "print"
        ? { code: 0, stdout: "state = waiting\n", stderr: "" }
        : { code: 5, stdout: "", stderr: "refused" }),
      getuid: () => 501,
      monotonicNow: Date.now,
      wallClockNow: Date.now,
      stderr: (text) => { reports.push(text); },
      recordStatus: (status) => { outcomes.push(status.lastOutcome); },
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("kickstart exited 5");
    expect(outcomes.at(-1)).toBe("request-failed");

    unsafe = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain("refused unsafe inventory");
    expect(outcomes.at(-1)).toBe("inspection-failed");
    monitor.stop();
  });

  it("fails closed on unsafe inventory before launchctl", async () => {
    const calls: string[][] = [];
    await expect(requestLaunchdLogMaintenanceIfNeeded(target(), {
      inspectLaunchdLogs: async () => triggerInspection({
        canMaintain: false,
        issues: ["stdout: symbolic link"],
      }),
      runner: recordingRunner(calls),
      getuid: () => 501,
    })).rejects.toThrow(/refused unsafe inventory.*symbolic link/u);
    expect(calls).toEqual([]);
  });

  it("rechecks the stop latch after inspection, helper lookup, and immediately before wake", async () => {
    for (const stopOnCheck of [1, 2, 3]) {
      let checks = 0;
      const calls: string[][] = [];
      const now = () => 300_000;
      await expect(requestLaunchdLogMaintenanceIfNeeded(target(), {
        inspectLaunchdLogs: async () => triggerInspection(),
        runner: recordingRunner(calls),
        getuid: () => 501,
        monotonicNow: now,
        isStopped: () => ++checks >= stopOnCheck,
      }, dueState(now))).resolves.toBe("stopped");
      expect(calls.some((call) => call[0] === "kickstart")).toBe(false);
    }
  });

  it("does not overlap inspections and guards rejected reporters/status writers", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstInspection = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let inspections = 0;
    const monitor = startManagedLaunchdLogMonitor(target(), {
      inspectLaunchdLogs: async () => {
        inspections += 1;
        if (inspections === 1) await firstInspection;
        return inspection();
      },
      runner: recordingRunner([]),
      getuid: () => 501,
      stderr: async () => await Promise.reject(new Error("reporter rejected")),
      recordStatus: async () => await Promise.reject(new Error("status rejected")),
    });

    expect(inspections).toBe(1);
    await vi.advanceTimersByTimeAsync(LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS * 2_000);
    expect(inspections).toBe(1);
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS * 1_000);
    expect(inspections).toBe(2);
    monitor.stop();
  });

  it("bounds and redacts transition reporting without changing cooldown state", async () => {
    vi.useFakeTimers();
    const reports: string[] = [];
    const monitor = startManagedLaunchdLogMonitor(target(), {
      inspectLaunchdLogs: async () => triggerInspection(),
      runner: recordingRunner([], (args) => args[0] === "print"
        ? { code: 0, stdout: "state = waiting\n", stderr: "" }
        : {
            code: 5,
            stdout: "",
            stderr: `token=top-secret /home/example/agent/${"x".repeat(700)}`,
          }),
      getuid: () => 501,
      monotonicNow: Date.now,
      wallClockNow: Date.now,
      stderr: (text) => { reports.push(text); },
      recordStatus: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toContain("top-secret");
    expect(reports[0]).not.toContain("/home/example");
    expect(reports[0]!.length).toBeLessThan(600);
    monitor.stop();
  });
});

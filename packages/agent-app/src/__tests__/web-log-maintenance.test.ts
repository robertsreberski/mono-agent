import { describe, expect, it, vi } from "vitest";

import type { LaunchdLogMaintenanceDeps } from "../background-log-maintenance.js";
import {
  buildWebMaintenancePlistXml,
  WEB_LAUNCHD_LABEL,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
  webMaintenanceCalendarMinute,
} from "../launchd.js";
import type { LaunchdLogInspection, LaunchdLogMaintenanceIntent } from "../launchd-logs.js";
import { managedWebLogMaintenanceEnvironment } from "../managed-web-maintenance-environment.js";
import { runWebLogMaintenanceCommand } from "../web-log-maintenance.js";
import type { WebLogMaintenanceStatus } from "../web-log-maintenance-status.js";

const IDENTITY = `1:2:345:${"a".repeat(64)}`;
const ENTRY = "/managed/runtime/dist/launchd-maintenance-entry.js";
const PROOF = "cHJvb2Y";

function inspection(needsMaintenance = true): LaunchdLogInspection {
  const stream = {
    activePath: "",
    files: [],
    activeBytes: 0,
    retainedBytes: 0,
    totalBytes: 0,
    byteAccountingComplete: true,
  };
  return {
    stdout: stream,
    stderr: stream,
    present: needsMaintenance,
    canMaintain: true,
    needsMaintenance,
    perAgentFileReasons: needsMaintenance ? ["stdout active exceeds maxBytes"] : [],
    sharedDirectoryNeedsMaintenance: false,
    pendingTransaction: false,
    pendingMaintenance: false,
    pendingPreparation: false,
    issues: [],
  };
}

function harness(options: {
  readonly helperContents?: string;
  readonly additionalRefusals?: readonly string[];
  readonly additionalCanMaintain?: boolean;
  readonly coreNeedsMaintenance?: boolean;
  readonly pendingIntent?: LaunchdLogMaintenanceIntent;
  readonly workerInitiallyLoaded?: boolean;
  readonly lockAvailable?: boolean;
} = {}) {
  let workerLoaded = options.workerInitiallyLoaded ?? true;
  let workerPid = 700;
  const alive = new Set([...(workerLoaded ? [700] : []), 900]);
  let intent = options.pendingIntent;
  let clock = Date.parse("2026-08-14T12:00:00.000Z");
  const calls: string[][] = [];
  const statuses: WebLogMaintenanceStatus[] = [];
  const rotate = vi.fn(async () => undefined);
  const runner = vi.fn(async (args: readonly string[]) => {
    calls.push([...args]);
    const helper = args.some((value) => value.includes(WEB_MAINTENANCE_LAUNCHD_LABEL));
    if (args[0] === "print") {
      if (helper) return { code: 0, stdout: "pid = 900\n", stderr: "" };
      return workerLoaded
        ? { code: 0, stdout: `pid = ${String(workerPid)}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "not loaded" };
    }
    if (args[0] === "bootout" && !helper) {
      workerLoaded = false;
      alive.delete(workerPid);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootstrap" && !helper) {
      workerLoaded = true;
      workerPid = 701;
      alive.add(workerPid);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
  const maintenanceDeps: LaunchdLogMaintenanceDeps = {
    runner,
    getuid: () => 501,
    now: () => { clock += 250; return clock; },
    sleep: async () => undefined,
    stderr: () => undefined,
    inspectLaunchdLogs: async () => inspection(options.coreNeedsMaintenance ?? true),
    rotateStoppedLaunchdLogs: rotate,
    readLaunchdLogMaintenanceIntent: async () => intent,
    beginLaunchdLogMaintenanceIntent: async (_paths, next) => { intent = next; },
    markLaunchdLogMaintenanceStopped: async (_paths, expected) => {
      expect(intent).toEqual(expected);
      intent = { ...expected, phase: "stopped" };
      return intent;
    },
    markLaunchdLogMaintenanceRestoring: async (_paths, expected) => {
      expect(intent).toEqual(expected);
      intent = { ...expected, phase: "restoring" };
      return intent;
    },
    clearLaunchdLogMaintenanceIntent: async (_paths, expected) => {
      expect(intent).toEqual(expected);
      intent = undefined;
    },
    verifyLaunchdPlist: async () => IDENTITY,
    isAlive: (pid) => alive.has(pid),
    inspectAdditionalLaunchdLogArtifacts: async () => ({
      needsMaintenance: (options.additionalRefusals?.length ?? 0) > 0,
      canMaintain: options.additionalCanMaintain ?? true,
      issues: options.additionalRefusals ?? [],
    }),
    maintainAdditionalLaunchdLogArtifacts: async () => ({
      refusals: options.additionalRefusals ?? [],
    }),
  };
  const expectedHelper = buildWebMaintenancePlistXml({
    label: WEB_MAINTENANCE_LAUNCHD_LABEL,
    nodePath: process.execPath,
    cliPath: ENTRY,
    cwd: "/test-home/.mono-agent/web",
    expectedManagedRuntimeLaunch: PROOF,
    expectedWebPlistIdentity: IDENTITY,
    environment: managedWebLogMaintenanceEnvironment(),
    calendarMinute: webMaintenanceCalendarMinute(),
  });
  return {
    calls,
    statuses,
    rotate,
    getIntent: () => intent,
    deps: {
      platform: "darwin" as const,
      runner,
      getuid: () => 501,
      currentPid: () => 900,
      now: maintenanceDeps.now,
      sleep: maintenanceDeps.sleep,
      isAlive: maintenanceDeps.isAlive,
      homeDir: "/test-home",
      currentEntrypointPath: ENTRY,
      inspectHelperService: async () => ({
        loaded: true,
        pid: 900,
        definition: {
          plistPath: "/test-home/Library/LaunchAgents/com.mono-agent-web-maintenance.plist",
          nodePath: process.execPath,
          cliPath: ENTRY,
          cwd: "/test-home/.mono-agent/web",
          expectedManagedRuntimeLaunch: PROOF,
          expectedWebPlistIdentity: IDENTITY,
        },
      }),
      verifyEntrypoint: vi.fn(async () => undefined),
      readPlist: async () => ({
        identity: `7:8:9:${"b".repeat(64)}`,
        contents: options.helperContents ?? expectedHelper,
      }),
      verifyPlist: async () => IDENTITY,
      acquireLifecycleLock: async () => options.lockAvailable === false
        ? undefined
        : async () => undefined,
      maintenanceDeps,
      writeStatus: async (_path: string, status: WebLogMaintenanceStatus) => { statuses.push(status); },
    },
  };
}

describe("runWebLogMaintenanceCommand", () => {
  it("authenticates the helper, rotates under the web lock, restores a live worker, and clears intent", async () => {
    const test = harness();
    await expect(runWebLogMaintenanceCommand({
      expectedManagedRuntimeLaunch: PROOF,
      expectedWebPlistIdentity: IDENTITY,
    }, test.deps)).resolves.toBe(0);

    expect(test.rotate).toHaveBeenCalledOnce();
    expect(test.getIntent()).toBeUndefined();
    expect(test.calls.findIndex((args) => args[0] === "bootout"))
      .toBeLessThan(test.calls.findIndex((args) => args[0] === "bootstrap"));
    const restored = await test.deps.runner(["print", `gui/501/${WEB_LAUNCHD_LABEL}`]);
    expect(restored).toMatchObject({ code: 0, stdout: "pid = 701\n" });
    expect(test.deps.isAlive(701)).toBe(true);
    expect(test.statuses.at(-1)).toMatchObject({ state: "success", phase: "complete" });
  });

  it("keeps core rotation independent from refused legacy artifacts and persists degradation", async () => {
    const test = harness({ additionalRefusals: ["unsafe legacy hardlink was preserved"] });
    await expect(runWebLogMaintenanceCommand({
      expectedManagedRuntimeLaunch: PROOF,
      expectedWebPlistIdentity: IDENTITY,
    }, test.deps)).resolves.toBe(1);

    expect(test.rotate).toHaveBeenCalledOnce();
    expect(test.getIntent()).toBeUndefined();
    expect(test.statuses.at(-1)).toMatchObject({ state: "degraded", phase: "complete" });
    expect(test.statuses.at(-1)?.refusals).toContain("unsafe legacy hardlink was preserved");
  });

  it("keeps an unloaded service visibly degraded when unsafe legacy inventory is refused", async () => {
    const refusal = "unsafe legacy hardlink was preserved";
    const test = harness({
      additionalRefusals: [refusal],
      additionalCanMaintain: false,
      coreNeedsMaintenance: false,
      workerInitiallyLoaded: false,
    });
    await expect(runWebLogMaintenanceCommand({
      expectedManagedRuntimeLaunch: PROOF,
      expectedWebPlistIdentity: IDENTITY,
    }, test.deps)).resolves.toBe(1);

    expect(test.rotate).not.toHaveBeenCalled();
    expect(test.getIntent()).toBeUndefined();
    expect(test.calls.some((args) => args[0] === "bootout" || args[0] === "bootstrap")).toBe(false);
    expect(test.statuses.at(-1)).toMatchObject({ state: "degraded", phase: "complete" });
    expect(test.statuses.at(-1)?.refusals).toContain(refusal);
  });

  it("rejects a stale helper definition before locking or mutating intent and logs", async () => {
    const test = harness({ helperContents: "stale helper\n" });
    await expect(runWebLogMaintenanceCommand({
      expectedManagedRuntimeLaunch: PROOF,
      expectedWebPlistIdentity: IDENTITY,
    }, test.deps)).resolves.toBe(1);

    expect(test.rotate).not.toHaveBeenCalled();
    expect(test.getIntent()).toBeUndefined();
    expect(test.statuses).toEqual([]);
  });

  it("preserves a prior durable failure when another web lifecycle owner makes this pass defer", async () => {
    const test = harness({ lockAvailable: false });
    await expect(runWebLogMaintenanceCommand({
      expectedManagedRuntimeLaunch: PROOF,
      expectedWebPlistIdentity: IDENTITY,
    }, test.deps)).resolves.toBe(0);

    expect(test.rotate).not.toHaveBeenCalled();
    expect(test.getIntent()).toBeUndefined();
    expect(test.statuses).toEqual([]);
  });

  it("leaves restoring intent durable when no live replacement writer can be proven", async () => {
    const restoring: LaunchdLogMaintenanceIntent = {
      version: 1,
      phase: "restoring",
      label: "com.mono-agent-web",
      plistFingerprint: IDENTITY,
    };
    const test = harness({ pendingIntent: restoring, workerInitiallyLoaded: false });

    await expect(runWebLogMaintenanceCommand({
      expectedManagedRuntimeLaunch: PROOF,
      expectedWebPlistIdentity: IDENTITY,
    }, test.deps)).resolves.toBe(1);
    expect(test.getIntent()).toEqual(restoring);
    expect(test.rotate).not.toHaveBeenCalled();
  });
});

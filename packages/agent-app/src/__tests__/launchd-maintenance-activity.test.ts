import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { allowUnattendedMaintenanceStop, clearMaintenanceDeferral, describeMaintenanceActivity, MAINTENANCE_MAX_DEFERRAL_MS, readLaunchdMaintenanceActivityStatus, writeLaunchdMaintenanceActivityStatus, type LaunchdMaintenanceActivityStatus, type MaintenanceActivityRequest } from "../launchd-maintenance-activity.js";
import { LAUNCHD_LOG_MAX_BYTES, type LaunchdLogInspection } from "../launchd-logs.js";
import type { BackgroundLifecycleTarget } from "../background.js";
import type { WorkerActivityProbe } from "../worker-activity-snapshot.js";

const target: BackgroundLifecycleTarget = { label: "com.mono-agent.policy-01234567", paths: { logDir: "/fictional/logs", stdoutPath: "/fictional/logs/out", stderrPath: "/fictional/logs/err", launchAgentsDir: "/fictional", plistPath: "/fictional/main.plist" } };
function harness() {
  let status: LaunchdMaintenanceActivityStatus | undefined;
  let now = 1_000_000;
  let activity: WorkerActivityProbe = { disposition: "busy", counts: { turns: 1, jobs: 0, asks: 0 } };
  let observedPid: number | undefined;
  const deps = {
    runner: async () => ({ code: 0, stdout: "state = running\npid = 1234\n", stderr: "" }),
    getuid: () => 501, now: () => now, isAlive: () => true,
    probe: async (_label: string, _paths: unknown, pid: number | undefined) => { observedPid = pid; return activity; },
    readStatus: async () => status,
    writeStatus: async (_target: BackgroundLifecycleTarget, value: LaunchdMaintenanceActivityStatus) => { status = value; },
  };
  return { deps, status: () => status!, observedPid: () => observedPid, time: (value: number) => { now = value; }, activity: (value: WorkerActivityProbe) => { activity = value; }, allow: (request: MaintenanceActivityRequest = { reasons: ["log-size"] }) => allowUnattendedMaintenanceStop(target, deps, request) };
}

it.each(["turns", "jobs", "asks"] as const)("%s independently defers and idle proceeds, retaining history", async (source) => {
  const h = harness(); h.activity({ disposition: "busy", counts: { turns: 0, jobs: 0, asks: 0, [source]: 1 } });
  expect(await h.allow()).toBe(false);
  expect(h.observedPid()).toBe(1234);
  expect(h.status()).toMatchObject({ pending: { count: 1 }, lastDecision: { outcome: "deferred-busy" } });
  expect(describeMaintenanceActivity(h.status())).toContain(`${source}=1`);
  h.activity({ disposition: "idle", counts: { turns: 0, jobs: 0, asks: 0 } });
  expect(await h.allow()).toBe(true);
  expect(h.status().pending).toMatchObject({ count: 2 }); // Not completed until lifecycle acknowledgement.
  expect(h.status().lastDecision?.outcome).toBe("proceeded-idle");
});

it("unknown protects old/missing snapshots until four hours, preserving earliest time across reasons", async () => {
  const h = harness(); h.activity({ disposition: "unknown" });
  expect(await h.allow({ reasons: ["runtime-upgrade"] })).toBe(false);
  h.time(1_000_000 + MAINTENANCE_MAX_DEFERRAL_MS - 1);
  expect(await h.allow({ reasons: ["snapshot-drift"] })).toBe(false);
  expect(h.status().pending?.reasons).toEqual(["runtime-upgrade", "snapshot-drift"]);
  h.time(1_000_000 + MAINTENANCE_MAX_DEFERRAL_MS);
  expect(await h.allow()).toBe(true);
  expect(h.status().lastDecision?.outcome).toBe("forced-ceiling");
  h.activity({ disposition: "idle" }); await h.allow();
  expect(h.status().lastForced?.outcome).toBe("forced-ceiling");
});

it("clock rollback cannot extend an episode beyond 48 attempts", async () => {
  const h = harness(); await h.allow(); h.time(0);
  for (let index = 1; index < 47; index++) expect(await h.allow()).toBe(false);
  expect(await h.allow()).toBe(true);
  expect(h.status().lastForced?.outcome).toBe("forced-ceiling");
});

it("forces at twice the active size, not retained size; dead workers proceed", async () => {
  const h = harness();
  const stream = { activeBytes: 0, retainedBytes: 2 * LAUNCHD_LOG_MAX_BYTES, totalBytes: 2 * LAUNCHD_LOG_MAX_BYTES, byteAccountingComplete: true, files: [] };
  const inspection = { stdout: stream, stderr: stream } as unknown as LaunchdLogInspection;
  expect(await h.allow({ reasons: ["log-size"], inspection })).toBe(false);
  expect(await h.allow({ reasons: ["log-size"], inspection: { ...inspection, stderr: { ...stream, activeBytes: 2 * LAUNCHD_LOG_MAX_BYTES } } })).toBe(true);
  expect(h.status().lastForced?.outcome).toBe("forced-size");
  h.activity({ disposition: "not-running" });
  expect(await h.allow()).toBe(true);
});

it.each(["permission-repair", "transaction-recovery", "worker-unready"] as const)("%s override remains immediate", async (override) => {
  const h = harness(); expect(await h.allow({ reasons: ["log-size"], override })).toBe(true);
  expect(h.status().lastDecision?.outcome).toBe(`override-${override}`);
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("persists episodes privately across invocations and clears vanished work without losing forced history", async () => {
  const root = await mkdtemp(join(process.cwd(), ".maintenance-policy-")); roots.push(root); await mkdir(join(root, "logs"));
  const t = { ...target, paths: { ...target.paths, logDir: join(root, "logs") } };
  const h = harness(); await h.allow();
  await writeLaunchdMaintenanceActivityStatus(t, h.status());
  expect(await readLaunchdMaintenanceActivityStatus(t.label, t.paths)).toEqual(h.status());
  await clearMaintenanceDeferral(t);
  expect(await readLaunchdMaintenanceActivityStatus(t.label, t.paths)).toEqual({ version: 1, lastDecision: h.status().lastDecision });
  await expect(writeLaunchdMaintenanceActivityStatus(t, { version: 1, pending: { ...h.status().pending!, count: -1 } })).rejects.toThrow("Malformed");
});

it("a forced decision retains the original episode until lifecycle completion, so failed stops cannot reset it", async () => {
  const h = harness(); expect(await h.allow()).toBe(false);
  const firstDeferredAt = h.status().pending!.firstDeferredAt;
  h.time(1_000_000 + MAINTENANCE_MAX_DEFERRAL_MS);
  expect(await h.allow()).toBe(true); expect(h.status().lastDecision?.outcome).toBe("forced-ceiling");
  expect(h.status().pending?.firstDeferredAt).toBe(firstDeferredAt);
  // No acknowledgement: bootout failed. Next helper pass must force immediately.
  expect(await h.allow()).toBe(true); expect(h.status().lastDecision?.outcome).toBe("forced-ceiling");
  expect(h.status().pending).toMatchObject({ firstDeferredAt, count: 3 });
});

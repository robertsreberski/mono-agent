import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import * as privateState from "../private-launchd-state.js";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerActivityTracker, trackResponderActivity } from "../worker-activity.js";
import { allowUnattendedMaintenanceStop } from "../launchd-maintenance-activity.js";
import { probeWorkerActivity, publishWorkerActivity } from "../worker-activity-snapshot.js";
import { writePrivateLaunchdState } from "../private-launchd-state.js";
import { currentProcessIncarnation } from "../process-incarnation.js";
import type { BackgroundLifecycleTarget } from "../background.js";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { bindProcessJobWakeContextToResponder, runWithProcessJobWakeContext } from "../process-jobs-context.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(access).mockReset().mockImplementation(actual.access);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function target(): Promise<BackgroundLifecycleTarget> {
  const root = await mkdtemp(join(process.cwd(), ".activity-test-")); roots.push(root);
  const logDir = join(root, "logs"); await mkdir(logDir);
  const label = "com.mono-agent.activity-01234567";
  return { label, paths: { logDir, launchAgentsDir: root, plistPath: join(root, "worker.plist"), stdoutPath: join(logDir, "out"), stderrPath: join(logDir, "err") } };
}

it.each(["turns", "jobs", "asks"] as const)("%s alone blocks; transitions return to idle", (source) => {
  const tracker = new WorkerActivityTracker();
  const changes = vi.fn(); tracker.subscribe(changes);
  tracker.set(source, 1); expect(tracker.busy()).toBe(true);
  tracker.set(source, 0); expect(tracker.busy()).toBe(false);
  expect(changes).toHaveBeenCalledTimes(2);
});

it("tracks concurrent invocations and wakes, including throws/cancellation; preserves live input and receiver", async () => {
  const tracker = new WorkerActivityTracker();
  const releases: (() => void)[] = [];
  const original = {
    marker: "receiver",
    async respond() { expect(this.marker).toBe("receiver"); await new Promise<void>((resolve) => releases.push(resolve)); throw new Error("cancelled"); },
    compactConversation: async () => { throw new Error("failed"); },
    offerLiveInput: vi.fn(() => ({ status: "unavailable" as const, reason: "inactive" as const })),
    liveInputOwnership: "responder" as const,
  };
  const responder = trackResponderActivity(bindProcessJobWakeContextToResponder(original as unknown as AgentResponder), tracker);
  const request = { conversationId: "web:fictional", text: "test", abortSignal: new AbortController().signal, metadata: {} };
  const a = responder.respond(request, {} as never).catch(() => undefined);
  const b = runWithProcessJobWakeContext({ jobId: "job", chainDepth: 1 }, () => responder.respond(request, {} as never), "wake").catch(() => undefined);
  expect(tracker.snapshot().turns).toBe(2);
  expect(responder.cancel).toBeUndefined();
  expect(responder.liveInputOwnership).toBe(original.liveInputOwnership);
  responder.offerLiveInput!({} as never); expect(original.offerLiveInput).toHaveBeenCalledOnce();
  for (const release of releases) release(); await Promise.all([a, b]);
  expect(tracker.busy()).toBe(false);
  await expect(responder.compactConversation!({} as never)).rejects.toThrow("failed");
  expect(tracker.busy()).toBe(false);
});

describe("owner-private snapshot contract", () => {
  it("publishes real process identity and activity promptly, then removes on clean shutdown", async () => {
    const t = await target(); const tracker = new WorkerActivityTracker();
    const publisher = await publishWorkerActivity(t, tracker, () => { throw new Error("unexpected write failure"); });
    const probe = () => probeWorkerActivity(t.label, t.paths, process.pid, () => true);
    expect(await probe()).toMatchObject({ disposition: "idle", counts: { turns: 0, jobs: 0, asks: 0 } });
    tracker.set("jobs", 1);
    await vi.waitFor(async () => expect(await probe()).toMatchObject({ disposition: "busy", counts: { jobs: 1 } }));
    tracker.set("jobs", 0);
    await vi.waitFor(async () => expect(await probe()).toMatchObject({ disposition: "idle" }));
    await publisher.stop(); expect(await probe()).toEqual({ disposition: "unknown" });
  });

  it("protects missing/malformed/PID-reused/unsafe snapshots but not dead workers", async () => {
    const t = await target();
    const probe = (same = true, pid = process.pid) => probeWorkerActivity(t.label, t.paths, pid, () => true, () => same);
    expect(await probe()).toEqual({ disposition: "unknown" });
    const valid = { version: 1, pid: process.pid, incarnation: await currentProcessIncarnation(), counts: { turns: 0, jobs: 0, asks: 0 }, busy: false, updatedAt: new Date().toISOString() };
    await writePrivateLaunchdState(t, "worker-activity", valid);
    expect(await probe(false)).toEqual({ disposition: "unknown" });
    expect(await probe(true, process.pid + 1)).toEqual({ disposition: "unknown" });
    await writePrivateLaunchdState(t, "worker-activity", { ...valid, counts: { turns: -1, jobs: 0, asks: 0 } });
    expect(await probe()).toEqual({ disposition: "unknown" });
    await writePrivateLaunchdState(t, "worker-activity", valid);
    await chmod(join(t.paths.logDir, "..", "worker-activity"), 0o755);
    expect(await probe()).toEqual({ disposition: "unknown" });
    expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => false)).toEqual({ disposition: "not-running" });
    expect(await probeWorkerActivity(t.label, t.paths, undefined, () => true)).toEqual({ disposition: "not-running" });
  });

  it("refuses symlink state directories without following or replacing their contents", async () => {
    const t = await target(); const root = join(t.paths.logDir, "..");
    const destination = join(root, "elsewhere"); await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, "sentinel"), "unchanged");
    await symlink(destination, join(root, "worker-activity"));
    await expect(writePrivateLaunchdState(t, "worker-activity", {})).rejects.toThrow("owner-private directory");
    expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => true)).toEqual({ disposition: "unknown" });
  });
});

it("each service retracts only its own job contribution across overlapping lifetimes", () => {
  const tracker = new WorkerActivityTracker();
  const oldService = tracker.jobExecutionObserver(); const newService = tracker.jobExecutionObserver();
  oldService(1); newService(1); expect(tracker.snapshot().jobs).toBe(2);
  oldService(0); expect(tracker.snapshot().jobs).toBe(1); expect(tracker.busy()).toBe(true);
  oldService(0); expect(tracker.snapshot().jobs).toBe(1);
  newService(0); expect(tracker.snapshot().jobs).toBe(0); expect(tracker.busy()).toBe(false);
});

it("retires the main idle snapshot before a poisoned temporary makes busy publication and cleanup fail", async () => {
  const t = await target(); const tracker = new WorkerActivityTracker(); const failures = vi.fn();
  const publisher = await publishWorkerActivity(t, tracker, failures);
  const directory = join(t.paths.logDir, "..", "worker-activity");
  const file = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!);
  const sentinel = join(t.paths.logDir, "..", "sentinel"); await writeFile(sentinel, "unchanged");
  await symlink(sentinel, `${file}.next`);
  tracker.set("jobs", 1);
  await vi.waitFor(() => expect(failures).toHaveBeenCalledOnce());
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => true)).toEqual({ disposition: "unknown" });
  expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  await expect(publisher.stop()).rejects.toThrow("owner-private regular file");
});

it("retries a dirty busy snapshot after BOTH publication and authoritative retirement fail, without a new activity transition", async () => {
  const t = await target(); const tracker = new WorkerActivityTracker(); const failures = vi.fn();
  const write = privateState.writePrivateLaunchdState; const remove = privateState.removePrivateLaunchdState;
  let busyAttempts = 0; let retireAttempts = 0;
  vi.spyOn(privateState, "writePrivateLaunchdState").mockImplementation(async (...args) => {
    if ((args[2] as { busy?: boolean }).busy && ++busyAttempts <= 2) throw new Error("fictional restored-previous publication failure");
    await write(...args);
  });
  vi.spyOn(privateState, "removePrivateLaunchdState").mockImplementation(async (...args) => {
    if (++retireAttempts <= 2) throw new Error("fictional transient unlink failure");
    await remove(...args);
  });
  const publisher = await publishWorkerActivity(t, tracker, failures);
  try {
    expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => true)).toMatchObject({ disposition: "idle" });
    tracker.set("jobs", 1); // The only transition; two failures cannot wait for another one.
    await vi.waitFor(async () => expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => true)).toMatchObject({ disposition: "busy", counts: { jobs: 1 } }), { timeout: 5_000 });
    expect(busyAttempts).toBe(3); expect(retireAttempts).toBe(2);
    expect(failures).toHaveBeenCalledOnce();
  } finally { await publisher.stop(); }
});

it("keeps standalone MCP-app/context-import work outside the documented responder-turn busy scope", async () => {
  const tracker = new WorkerActivityTracker(); let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const responder = trackResponderActivity({ respond: async () => ({ text: "" }),
    importContext: async () => await pending, requestMcpApp: async () => await pending,
  } as unknown as AgentResponder, tracker);
  const imports = responder.importContext!("web:fictional", {} as never);
  const appRequest = responder.requestMcpApp!({} as never);
  expect(tracker.snapshot()).toEqual({ turns: 0, jobs: 0, asks: 0 });
  expect(tracker.busy()).toBe(false);
  finish(); await Promise.all([imports, appRequest]);
});

it("classifies write-denied activity files/directories as unknown without changing ordinary private-state reads", async () => {
  const t = await target(); const tracker = new WorkerActivityTracker();
  const publisher = await publishWorkerActivity(t, tracker, vi.fn());
  const directory = join(t.paths.logDir, "..", "worker-activity");
  const file = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!);
  try {
    const { access: actualAccess } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    for (const denied of [directory, file]) {
      vi.mocked(access).mockImplementation(async (path, mode) => {
        if (path === denied && mode === fsConstants.W_OK) throw Object.assign(new Error("fictional access denial"), { code: "EACCES" });
        await actualAccess(path, mode);
      });
      // Generic readers still read owned private state, even when read-only.
      expect(await privateState.readPrivateLaunchdState(t.label, t.paths, "worker-activity")).toMatchObject({ busy: false });
      expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => true)).toEqual({ disposition: "unknown" });
    }
    expect(access).toHaveBeenCalledWith(directory, fsConstants.W_OK);
    expect(access).toHaveBeenCalledWith(file, fsConstants.W_OK);
  } finally { await publisher.stop(); }
});

it.skipIf(process.platform !== "darwin")("protects a busy worker behind an immutable old idle snapshot while dirty retries continue", async () => {
  const t = await target(); const tracker = new WorkerActivityTracker(); const failures = vi.fn();
  const publisher = await publishWorkerActivity(t, tracker, failures);
  const directory = join(t.paths.logDir, "..", "worker-activity");
  const file = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!);
  const run = promisify(execFile);
  const writes = vi.spyOn(privateState, "writePrivateLaunchdState");
  try {
    await run("/usr/bin/chflags", ["uchg", file]);
    tracker.set("jobs", 1);
    await vi.waitFor(() => expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(failures).toHaveBeenCalledOnce();
    expect(await privateState.readPrivateLaunchdState(t.label, t.paths, "worker-activity")).toMatchObject({ busy: false, counts: { jobs: 0 } });
    expect(tracker.snapshot().jobs).toBe(1);
    expect(await probeWorkerActivity(t.label, t.paths, process.pid, () => true)).toEqual({ disposition: "unknown" });
    const allowed = await allowUnattendedMaintenanceStop(t, {
      runner: async () => ({ code: 0, stdout: `state = running\npid = ${process.pid}\n`, stderr: "" }),
      getuid: () => process.getuid?.() ?? 0, now: Date.now, isAlive: () => true,
    }, { reasons: ["log-size"] });
    expect(allowed).toBe(false);
  } finally {
    // The file is exclusively this test's scratch artifact. Always remove the
    // flag before stopping the publisher or the ordinary afterEach rm cleanup.
    await run("/usr/bin/chflags", ["nouchg", file]);
    await publisher.stop();
  }
});

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerActivityTracker, trackResponderActivity } from "../worker-activity.js";
import { probeWorkerActivity, publishWorkerActivity } from "../worker-activity-snapshot.js";
import { writePrivateLaunchdState } from "../private-launchd-state.js";
import { currentProcessIncarnation } from "../process-incarnation.js";
import type { BackgroundLifecycleTarget } from "../background.js";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { bindProcessJobWakeContextToResponder, runWithProcessJobWakeContext } from "../process-jobs-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
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

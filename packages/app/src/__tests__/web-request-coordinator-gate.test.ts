import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireOwnerPrivateLock, type OwnerPrivateLockMutationStep } from "../durable-state/owner-private-lock.js";
import { withOwnerLockMutationGate } from "../durable-state/owner-lock-mutation-gate.js";
import {
  WEB_CONTROL_MUTATION_GATE,
  createHostWebRequestCoordinator,
  webControlLockOptions,
} from "../host/web-request-coordinator.js";

/** A fictional PID that no live process holds; liveness reports it dead. */
const DEAD_PID = 2_147_480_003;
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function webDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "web-control-gate-test-")));
  roots.push(directory);
  return directory;
}

function request(): { kind: "codex"; key: string; deadlineMs: number } {
  return { kind: "codex", key: "codex", deadlineMs: Date.now() + 30_000 };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function ownerRecord(directory: string): Promise<{ pid: number; token: string }> {
  return JSON.parse(await readFile(join(directory, ".lock", "owner.json"), "utf8")) as { pid: number; token: string };
}

/** Hold the gate with a raw node:sqlite exclusive transaction in another process. */
async function gateHolder(directory: string): Promise<{ release(): Promise<void> }> {
  const gatePath = join(directory, WEB_CONTROL_MUTATION_GATE);
  await (await open(gatePath, "wx", 0o600)).close();
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(gatePath)}, { timeout: 0 });
    db.exec("PRAGMA journal_mode=MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    process.stdout.write("held\\n");
    process.stdin.once("data", () => { db.exec("ROLLBACK"); db.close(); process.exit(0); });
  `], { stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.stdout.once("data", (chunk) => String(chunk).includes("held")
      ? resolvePromise()
      : rejectPromise(new Error(`unexpected holder output: ${String(chunk)}`)));
    child.once("exit", () => rejectPromise(new Error("gate holder exited early")));
  });
  return {
    async release() {
      child.stdin.write("release\n");
      await exited;
    },
  };
}

describe("web request coordination lock with the mutation gate", () => {
  it("keeps exactly one holder when a slow stale reclaimer pauses between its final check and rename", async () => {
    const directory = await webDirectory();
    // A crashed holder leaves a published lock owned by a dead process.
    expect(await acquireOwnerPrivateLock({ ...webControlLockOptions(directory), pid: DEAD_PID })).toBeDefined();
    expect((await ownerRecord(directory)).pid).toBe(DEAD_PID);

    const entered = deferred();
    const resume = deferred();
    const steps: OwnerPrivateLockMutationStep[] = [];
    const slow = acquireOwnerPrivateLock({
      ...webControlLockOptions(directory, {
        mutationStep: async (step) => {
          steps.push(step);
          if (step !== "stale-verified" || steps.filter((value) => value === "stale-verified").length > 1) return;
          entered.resolve();
          await resume.promise;
        },
      }),
      randomToken: () => "slow-reclaimer",
    });
    await entered.promise;

    const fast = acquireOwnerPrivateLock({ ...webControlLockOptions(directory), randomToken: () => "fast-contender" });
    let fastSettled = false;
    void fast.then(() => { fastSettled = true; }, () => { fastSettled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    // The fast contender cannot publish while the slow one holds the final check and rename.
    expect(fastSettled).toBe(false);
    expect((await ownerRecord(directory)).pid).toBe(DEAD_PID);
    resume.resolve();

    const handles = (await Promise.all([slow, fast])).filter((handle) => handle !== undefined);
    expect(handles).toHaveLength(1);
    expect(["slow-reclaimer", "fast-contender"]).toContain((await ownerRecord(directory)).token);
    const third = await acquireOwnerPrivateLock({ ...webControlLockOptions(directory), waitTimeoutMs: 0 });
    expect(third).toBeUndefined();
    expect((await readdir(directory)).sort()).toEqual([".lock", WEB_CONTROL_MUTATION_GATE]);
    await handles[0]!.release();
    await expect(lstat(join(directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns coordination_unavailable within the wait budget while another process holds the gate", async () => {
    const directory = await webDirectory();
    const holder = await gateHolder(directory);
    const coordinator = createHostWebRequestCoordinator({ directory, spacingScale: 0 });
    const started = performance.now();
    await expect(coordinator.acquire(request())).rejects.toMatchObject({ code: "coordination_unavailable" });
    const elapsed = performance.now() - started;
    // Bounded by the existing 2 s lock wait (plus scheduling slack), never by a longer gate timeout.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_500);
    await expect(lstat(join(directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await holder.release();
    const permit = await coordinator.acquire(request());
    await permit.complete({ status: "ok" });
  }, 20_000);

  it("retries a briefly busy gate inside the wait budget instead of failing", async () => {
    const directory = await webDirectory();
    const holder = await gateHolder(directory);
    const coordinator = createHostWebRequestCoordinator({ directory, spacingScale: 0 });
    const pending = coordinator.acquire(request());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    await holder.release();
    const permit = await pending;
    await permit.complete({ status: "ok" });
  }, 20_000);

  it.skipIf(process.platform === "win32")("fails closed as coordination_unavailable on an insecure or modified gate", async () => {
    for (const [label, mode, contents] of [["insecure", 0o644, ""], ["modified", 0o600, "fictional bytes"]] as const) {
      const directory = await webDirectory();
      await writeFile(join(directory, WEB_CONTROL_MUTATION_GATE), contents, { mode });
      const coordinator = createHostWebRequestCoordinator({ directory, spacingScale: 0 });
      await expect(coordinator.acquire(request()), label).rejects.toMatchObject({ code: "coordination_unavailable" });
      // The transaction never ran unguarded: no lock and no state were written.
      expect((await readdir(directory)).sort(), label).toEqual([WEB_CONTROL_MUTATION_GATE]);
    }
  });

  it("commits a transaction whose lock release met a busy gate and finishes the release in the background", async () => {
    const directory = await webDirectory();
    const gatePath = join(directory, WEB_CONTROL_MUTATION_GATE);
    const holding = deferred();
    const entered = deferred();
    let holder: Promise<void> | undefined;
    const coordinator = createHostWebRequestCoordinator({
      directory,
      spacingScale: 0,
      lockSeams: {
        gateBusyTimeoutMs: 50,
        beforeRelease: async () => {
          if (holder !== undefined) return;
          holder = withOwnerLockMutationGate({ path: gatePath }, "Test holder", async () => {
            entered.resolve();
            await holding.promise;
          });
          await entered.promise;
        },
      },
    });

    await expect(coordinator.writeQuota({ fictional: 1 })).resolves.toBeUndefined();
    // The state change is committed; the lock is still validly held by this process.
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))).toMatchObject({ quota: { value: { fictional: 1 } } });
    expect((await ownerRecord(directory)).pid).toBe(process.pid);
    holding.resolve();
    await holder;
    await vi.waitFor(async () => {
      await expect(lstat(join(directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 5_000, interval: 20 });
    expect((await coordinator.readQuota())?.value).toEqual({ fictional: 1 });
  });

  it("keeps the permanent gate file through reset and status", async () => {
    const directory = await webDirectory();
    const coordinator = createHostWebRequestCoordinator({ directory, spacingScale: 0 });
    const permit = await coordinator.acquire(request());
    await permit.complete({ status: "ok" });
    await coordinator.reset();
    await coordinator.inspect();
    expect((await readdir(directory)).sort()).toEqual([WEB_CONTROL_MUTATION_GATE, "state.json"]);
    const gate = await lstat(join(directory, WEB_CONTROL_MUTATION_GATE));
    expect(gate.size).toBe(0);
  });
});

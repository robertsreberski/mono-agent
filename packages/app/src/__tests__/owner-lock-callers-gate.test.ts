import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireOwnerPrivateLock,
  type OwnerPrivateLockMutationStep,
} from "../durable-state/owner-private-lock.js";
import {
  OWNER_LOCK_MUTATION_GATE,
  OwnerLockGateUnavailableError,
  withOwnerLockMutationGate,
} from "../durable-state/owner-lock-mutation-gate.js";
import { acquireFilesystemLifecycleLock } from "../service/launchd/launchd-lifecycle-lock.js";
import { acquireBackgroundWorkerLease, backgroundWorkerLeasePath } from "../service/background/background-worker-lease.js";
import {
  acquireManagedRuntimePublicationBarrier,
  managedRuntimePublicationBarrierPath,
} from "../service/managed-runtime/managed-runtime-publication.js";
import { managedRuntimeLockProtocol } from "../service/managed-runtime/background-runtime.js";
import { srtInstallLockProtocol } from "../service/sandbox/sandbox-manager.js";
import {
  failedProcessJobsRootRegistryProtection,
  processJobsRegistryLockProtocol,
  processJobsRootRegistryPaths,
} from "../process-jobs/process-jobs-root-registry.js";
import { processJobsOwnerLockProtocol } from "../process-jobs/process-jobs-service.js";

/** A fictional PID treated as dead by every contender here. */
const DEAD_PID = 2_147_480_004;
const incarnation = {
  schema: "mono-agent.process-incarnation.v1" as const,
  bootSessionId: "callers-gate-boot",
  processStartId: "callers-gate-start",
};
const isSameProcessIncarnation = async (pid: number): Promise<boolean> => pid !== DEAD_PID;
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

interface Seams {
  readonly pid?: number;
  readonly mutationStep?: (step: OwnerPrivateLockMutationStep, path: string) => void | Promise<void>;
  readonly gateBusyTimeoutMs?: number;
}
interface Held { release(): Promise<void> }
interface Harness {
  readonly lockPath: string;
  acquire(seams?: Seams): Promise<Held | undefined>;
  /** The caller's existing outcome when the gate stays busy: "held" or a thrown error. */
  readonly busy: "held" | RegExp;
}
interface Caller {
  readonly name: string;
  prepare(root: string): Promise<Harness>;
}

type LockOptions = Parameters<typeof acquireOwnerPrivateLock>[0];

/** Run a caller's exact protocol builder through the shared primitive. */
function viaProtocol(protocol: LockOptions, busy: Harness["busy"]): Harness {
  return {
    lockPath: protocol.path,
    busy,
    acquire: async (seams = {}) => await acquireOwnerPrivateLock({
      ...protocol,
      waitTimeoutMs: 0,
      processIncarnation: incarnation,
      isSameProcessIncarnation,
      ...(seams.pid === undefined ? {} : { pid: seams.pid }),
      ...(seams.mutationStep === undefined ? {} : { mutationStep: seams.mutationStep }),
      mutationGate: {
        ...protocol.mutationGate!,
        ...(seams.gateBusyTimeoutMs === undefined ? {} : { busyTimeoutMs: seams.gateBusyTimeoutMs }),
      },
    }),
  };
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

const callers: readonly Caller[] = [
  {
    name: "launchd lifecycle lock",
    prepare: async (root) => {
      const home = await privateDirectory(join(root, "home"));
      const label = "com.mono-agent.fictional-a1b2c3d4";
      const target = {
        label,
        paths: {
          launchAgentsDir: join(home, "Library", "LaunchAgents"),
          logDir: join(home, ".mono-agent", "logs"),
          plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
          stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
          stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
        },
      } as Parameters<typeof acquireFilesystemLifecycleLock>[0];
      return {
        lockPath: join(home, ".mono-agent", "locks", `${label}.lock`),
        busy: "held",
        acquire: async (seams = {}) => {
          const release = await acquireFilesystemLifecycleLock(target, {
            processIncarnation: incarnation,
            isSameProcessIncarnation,
            ...seams,
          });
          return release === undefined ? undefined : { release };
        },
      };
    },
  },
  {
    name: "background worker lease",
    prepare: async (root) => {
      const home = await privateDirectory(join(root, "home"));
      const configPath = join(root, "mono-agent.config.json");
      await writeFile(configPath, "{}\n", { mode: 0o600 });
      return {
        // The lease keys on the canonical config path (macOS tmpdir is a symlink).
        lockPath: backgroundWorkerLeasePath(await realpath(configPath), home),
        busy: "held",
        acquire: async (seams = {}) => await acquireBackgroundWorkerLease(configPath, {
          homeDir: home,
          processIncarnation: incarnation,
          isSameProcessIncarnation,
          ...(seams.pid === undefined ? {} : { pid: seams.pid }),
          hooks: {
            ...(seams.mutationStep === undefined ? {} : { leaseMutationStep: seams.mutationStep }),
            ...(seams.gateBusyTimeoutMs === undefined ? {} : { gateBusyTimeoutMs: seams.gateBusyTimeoutMs }),
          },
        }),
      };
    },
  },
  {
    name: "managed runtime publication barrier",
    prepare: async (root) => {
      const managedRoot = await privateDirectory(join(root, ".mono-agent"));
      await privateDirectory(join(managedRoot, "locks"));
      const label = "com.mono-agent.fictional-a1b2c3d4";
      return {
        lockPath: managedRuntimePublicationBarrierPath(label, managedRoot),
        busy: "held",
        acquire: async (seams = {}) => await acquireManagedRuntimePublicationBarrier({
          label,
          managedRoot,
          processIncarnation: incarnation,
          isSameProcessIncarnation,
          ...seams,
        }),
      };
    },
  },
  {
    name: "managed runtime install lock",
    prepare: async (root) => {
      const versionAbiDir = await privateDirectory(join(root, "runtimes", "fictional-version"));
      return viaProtocol(managedRuntimeLockProtocol({
        lockDir: join(versionAbiDir, ".fictional-closure.lock"),
        quarantineDir: join(versionAbiDir, "quarantine", "fictional-closure-1"),
      }, {
        packageVersion: "0.0.0-fictional",
        cliSha256: "a".repeat(64),
        sourceClosureSha256: "b".repeat(64),
        nodeAbi: "137",
        platform: process.platform,
        arch: process.arch,
      }), "held");
    },
  },
  {
    name: "SRT install lock",
    prepare: async (root) => {
      const versionRoot = await privateDirectory(join(root, "srt", "fictional-version"));
      return viaProtocol(srtInstallLockProtocol(join(versionRoot, ".install.lock")), /SRT install lock is unsafe.*coordination busy/u);
    },
  },
  {
    name: "process-job root registry lock",
    prepare: async (root) => {
      const managedRoot = await privateDirectory(join(root, "agent", ".mono-agent"));
      return viaProtocol(processJobsRegistryLockProtocol(join(managedRoot, ".process-jobs-roots-v1.lock")), "held");
    },
  },
  {
    name: "process-job state owner lock",
    prepare: async (root) => {
      const stateDir = await privateDirectory(join(root, "agent", ".mono-agent", "process-jobs"));
      return viaProtocol(processJobsOwnerLockProtocol(stateDir), "held");
    },
  },
];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-callers-gate-"));
  roots.push(root);
  return root;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** Hold the gate with a raw node:sqlite exclusive transaction in another process. */
async function processGateHolder(gatePath: string): Promise<{ release(): Promise<void> }> {
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
    child.stdout!.once("data", (chunk) => String(chunk).includes("held")
      ? resolvePromise()
      : rejectPromise(new Error(`unexpected holder output: ${String(chunk)}`)));
    child.once("exit", () => rejectPromise(new Error("gate holder exited early")));
  });
  return { async release() { child.stdin!.write("release\n"); await exited; } };
}

describe.each(callers)("$name with the mutation gate", (caller) => {
  it("keeps exactly one holder when a slow stale reclaimer pauses between its final check and rename", async () => {
    const harness = await caller.prepare(await temporaryRoot());
    // A crashed holder leaves a published lock owned by a dead process.
    expect(await harness.acquire({ pid: DEAD_PID })).toBeDefined();
    const gatePath = join(dirname(harness.lockPath), OWNER_LOCK_MUTATION_GATE);
    expect((await lstat(gatePath)).size).toBe(0);

    const entered = deferred();
    const resume = deferred();
    let paused = false;
    const slow = harness.acquire({
      mutationStep: async (step) => {
        if (step !== "stale-verified" || paused) return;
        paused = true;
        entered.resolve();
        await resume.promise;
      },
    });
    await entered.promise;
    const fast = harness.acquire();
    let fastSettled = false;
    void fast.then(() => { fastSettled = true; }, () => { fastSettled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    // The fast contender cannot publish while the slow one holds the final check and rename.
    expect(fastSettled).toBe(false);
    resume.resolve();

    const outcomes = await Promise.allSettled([slow, fast]);
    const holders = outcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value !== undefined
      ? [outcome.value]
      : []);
    expect(holders).toHaveLength(1);
    // A third contender is refused (held, or the caller's existing held error).
    const third = await harness.acquire().then((value) => value, () => undefined);
    expect(third).toBeUndefined();
    await holders[0]!.release();
    await expect(lstat(harness.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a gate that stays busy onto the caller's existing held outcome", async () => {
    const harness = await caller.prepare(await temporaryRoot());
    // Create the lock directory's parent and gate exactly where the caller would.
    await harness.acquire().then((held) => held?.release());
    await rm(join(dirname(harness.lockPath), OWNER_LOCK_MUTATION_GATE));
    const holder = await processGateHolder(join(dirname(harness.lockPath), OWNER_LOCK_MUTATION_GATE));
    const attempt = harness.acquire({ gateBusyTimeoutMs: 100 });
    if (harness.busy === "held") await expect(attempt).resolves.toBeUndefined();
    else await expect(attempt).rejects.toThrow(harness.busy);
    await expect(lstat(harness.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await holder.release();
    const held = await harness.acquire();
    expect(held).toBeDefined();
    await held!.release();
  });

  it.skipIf(process.platform === "win32")("fails closed on an insecure gate without creating the lock", async () => {
    const harness = await caller.prepare(await temporaryRoot());
    await harness.acquire().then((held) => held?.release());
    const gatePath = join(dirname(harness.lockPath), OWNER_LOCK_MUTATION_GATE);
    await rm(gatePath);
    await writeFile(gatePath, "", { mode: 0o644 });
    const error = await harness.acquire().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerLockGateUnavailableError);
    expect(String((error as Error).message)).toMatch(/owner-only \(mode 0600\)/u);
    await expect(lstat(harness.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a release that met a busy gate in the background without failing the caller", async () => {
    const harness = await caller.prepare(await temporaryRoot());
    const held = await harness.acquire({ gateBusyTimeoutMs: 50 });
    expect(held).toBeDefined();
    const hold = deferred();
    const entered = deferred();
    const holder = withOwnerLockMutationGate({ path: join(dirname(harness.lockPath), OWNER_LOCK_MUTATION_GATE) },
      "Test holder", async () => { entered.resolve(); await hold.promise; });
    await entered.promise;
    await expect(held!.release()).resolves.toBeUndefined();
    // Nothing moved: the lock is still validly held until the background retry.
    expect((await lstat(harness.lockPath)).isDirectory()).toBe(true);
    hold.resolve();
    await holder;
    await vi.waitFor(async () => {
      await expect(lstat(harness.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 5_000, interval: 20 });
  });
});

describe("process-job state owner lock timing", () => {
  it("never reclaims a publication slower than the 1 s ownerless grace", async () => {
    const stateDir = await privateDirectory(join(await temporaryRoot(), "process-jobs"));
    const protocol = processJobsOwnerLockProtocol(stateDir);
    const created = deferred();
    const options = { ...protocol, processIncarnation: incarnation, isSameProcessIncarnation };
    // The publisher stalls 1.5 s between mkdir and its owner record, inside the gate.
    const publisher = acquireOwnerPrivateLock({
      ...options,
      randomToken: () => "slow-publisher",
      afterDirectoryCreated: async () => {
        created.resolve();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
      },
    });
    await created.promise;
    // Let the empty directory pass the 1 s grace while its publisher still stalls.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
    // The contender waits on the gate instead of reclaiming the expired empty directory.
    const contender = await acquireOwnerPrivateLock({ ...options, randomToken: () => "contender" });
    const held = await publisher;
    expect(held).toBeDefined();
    expect(contender).toBeUndefined();
    await held!.release();
  });
});

describe("caller-specific gate placement and budgets", () => {
  it("sandbox-protects the registry gate together with the registry lock", () => {
    const agentRoot = "/fictional/agent";
    const paths = processJobsRootRegistryPaths(agentRoot);
    const gatePath = join(dirname(paths.mutationLockPath), OWNER_LOCK_MUTATION_GATE);
    expect(gatePath).toBe(join(agentRoot, ".mono-agent", OWNER_LOCK_MUTATION_GATE));
    expect(failedProcessJobsRootRegistryProtection(agentRoot).protectedRoots).toEqual(
      expect.arrayContaining([paths.mutationLockPath, gatePath]),
    );
  });

  it("waits out a busy gate within a caller's own wait, and maps it only at that deadline", async () => {
    const versionRoot = await privateDirectory(join(await temporaryRoot(), "srt", "fictional-version"));
    const protocol = srtInstallLockProtocol(join(versionRoot, ".install.lock"));
    const gatePath = join(versionRoot, OWNER_LOCK_MUTATION_GATE);
    // Each single gate wait (200 ms) is far shorter than the caller's wait.
    const options = {
      ...protocol,
      processIncarnation: incarnation,
      isSameProcessIncarnation,
      pollIntervalMs: 20,
      mutationGate: { ...protocol.mutationGate!, busyTimeoutMs: 200 },
    };

    // Freed part-way through the wait: the caller acquires instead of failing.
    const briefly = await processGateHolder(gatePath);
    const freed = setTimeout(() => { void briefly.release(); }, 600);
    const held = await acquireOwnerPrivateLock({ ...options, waitTimeoutMs: 3_000 });
    clearTimeout(freed);
    expect(held).toBeDefined();
    await held!.release();

    // Busy for the whole wait: the existing error arrives at the deadline, not after one gate wait.
    await rm(gatePath);
    const holder = await processGateHolder(gatePath);
    const started = performance.now();
    await expect(acquireOwnerPrivateLock({ ...options, waitTimeoutMs: 1_000 }))
      .rejects.toThrow(/SRT install lock is unsafe.*coordination busy/u);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4_000);
    await expect(lstat(join(versionRoot, ".install.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await holder.release();
  });

  it("reports a busy gate as held contention within the shared launchd-log lock's own wait", async () => {
    const home = await privateDirectory(join(await temporaryRoot(), "home"));
    const target = {
      label: "launchd-log-shared-fictional",
      paths: { logDir: join(home, ".mono-agent", "logs") },
    } as Parameters<typeof acquireFilesystemLifecycleLock>[0];
    const shared = {
      purpose: "shared-launchd-logs" as const,
      ownerLabel: "com.mono-agent.fictional-a1b2c3d4",
      processIncarnation: incarnation,
      isSameProcessIncarnation,
    };
    const first = await acquireFilesystemLifecycleLock(target, shared);
    expect(first).toBeDefined();
    await first!();
    const gatePath = join(home, ".mono-agent", "locks", OWNER_LOCK_MUTATION_GATE);
    await rm(gatePath);
    const holder = await processGateHolder(gatePath);
    const started = performance.now();
    // Interactive mode waits; the gate wait is bounded by that same budget, never a deadlock.
    await expect(acquireFilesystemLifecycleLock(target, { ...shared, waitTimeoutMs: 400, pollIntervalMs: 20 }))
      .resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(3_000);
    await holder.release();
  });
});

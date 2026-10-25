import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireOwnerPrivateLock,
  type OwnerPrivateLock,
  type OwnerPrivateLockMutationStep,
} from "../durable-state/owner-private-lock.js";
import {
  OwnerLockCoordinationBusyError,
  OwnerLockGateUnavailableError,
  withOwnerLockMutationGate,
} from "../durable-state/owner-lock-mutation-gate.js";

/** A fictional PID treated as dead by every contender in these tests. */
const DEAD_PID = 2_147_480_001;
const incarnation = {
  schema: "mono-agent.process-incarnation.v1" as const,
  bootSessionId: "race-test-boot",
  processStartId: "race-test-start",
};
const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function directory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `mono-agent-lock-race-${label}-`));
  temporaryDirectories.push(path);
  return path;
}

type LockOptions = Parameters<typeof acquireOwnerPrivateLock>[0];

function lockOptions(path: string, token: string, extra: Partial<LockOptions> = {}): LockOptions {
  return {
    path,
    label: "Race test lock",
    schemaTag: "mono-agent.test-lock.v1",
    ownerlessGraceMs: 60_000,
    processIncarnation: incarnation,
    isSameProcessIncarnation: async (pid) => pid !== DEAD_PID,
    randomToken: () => token,
    staleRace: "return",
    ...extra,
  };
}

function gateOptions(dir: string, busyTimeoutMs = 5_000): Pick<LockOptions, "mutationGate"> {
  return { mutationGate: { path: join(dir, ".mutation-gate.sqlite"), busyTimeoutMs } };
}

/** Leave a published lease whose fictional owner is dead. */
async function staleLease(path: string, extra: Partial<LockOptions> = {}): Promise<void> {
  expect(await acquireOwnerPrivateLock(lockOptions(path, "dead-owner", { ...extra, pid: DEAD_PID }))).toBeDefined();
}

async function ownerToken(path: string): Promise<string> {
  return (JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as { token: string }).token;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** Pause the first time `step` is reached; the returned controls resume it. */
function pauseAt(target: OwnerPrivateLockMutationStep): {
  readonly entered: Promise<void>;
  readonly resume: () => void;
  readonly steps: OwnerPrivateLockMutationStep[];
  readonly mutationStep: (step: OwnerPrivateLockMutationStep) => Promise<void>;
} {
  const entered = deferred();
  const gate = deferred();
  const steps: OwnerPrivateLockMutationStep[] = [];
  let paused = false;
  return {
    entered: entered.promise,
    resume: gate.resolve,
    steps,
    mutationStep: async (step) => {
      steps.push(step);
      if (step !== target || paused) return;
      paused = true;
      entered.resolve();
      await gate.promise;
    },
  };
}

function settledFlag<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return { settled: () => settled };
}

async function released(handles: readonly (OwnerPrivateLock | undefined)[]): Promise<void> {
  for (const handle of handles) await handle?.release();
}

describe("stale-reclaim race between the final check and the rename", () => {
  it("restores a fresh live lease that an ungated slow contender moved away", async () => {
    const dir = await directory("ungated-restore");
    const path = join(dir, "shared.lock");
    await staleLease(path);
    const slow = pauseAt("stale-verified");
    const slowAttempt = acquireOwnerPrivateLock(lockOptions(path, "slow-b", { mutationStep: slow.mutationStep }));
    await slow.entered;

    // The fast contender reclaims the same stale lease and publishes a live owner.
    const first = await acquireOwnerPrivateLock(lockOptions(path, "first-a"));
    expect(first).toBeDefined();
    slow.resume();

    // Before the fix the slow contender detached A's live lease and C then acquired too.
    await expect(slowAttempt).resolves.toBeUndefined();
    expect(slow.steps).toEqual(["stale-verified", "stale-detached"]);
    const third = await acquireOwnerPrivateLock(lockOptions(path, "third-c"));
    expect(third).toBeUndefined();
    expect(await ownerToken(path)).toBe("first-a");
    expect(await readdir(dir)).toEqual(["shared.lock"]);
    await first!.release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed and keeps both directories when the pathname is taken before restoration", async () => {
    const dir = await directory("restore-occupied");
    const path = join(dir, "shared.lock");
    await staleLease(path);
    const verified = pauseAt("stale-verified");
    const detached = deferred();
    const resumeDetached = deferred();
    const slowAttempt = acquireOwnerPrivateLock(lockOptions(path, "slow-b", {
      mutationStep: async (step) => {
        await verified.mutationStep(step);
        if (step === "stale-detached") {
          detached.resolve();
          await resumeDetached.promise;
        }
      },
    }));
    void slowAttempt.catch(() => undefined);
    await verified.entered;
    const first = await acquireOwnerPrivateLock(lockOptions(path, "first-a"));
    expect(first).toBeDefined();
    verified.resume();
    await detached.promise;
    // An ungated (older or not yet opted-in) contender takes the free pathname.
    const third = await acquireOwnerPrivateLock(lockOptions(path, "third-c"));
    expect(third).toBeDefined();
    resumeDetached.resolve();

    await expect(slowAttempt).rejects.toThrow(/could not move it back \(.* was taken again\); both paths were left untouched/u);
    expect(await ownerToken(path)).toBe("third-c");
    const retained = (await readdir(dir)).filter((name) => name.includes(".stale."));
    expect(retained).toHaveLength(1);
    expect(await ownerToken(join(dir, retained[0]!))).toBe("first-a");
    await expect(first!.release()).rejects.toThrow(/identity or owner changed before release/u);
    await third!.release();
  });

  it.each(["slow-first", "fast-first"] as const)(
    "keeps exactly one held handle with the gate when the slow contender pauses under it (%s release order)",
    async (order) => {
      const dir = await directory(`gated-${order}`);
      const path = join(dir, "shared.lock");
      await staleLease(path);
      const slow = pauseAt("stale-verified");
      const slowAttempt = acquireOwnerPrivateLock(lockOptions(path, "slow-b", {
        ...gateOptions(dir),
        mutationStep: slow.mutationStep,
      }));
      await slow.entered;

      const fastAttempt = acquireOwnerPrivateLock(lockOptions(path, "first-a", gateOptions(dir)));
      const fast = settledFlag(fastAttempt);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      // The fast contender cannot publish while the slow one holds the final check and rename.
      expect(fast.settled()).toBe(false);
      expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({ pid: DEAD_PID });
      slow.resume();

      const results = order === "slow-first"
        ? [await slowAttempt, await fastAttempt]
        : [await fastAttempt, await slowAttempt];
      const winners = results.filter((handle) => handle !== undefined);
      expect(winners).toHaveLength(1);
      const third = await acquireOwnerPrivateLock(lockOptions(path, "third-c", gateOptions(dir)));
      expect(third).toBeUndefined();
      expect(["slow-b", "first-a"]).toContain(await ownerToken(path));
      expect((await readdir(dir)).sort()).toEqual([".mutation-gate.sqlite", "shared.lock"]);
      await released(winners);
    },
  );

  it("rejects the slow contender's old observation once the fast contender wins the gate first", async () => {
    const dir = await directory("gated-inverse");
    const path = join(dir, "shared.lock");
    await staleLease(path);
    const before = deferred();
    const resume = deferred();
    const steps: OwnerPrivateLockMutationStep[] = [];
    const slowAttempt = acquireOwnerPrivateLock(lockOptions(path, "slow-b", {
      ...gateOptions(dir),
      beforeStaleRename: async () => { before.resolve(); await resume.promise; },
      mutationStep: (step) => { steps.push(step); },
    }));
    await before.promise;
    const first = await acquireOwnerPrivateLock(lockOptions(path, "first-a", gateOptions(dir)));
    expect(first).toBeDefined();
    resume.resolve();

    await expect(slowAttempt).resolves.toBeUndefined();
    // Its exact revalidation failed under the gate, so no rename ever ran.
    expect(steps).toEqual(["gate-acquired", "gate-acquired"]);
    await expect(acquireOwnerPrivateLock(lockOptions(path, "third-c", gateOptions(dir)))).resolves.toBeUndefined();
    expect(await ownerToken(path)).toBe("first-a");
    await first!.release();
  });
});

describe("restore-on-mismatch edge orderings", () => {
  it("restoring over a newcomer's still-empty directory is caught by the newcomer's identity checks", async () => {
    const dir = await directory("restore-empty");
    const path = join(dir, "shared.lock");
    await staleLease(path);
    const verified = pauseAt("stale-verified");
    const detached = deferred();
    const resumeDetached = deferred();
    const slowAttempt = acquireOwnerPrivateLock(lockOptions(path, "slow-b", {
      mutationStep: async (step) => {
        await verified.mutationStep(step);
        if (step === "stale-detached") { detached.resolve(); await resumeDetached.promise; }
      },
    }));
    const slowOutcome = slowAttempt.then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));
    await verified.entered;
    const first = await acquireOwnerPrivateLock(lockOptions(path, "first-a"));
    expect(first).toBeDefined();
    verified.resume();
    await detached.promise;

    // An ungated newcomer creates the free pathname and stalls before publishing its owner.
    const created = deferred();
    const resumeNewcomer = deferred();
    const newcomer = acquireOwnerPrivateLock(lockOptions(path, "newcomer-n", {
      afterDirectoryCreated: async () => { created.resolve(); await resumeNewcomer.promise; },
    }));
    const newcomerOutcome = newcomer.then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));
    await created.promise;
    resumeDetached.resolve();
    const slowResult = await slowOutcome;
    resumeNewcomer.resolve();
    const newcomerResult = await newcomerOutcome;

    if ("error" in slowResult) {
      // Platforms that refuse to replace an empty directory: the mover fails closed, nothing is overwritten.
      expect(slowResult.error.message).toMatch(/could not move it back \(.* was taken again\)/u);
      expect((await readdir(dir)).filter((name) => name.includes(".stale."))).toHaveLength(1);
    } else {
      // POSIX rename replaced the empty directory; the newcomer's identity check rejects its publication.
      expect(slowResult.value).toBeUndefined();
      expect("error" in newcomerResult && newcomerResult.error.message).toMatch(/directory identity changed/u);
      expect(await ownerToken(path)).toBe("first-a");
      await first!.release();
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps the owner's lease when a restore races that owner's release", async () => {
    const dir = await directory("restore-release");
    const path = join(dir, "shared.lock");
    await staleLease(path);
    const verified = pauseAt("stale-verified");
    const detached = deferred();
    const resumeDetached = deferred();
    const slowAttempt = acquireOwnerPrivateLock(lockOptions(path, "slow-b", {
      mutationStep: async (step) => {
        await verified.mutationStep(step);
        if (step === "stale-detached") { detached.resolve(); await resumeDetached.promise; }
      },
    }));
    await verified.entered;
    const releaseVerified = deferred();
    const resumeRelease = deferred();
    let pauseRelease = true;
    const first = await acquireOwnerPrivateLock(lockOptions(path, "first-a", {
      mutationStep: async (step) => {
        if (step !== "release-verified" || !pauseRelease) return;
        pauseRelease = false;
        releaseVerified.resolve();
        await resumeRelease.promise;
      },
    }));
    expect(first).toBeDefined();
    // A has verified its own lease for release; B now moves that lease away.
    const releasing = first!.release();
    void releasing.catch(() => undefined);
    await releaseVerified.promise;
    verified.resume();
    await detached.promise;
    resumeRelease.resolve();
    await expect(releasing).rejects.toThrow(/disappeared during release/u);
    resumeDetached.resolve();

    // B restores A's lease; A was never released, so a retry releases exactly it.
    await expect(slowAttempt).resolves.toBeUndefined();
    expect(await ownerToken(path)).toBe("first-a");
    await expect(acquireOwnerPrivateLock(lockOptions(path, "third-c"))).resolves.toBeUndefined();
    await first!.release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("restore-on-mismatch for release and failed-acquisition cleanup", () => {
  it("moves a replacement back when release detaches the wrong directory", async () => {
    const dir = await directory("release-restore");
    const path = join(dir, "shared.lock");
    const replacement = deferred();
    const held = await acquireOwnerPrivateLock(lockOptions(path, "original", {
      mutationStep: async (step) => {
        if (step !== "release-verified") return;
        await rename(path, join(dir, "moved-aside"));
        expect(await acquireOwnerPrivateLock(lockOptions(path, "replacement"))).toBeDefined();
        replacement.resolve();
      },
    }));

    await expect(held!.release()).rejects.toThrow(/changed across release; the replacement was moved back/u);
    await replacement.promise;
    expect(await ownerToken(path)).toBe("replacement");
    expect((await readdir(dir)).sort()).toEqual(["moved-aside", "shared.lock"]);
  });

  it("moves a replacement back when failed-acquisition cleanup detaches the wrong directory", async () => {
    const dir = await directory("abandon-restore");
    const path = join(dir, "shared.lock");
    let replacementIdentity: { dev: bigint; ino: bigint } | undefined;
    const attempt = acquireOwnerPrivateLock(lockOptions(path, "failing", {
      ownerFields: () => { throw new Error("injected publication failure"); },
      mutationStep: async (step) => {
        if (step !== "abandon-verified") return;
        await rename(path, join(dir, "moved-aside"));
        await mkdir(path, { mode: 0o700 });
        const details = await lstat(path, { bigint: true });
        replacementIdentity = { dev: details.dev, ino: details.ino };
      },
    }));

    await expect(attempt).rejects.toThrow(/acquisition and failed-acquisition cleanup both failed/u);
    const details = await lstat(path, { bigint: true });
    expect({ dev: details.dev, ino: details.ino }).toEqual(replacementIdentity);
  });
});

describe("owner-lock mutation gate", () => {
  it("creates one empty owner-only gate file and never writes or journals it", async () => {
    const dir = await directory("gate-create");
    const path = join(dir, "shared.lock");
    const held = await acquireOwnerPrivateLock(lockOptions(path, "owner", gateOptions(dir)));
    await held!.release();
    const gate = await lstat(join(dir, ".mutation-gate.sqlite"));
    expect(gate.isFile()).toBe(true);
    expect(gate.size).toBe(0);
    expect(gate.nlink).toBe(1);
    if (process.platform !== "win32") expect(gate.mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([".mutation-gate.sqlite"]);
  });

  it.skipIf(process.platform === "win32")("fails closed on an insecure gate without touching the lock path", async () => {
    const dir = await directory("gate-mode");
    const gatePath = join(dir, ".mutation-gate.sqlite");
    await writeFile(gatePath, "", { mode: 0o644 });
    const path = join(dir, "shared.lock");
    await expect(acquireOwnerPrivateLock(lockOptions(path, "owner", gateOptions(dir))))
      .rejects.toThrow(OwnerLockGateUnavailableError);
    await expect(acquireOwnerPrivateLock(lockOptions(path, "owner", gateOptions(dir))))
      .rejects.toThrow(/must be owner-only \(mode 0600\)/u);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked, hard-linked, directory or non-empty gate", async () => {
    const dir = await directory("gate-shape");
    const target = join(dir, "real-gate");
    await writeFile(target, "", { mode: 0o600 });
    const symlinked = join(dir, "symlinked.sqlite");
    await symlink(target, symlinked);
    const hardLinked = join(dir, "hard-linked.sqlite");
    await writeFile(hardLinked, "", { mode: 0o600 });
    await link(hardLinked, join(dir, "hard-linked-alias"));
    const asDirectory = join(dir, "directory.sqlite");
    await mkdir(asDirectory, { mode: 0o700 });
    const corrupt = join(dir, "corrupt.sqlite");
    await writeFile(corrupt, "not a gate database, fictional bytes\n", { mode: 0o600 });
    const run = (path: string) => withOwnerLockMutationGate({ path }, "Gate test", async () => "ran");

    await expect(run(symlinked)).rejects.toThrow(/must be a regular file, not a link or directory/u);
    await expect(run(hardLinked)).rejects.toThrow(/must have exactly one filesystem link/u);
    await expect(run(asDirectory)).rejects.toThrow(/must be a regular file/u);
    // Nothing ever writes the gate: any content is foreign, and the error names the repair without a path.
    const foreign = await run(corrupt).then(() => new Error("gate unexpectedly ran"), (error: unknown) => error as Error);
    expect(foreign).toBeInstanceOf(OwnerLockGateUnavailableError);
    expect(foreign.message).toMatch(/mutation gate is not empty; .*Stop every mono-agent process for this account, then remove the gate file/u);
    expect(foreign.message).not.toContain(dir);
  });

  it("fails closed when a journal or WAL file sits beside the gate", async () => {
    const dir = await directory("gate-sidecar");
    for (const suffix of ["-journal", "-wal"]) {
      const path = join(dir, `gate${suffix}-case.sqlite`);
      await writeFile(`${path}${suffix}`, "fictional leftover", { mode: 0o600 });
      let ran = false;
      const error = await withOwnerLockMutationGate({ path }, "Gate test", async () => { ran = true; })
        .then(() => new Error("gate unexpectedly ran"), (caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(OwnerLockGateUnavailableError);
      expect(error.message).toContain(`has an unexpected ${suffix.slice(1)} file beside it`);
      expect(error.message).toContain(`remove the gate file and its ${suffix} file`);
      expect(error.message).not.toContain(dir);
      expect(ran).toBe(false);
    }
  });

  it("rejects a gate whose inode is replaced between open and lock", async () => {
    const dir = await directory("gate-replaced");
    const path = join(dir, ".mutation-gate.sqlite");
    let ran = false;
    await expect(withOwnerLockMutationGate({
      path,
      beforeLock: async () => {
        await rename(path, join(dir, "displaced.sqlite"));
        await (await open(path, "wx", 0o600)).close();
      },
    }, "Gate test", async () => { ran = true; })).rejects.toThrow(/was replaced while it was opened/u);
    expect(ran).toBe(false);
  });

  it("raises the distinct busy error when the in-process holder keeps the gate past the deadline", async () => {
    const dir = await directory("gate-busy-local");
    const path = join(dir, ".mutation-gate.sqlite");
    const hold = deferred();
    const entered = deferred();
    const holder = withOwnerLockMutationGate({ path }, "Gate test", async () => {
      entered.resolve();
      await hold.promise;
    });
    await entered.promise;
    await expect(withOwnerLockMutationGate({ path, busyTimeoutMs: 50 }, "Gate test", async () => "ran"))
      .rejects.toThrow(OwnerLockCoordinationBusyError);
    hold.resolve();
    await holder;
    await expect(withOwnerLockMutationGate({ path, busyTimeoutMs: 0 }, "Gate test", async () => "ran"))
      .resolves.toBe("ran");
  });

  it("excludes across processes with node:sqlite BEGIN EXCLUSIVE on the empty file, and frees on exit or kill", async () => {
    const dir = await directory("gate-processes");
    const path = join(dir, ".mutation-gate.sqlite");
    await (await open(path, "wx", 0o600)).close();
    const tryGate = async (): Promise<string> => await withOwnerLockMutationGate({ path, busyTimeoutMs: 0 }, "Gate test", async () => "acquired")
      .catch((error: unknown) => error instanceof OwnerLockCoordinationBusyError ? "busy" : Promise.reject(error));

    const released = rawGateHolder(path);
    await released.line("held");
    expect(await tryGate()).toBe("busy");
    released.child.stdin.write("release\n");
    await released.line("released");
    expect(await tryGate()).toBe("acquired");

    const killed = rawGateHolder(path);
    await killed.line("held");
    expect(await tryGate()).toBe("busy");
    killed.child.kill("SIGKILL");
    await killed.exited;
    expect(await tryGate()).toBe("acquired");
    expect((await lstat(path)).size).toBe(0);
    expect(await readdir(dir)).toEqual([".mutation-gate.sqlite"]);
  });

  it("gives an opted-in acquirer the distinct busy error while another process holds the gate", async () => {
    const dir = await directory("gate-busy-process");
    const path = join(dir, "shared.lock");
    const gatePath = join(dir, ".mutation-gate.sqlite");
    await (await open(gatePath, "wx", 0o600)).close();
    const holder = rawGateHolder(gatePath);
    await holder.line("held");
    await expect(acquireOwnerPrivateLock(lockOptions(path, "owner", gateOptions(dir, 150))))
      .rejects.toThrow(OwnerLockCoordinationBusyError);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    holder.child.kill("SIGKILL");
    await holder.exited;
    const held = await acquireOwnerPrivateLock(lockOptions(path, "owner", gateOptions(dir, 2_000)));
    expect(held).toBeDefined();
    await held!.release();
  });
});

describe("mutation gate wait budget", () => {
  it("never waits on the gate past the caller's own acquisition wait", async () => {
    const dir = await directory("gate-budget");
    const gatePath = join(dir, ".mutation-gate.sqlite");
    await (await open(gatePath, "wx", 0o600)).close();
    const holder = rawGateHolder(gatePath);
    await holder.line("held");
    const started = performance.now();
    await expect(acquireOwnerPrivateLock(lockOptions(join(dir, "shared.lock"), "owner", {
      mutationGate: { path: gatePath, busyTimeoutMs: 5_000 },
      waitTimeoutMs: 300,
      pollIntervalMs: 10,
    }))).rejects.toThrow(OwnerLockCoordinationBusyError);
    // Clamped to the 300 ms acquisition budget, not the 5 s gate timeout.
    expect(performance.now() - started).toBeLessThan(2_500);
    holder.child.kill("SIGKILL");
    await holder.exited;
  });
});

describe("killed gate holders", () => {
  const cases: ReadonlyArray<{ readonly step: string; readonly stale: boolean; readonly release: boolean }> = [
    { step: "gate-acquired", stale: false, release: false },
    { step: "directory-created", stale: false, release: false },
    { step: "stale-verified", stale: true, release: false },
    { step: "stale-detached", stale: true, release: false },
    { step: "release-verified", stale: false, release: true },
    { step: "release-detached", stale: false, release: true },
  ];

  it.each(cases)("lets another process acquire after the holder is killed at $step", async ({ step, stale, release }) => {
    const dir = await directory(`kill-${step}`);
    const path = join(dir, "shared.lock");
    if (stale) await staleLease(path, gateOptions(dir));
    const child = lockChild(path, dir, step, release);
    await child.line(`paused:${step}`);
    child.child.kill("SIGKILL");
    await child.exited;

    const recovered = await acquireOwnerPrivateLock(lockOptions(path, "recovered", {
      ...gateOptions(dir, 2_000),
      ownerlessGraceMs: 0,
      isSameProcessIncarnation: async (pid) => pid !== DEAD_PID && processExists(pid),
    }));
    expect(recovered).toBeDefined();
    expect(await ownerToken(path)).toBe("recovered");
    await recovered!.release();
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface ScriptChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly line: (expected: string) => Promise<void>;
  readonly exited: Promise<void>;
}

function script(source: string): ScriptChild {
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", source], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  const listeners = new Set<() => void>();
  child.stdout.on("data", (chunk) => { stdout += String(chunk); for (const listener of listeners) listener(); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => {
    for (const listener of listeners) listener();
    resolvePromise();
  }));
  let exitedFlag = false;
  void exited.then(() => { exitedFlag = true; });
  return {
    child,
    exited,
    line: async (expected) => await new Promise<void>((resolvePromise, rejectPromise) => {
      const check = (): void => {
        if (stdout.split("\n").includes(expected)) {
          listeners.delete(check);
          resolvePromise();
        } else if (exitedFlag || child.exitCode !== null || child.signalCode !== null) {
          listeners.delete(check);
          rejectPromise(new Error(`child exited before "${expected}": ${stderr || stdout}`));
        }
      };
      listeners.add(check);
      check();
    }),
  };
}

function rawGateHolder(path: string): ScriptChild {
  return script(`
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 0 });
    db.exec("PRAGMA journal_mode=MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    process.stdout.write("held\\n");
    process.stdin.once("data", () => {
      db.exec("ROLLBACK");
      db.close();
      process.stdout.write("released\\n");
      setTimeout(() => process.exit(0), 20);
    });
  `);
}

function lockChild(path: string, dir: string, step: string, release: boolean): ScriptChild {
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist/durable-state/owner-private-lock.js")).href;
  return script(`
    import { acquireOwnerPrivateLock } from ${JSON.stringify(moduleUrl)};
    const step = ${JSON.stringify(step)};
    const release = ${JSON.stringify(release)};
    const pause = async (reached) => {
      if (reached !== step) return;
      process.stdout.write("paused:" + reached + "\\n");
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    };
    const held = await acquireOwnerPrivateLock({
      path: ${JSON.stringify(path)},
      label: "Race test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: ${JSON.stringify(incarnation)},
      isSameProcessIncarnation: async (pid) => pid !== ${DEAD_PID},
      randomToken: () => "killed-holder",
      staleRace: "return",
      mutationGate: { path: ${JSON.stringify(join(dir, ".mutation-gate.sqlite"))}, busyTimeoutMs: 2000 },
      afterDirectoryCreated: () => pause("directory-created"),
      mutationStep: (reached) => release ? (reached.startsWith("release-") ? pause(reached) : undefined) : pause(reached),
    });
    if (held === undefined) throw new Error("child did not acquire");
    if (release) await held.release();
    process.stdout.write("finished\\n");
  `);
}

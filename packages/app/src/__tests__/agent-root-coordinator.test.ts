import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const processIdentity = vi.hoisted(() => ({
  current: {
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-parent",
  },
}));

vi.mock("@mono-agent/conversation/process-incarnation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mono-agent/conversation/process-incarnation")>(),
  currentProcessIncarnation: async () => processIdentity.current,
  isSameProcessIncarnation: (pid: number) => processExists(pid),
  isProcessIncarnationLive: (pid: number) => processExists(pid),
}));

import {
  AGENT_ROOT_COORDINATION_BUSY_ERROR,
  AGENT_ROOT_LEASE_MUTATION_GATE,
  AGENT_ROOT_OWNED_ELSEWHERE_ERROR,
  AGENT_ROOT_WORKSPACE_REQUIRED_ERROR,
  PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_ERROR,
  agentRootLeaseOwnerFields,
  agentRootLeasePath,
  acquireAgentRootOwnership,
  assertAgentRootLeaseOutsideWorkspace,
  releaseAgentRootOwnershipWhenIdle,
} from "../durable-state/agent-root-coordinator.js";
import { acquireOwnerPrivateLock } from "../durable-state/owner-private-lock.js";
import { OwnerLockGateUnavailableError } from "../durable-state/owner-lock-mutation-gate.js";

const temporaryDirectories: string[] = [];
const scriptChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of scriptChildren.splice(0)) child.kill("SIGKILL");
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("agent-root cooperative ownership", () => {
  it("keeps a single process-global owner until every reentrant reference releases", async () => {
    const { root, home } = await roots("refcount");
    const first = await acquireAgentRootOwnership(root, { homeDir: home });
    const second = await acquireAgentRootOwnership(root, { homeDir: home });

    first.release();
    await expect(childAttempt(root, home)).resolves.toBe("conflict");

    second.release();
    await expect(eventuallyChildAcquires(root, home)).resolves.toBeUndefined();
  });

  it("serializes a real official child and recovers its stale lock after crash; this is cooperative, not hostile same-UID resistance", async () => {
    const { root, home } = await roots("child-crash");
    const child = spawnHolder(root, home);
    await child.ready;
    try {
      await expect(acquireAgentRootOwnership(root, { homeDir: home })).rejects.toThrow(
        AGENT_ROOT_OWNED_ELSEWHERE_ERROR,
      );
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }

    const recovered = await acquireAgentRootOwnership(root, { homeDir: home });
    recovered.release();
    await waitForLeaseRelease(root, home);
  });

  it("defers physical release until a true-settlement lease finishes", async () => {
    const { root, home } = await roots("settlement");
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home });
    const generation = { id: "generation-a", rootKeys: [".state/a"] } as const;
    ownership.coordinator.publishGeneration(generation);
    const request = ownership.coordinator.acquireRequestLease(generation);

    await expect(releaseAgentRootOwnershipWhenIdle(ownership)).resolves.toBe(false);
    await expect(childAttempt(root, home)).resolves.toBe("conflict");

    request.releaseAfterSettlement();
    await expect(eventuallyChildAcquires(root, home)).resolves.toBeUndefined();
  });

  it("awaits the physical lease removal for an idle final owner", async () => {
    const { root, home } = await roots("idle-release");
    let enterRelease!: () => void;
    let finishRelease!: () => void;
    const releaseEntered = new Promise<void>((resolvePromise) => { enterRelease = resolvePromise; });
    const releaseGate = new Promise<void>((resolvePromise) => { finishRelease = resolvePromise; });
    const ownership = await acquireAgentRootOwnership(root, {
      homeDir: home,
      hooks: {
        beforeLeaseRelease: async () => {
          enterRelease();
          await releaseGate;
        },
      },
    });

    const releasing = releaseAgentRootOwnershipWhenIdle(ownership);
    await releaseEntered;
    await expect(childAttempt(root, home)).resolves.toBe("conflict");

    finishRelease();
    await expect(releasing).resolves.toBe(true);
    await expect(childAttempt(root, home)).resolves.toBe("owned");
  });

  it("times out an incompatible generation mutation without creating the new secret root", async () => {
    const { root, home } = await roots("mutation-timeout");
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home });
    const first = { id: "generation-a", rootKeys: [".state/a"] } as const;
    const next = { id: "generation-b", rootKeys: [".state/a", ".state/b"] } as const;
    ownership.coordinator.publishGeneration(first);
    const request = ownership.coordinator.acquireRequestLease(first);
    const unopenedSecret = join(root, ".state", "b", "secret.json");

    await expect(ownership.coordinator.publishAndAcquireMutationGate(next, ".state/b", {
      timeoutMs: 5,
    })).rejects.toThrow(PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_ERROR);
    await expect(stat(unopenedSecret)).rejects.toMatchObject({ code: "ENOENT" });

    request.releaseAfterSettlement();
    ownership.release();
    await waitForLeaseRelease(root, home);
  });

  it("turns a physical release failure into one deterministic in-process refusal", async () => {
    const { root, home } = await roots("release-failure");
    const beforeLeaseRelease = vi.fn(async () => {
      throw new Error("injected release failure");
    });
    const ownership = await acquireAgentRootOwnership(root, {
      homeDir: home,
      hooks: { beforeLeaseRelease },
    });
    ownership.release();

    const expected = "Mono-agent could not safely release ownership of this agent root. Restart the local process before retrying.";
    await expect(acquireAgentRootOwnership(root, { homeDir: home })).rejects.toThrow(expected);
    await expect(acquireAgentRootOwnership(root, { homeDir: home })).rejects.toThrow(expected);
    expect(beforeLeaseRelease).toHaveBeenCalledOnce();
  });

  it("fails closed with actionable runtime.workspace guidance when the configured directory is absent", async () => {
    const { root, home } = await roots("missing-workspace");
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home });
    const missingWorkspace = join(root, "missing-workspace");

    expect(() => assertAgentRootLeaseOutsideWorkspace(ownership, missingWorkspace)).toThrow(
      AGENT_ROOT_WORKSPACE_REQUIRED_ERROR,
    );
    await expect(lstat(missingWorkspace)).rejects.toMatchObject({ code: "ENOENT" });

    ownership.release();
    await waitForLeaseRelease(root, home);
  });
});

describe("agent-root lease mutation gate", () => {
  it("publishes a bounded agentRoot in new records and keeps accepting legacy records", async () => {
    const { root, home } = await roots("record");
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home });
    const leasePath = agentRootLeasePath(ownership.agentRoot, home);
    const bytes = await readFile(join(leasePath, "owner.json"));
    expect(bytes.byteLength).toBeLessThanOrEqual(3 * 1024);
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
      schema: "mono-agent.agent-root-lease.v1",
      rootDigest: digestOf(ownership.agentRoot),
      agentRoot: ownership.agentRoot,
      pid: process.pid,
    });
    const gate = await lstat(join(dirname(leasePath), AGENT_ROOT_LEASE_MUTATION_GATE));
    expect(gate.isFile() && gate.size === 0 && gate.nlink === 1).toBe(true);
    expect(await releaseAgentRootOwnershipWhenIdle(ownership)).toBe(true);

    // A legacy record (no agentRoot) held by a live PID still conflicts.
    await writeLegacyLease(leasePath, ownership.agentRoot, process.pid);
    await expect(acquireAgentRootOwnership(root, { homeDir: home })).rejects.toThrow(AGENT_ROOT_OWNED_ELSEWHERE_ERROR);
    await rm(leasePath, { recursive: true });

    // A legacy record whose owner is dead is reclaimed and rewritten in the new format.
    await writeLegacyLease(leasePath, ownership.agentRoot, 2_147_480_002);
    const reclaimed = await acquireAgentRootOwnership(root, { homeDir: home });
    expect(JSON.parse(await readFile(join(leasePath, "owner.json"), "utf8"))).toMatchObject({
      agentRoot: ownership.agentRoot,
      pid: process.pid,
    });
    expect(await releaseAgentRootOwnershipWhenIdle(reclaimed)).toBe(true);
    await waitForLeaseRelease(root, home);
  });

  it("keeps a new live record held for an older reader that ignores agentRoot", async () => {
    const { root, home } = await roots("old-reader");
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home });
    const leasePath = agentRootLeasePath(ownership.agentRoot, home);
    const digest = digestOf(ownership.agentRoot);
    // The pre-gate acquisition protocol: no gate, rootDigest-only validation.
    await expect(acquireOwnerPrivateLock({
      path: leasePath,
      label: "Agent-root lease",
      schemaTag: "mono-agent.agent-root-lease.v1",
      ownerlessGraceMs: 5 * 60_000,
      maxAcquireAttempts: 4,
      ownerFields: () => ({ rootDigest: digest }),
      validateOwnerFields: (record) => record.rootDigest === digest,
      invalidOwner: "error",
      livenessError: () => "assume-live",
      staleRace: "return",
    })).resolves.toBeUndefined();
    expect(await releaseAgentRootOwnershipWhenIdle(ownership)).toBe(true);
  });

  it("omits agentRoot when the whole record would exceed 3 KiB", () => {
    const base = {
      schema: "mono-agent.agent-root-lease.v1",
      pid: 4242,
      token: "fictional-token",
      createdAt: new Date(0).toISOString(),
      incarnation: { schema: "mono-agent.process-incarnation.v1", bootSessionId: "boot", processStartId: "start" },
    };
    expect(agentRootLeaseOwnerFields(base, "a".repeat(64), "/fictional/agent")).toEqual({
      rootDigest: "a".repeat(64),
      agentRoot: "/fictional/agent",
    });
    // Control characters expand six-fold in JSON, so a legal path can exceed the bound.
    const escaped = `/fictional/${"\u0001".repeat(600)}`;
    expect(agentRootLeaseOwnerFields(base, "a".repeat(64), escaped)).toEqual({ rootDigest: "a".repeat(64) });
  });

  it("reports coordination busy, not owned elsewhere, while another process holds the gate", async () => {
    const { root, home } = await roots("gate-busy");
    const leaseRoot = join(home, ".mono-agent", "agent-root-leases");
    await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
    const gatePath = join(leaseRoot, AGENT_ROOT_LEASE_MUTATION_GATE);
    await (await open(gatePath, "wx", 0o600)).close();
    const holder = script(`
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(gatePath)}, { timeout: 0 });
      db.exec("PRAGMA journal_mode=MEMORY");
      db.exec("BEGIN EXCLUSIVE");
      process.stdout.write("held\\n");
      setInterval(() => {}, 60_000);
    `);
    await holder.line("held");
    const attempt = acquireAgentRootOwnership(root, { homeDir: home, mutationGateBusyTimeoutMs: 100 });
    await expect(attempt).rejects.toThrow(AGENT_ROOT_COORDINATION_BUSY_ERROR);
    await expect(attempt).rejects.not.toThrow(AGENT_ROOT_OWNED_ELSEWHERE_ERROR);
    holder.child.kill("SIGKILL");
    await holder.exited;
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home });
    expect(await releaseAgentRootOwnershipWhenIdle(ownership)).toBe(true);
  });

  it("retries a release that met a busy gate instead of closing the coordinator", async () => {
    const { root, home } = await roots("gate-busy-release");
    const ownership = await acquireAgentRootOwnership(root, { homeDir: home, mutationGateBusyTimeoutMs: 300 });
    const leasePath = agentRootLeasePath(ownership.agentRoot, home);
    const gatePath = join(dirname(leasePath), AGENT_ROOT_LEASE_MUTATION_GATE);
    const holder = script(`
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(gatePath)}, { timeout: 0 });
      db.exec("PRAGMA journal_mode=MEMORY");
      db.exec("BEGIN EXCLUSIVE");
      process.stdout.write("held\\n");
      process.stdin.once("data", () => { db.exec("ROLLBACK"); db.close(); process.exit(0); });
    `);
    await holder.line("held");
    const releasing = releaseAgentRootOwnershipWhenIdle(ownership);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
    holder.child.stdin.write("release\n");
    await holder.exited;
    await expect(releasing).resolves.toBe(true);
    await waitForLeaseRelease(root, home);
    const again = await acquireAgentRootOwnership(root, { homeDir: home });
    expect(await releaseAgentRootOwnershipWhenIdle(again)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("fails closed on an insecure gate instead of acquiring unguarded", async () => {
    const { root, home } = await roots("gate-insecure");
    const leaseRoot = join(home, ".mono-agent", "agent-root-leases");
    await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(leaseRoot, AGENT_ROOT_LEASE_MUTATION_GATE), "", { mode: 0o644 });
    const error = await acquireAgentRootOwnership(root, { homeDir: home }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("could not establish private ownership");
    expect((error as Error).cause).toBeInstanceOf(OwnerLockGateUnavailableError);
    expect(await readdir(leaseRoot)).toEqual([AGENT_ROOT_LEASE_MUTATION_GATE]);
  });

  it("keeps one owner when a slow reclaiming process pauses between its final check and rename", async () => {
    const { root, home } = await roots("gate-interleave");
    await killedHolder(root, home);
    const slow = agentChild(root, home, { pauseAt: "stale-verified" });
    await slow.line("paused");

    const fastAttempt = acquireAgentRootOwnership(root, { homeDir: home, mutationGateBusyTimeoutMs: 5_000 });
    let fastSettled = false;
    void fastAttempt.then(() => { fastSettled = true; }, () => { fastSettled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(fastSettled).toBe(false);
    slow.child.stdin.write("resume\n");

    const fast = await fastAttempt.then((ownership) => ownership, (error: unknown) => {
      expect(String(error)).toContain(AGENT_ROOT_OWNED_ELSEWHERE_ERROR);
      return undefined;
    });
    const slowOutcome = await slow.outcome;
    expect([fast !== undefined, slowOutcome === "owned"].filter(Boolean)).toHaveLength(1);
    await expect(childAttempt(root, home)).resolves.toBe("conflict");

    if (fast !== undefined) expect(await releaseAgentRootOwnershipWhenIdle(fast)).toBe(true);
    else {
      slow.child.stdin.write("exit\n");
      await slow.exited;
    }
    await waitForLeaseRelease(root, home);
  });

  it("elects exactly one winner among barrier-started processes after a killed holder, repeatedly", async () => {
    const { root, home } = await roots("gate-stress");
    const rounds = 3;
    const contenders = 6;
    for (let round = 0; round < rounds; round += 1) {
      await killedHolder(root, home);
      const racers = Array.from({ length: contenders }, () => agentChild(root, home, { barrier: true }));
      await Promise.all(racers.map(async (racer) => await racer.line("ready")));
      for (const racer of racers) racer.child.stdin.write("go\n");
      const outcomes = await Promise.all(racers.map(async (racer) => await racer.outcome));
      expect(outcomes.filter((outcome) => outcome === "error")).toEqual([]);
      expect(outcomes.filter((outcome) => outcome === "owned")).toHaveLength(1);
      const winner = racers[outcomes.indexOf("owned")]!;
      const leasePath = agentRootLeasePath(await canonical(root), home);
      expect(JSON.parse(await readFile(join(leasePath, "owner.json"), "utf8"))).toMatchObject({ pid: winner.child.pid });
      // A third contender after the race still conflicts with the single winner.
      await expect(childAttempt(root, home)).resolves.toBe("conflict");
      winner.child.stdin.write("exit\n");
      await Promise.all(racers.map(async (racer) => await racer.exited));
    }
    await waitForLeaseRelease(root, home);
  }, 60_000);
});

function digestOf(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex");
}

async function canonical(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return await realpath(path);
}

async function writeLegacyLease(leasePath: string, canonicalRoot: string, pid: number): Promise<void> {
  expect(basename(leasePath)).toBe(`${digestOf(canonicalRoot)}.lease`);
  await mkdir(leasePath, { mode: 0o700 });
  await writeFile(join(leasePath, "owner.json"), `${JSON.stringify({
    rootDigest: digestOf(canonicalRoot),
    schema: "mono-agent.agent-root-lease.v1",
    pid,
    token: "legacy-owner",
    createdAt: new Date(0).toISOString(),
    incarnation: processIdentity.current,
  })}\n`, { mode: 0o600 });
}

/** Acquire in a real child, then SIGKILL it so its lease is left stale. */
async function killedHolder(root: string, home: string): Promise<void> {
  const holder = agentChild(root, home, {});
  await expect(holder.outcome).resolves.toBe("owned");
  holder.child.kill("SIGKILL");
  await holder.exited;
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
  scriptChildren.push(child);
  let stdout = "";
  let stderr = "";
  let exited = false;
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of [...listeners]) listener(); };
  child.stdout.on("data", (chunk) => { stdout += String(chunk); notify(); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitedPromise = new Promise<void>((resolvePromise) => child.once("exit", () => {
    exited = true;
    notify();
    resolvePromise();
  }));
  return {
    child,
    exited: exitedPromise,
    line: async (expected) => await new Promise<void>((resolvePromise, rejectPromise) => {
      const check = (): void => {
        if (stdout.split("\n").includes(expected)) {
          listeners.delete(check);
          resolvePromise();
        } else if (exited) {
          listeners.delete(check);
          rejectPromise(new Error(`child exited before "${expected}": ${stderr || stdout}`));
        }
      };
      listeners.add(check);
      check();
    }),
  };
}

type AgentChildOutcome = "owned" | "conflict" | "busy" | "error";

function agentChild(root: string, home: string, options: { readonly pauseAt?: string; readonly barrier?: boolean }): ScriptChild & {
  readonly outcome: Promise<AgentChildOutcome>;
} {
  const child = script(`
    import { acquireAgentRootOwnership, releaseAgentRootOwnershipWhenIdle } from ${JSON.stringify(coordinatorModuleUrl())};
    let input = "";
    const waiters = [];
    process.stdin.on("data", (chunk) => {
      input += String(chunk);
      for (const waiter of [...waiters]) waiter();
    });
    const waitFor = (word) => new Promise((resolvePromise) => {
      const check = () => {
        if (!input.split("\\n").includes(word)) return;
        waiters.splice(waiters.indexOf(check), 1);
        resolvePromise();
      };
      waiters.push(check);
      check();
    });
    const processIncarnation = {
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: "test-boot",
      processStartId: "agent-child-" + String(process.pid),
    };
    const isSameProcessIncarnation = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return error?.code === "EPERM"; }
    };
    const pauseAt = ${JSON.stringify(options.pauseAt ?? null)};
    let paused = false;
    if (${JSON.stringify(options.barrier === true)}) {
      process.stdout.write("ready\\n");
      await waitFor("go");
    }
    let ownership;
    try {
      ownership = await acquireAgentRootOwnership(${JSON.stringify(root)}, {
        homeDir: ${JSON.stringify(home)}, processIncarnation, isSameProcessIncarnation,
        mutationGateBusyTimeoutMs: 5000,
        hooks: {
          leaseMutationStep: async (step) => {
            if (step !== pauseAt || paused) return;
            paused = true;
            process.stdout.write("paused\\n");
            await waitFor("resume");
          },
        },
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes("already using this agent root")) process.stdout.write("conflict\\n");
      else if (message.includes("updating agent-root ownership")) process.stdout.write("busy\\n");
      else { process.stderr.write(String(error?.stack ?? error)); process.stdout.write("error\\n"); }
      process.exit(0);
    }
    process.stdout.write("owned\\n");
    setInterval(() => {}, 60_000);
    await waitFor("exit");
    await releaseAgentRootOwnershipWhenIdle(ownership);
    process.exit(0);
  `);
  const outcome = Promise.race((["owned", "conflict", "busy", "error"] as const).map(async (word) => {
    await child.line(word);
    return word;
  }));
  void outcome.catch(() => undefined);
  return { ...child, outcome };
}

async function roots(label: string): Promise<{ root: string; home: string }> {
  const parent = await mkdtemp(join(tmpdir(), `mono-agent-root-${label}-`));
  temporaryDirectories.push(parent);
  const root = join(parent, "agent");
  const home = join(parent, "home");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
  ]);
  return { root, home };
}

async function waitForLeaseRelease(root: string, home: string): Promise<void> {
  const leasePath = agentRootLeasePath(root, home);
  await vi.waitFor(async () => {
    await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    // The mutation gate is a permanent coordination file, never lease garbage.
    expect((await readdir(dirname(leasePath))).filter((name) => name !== AGENT_ROOT_LEASE_MUTATION_GATE)).toEqual([]);
  }, { timeout: 2_000, interval: 10 });
}

function coordinatorModuleUrl(): string {
  return pathToFileURL(join(process.cwd(), "dist/durable-state/agent-root-coordinator.js")).href;
}

async function childAttempt(root: string, home: string): Promise<"owned" | "conflict"> {
  const source = `
    import { acquireAgentRootOwnership } from ${JSON.stringify(coordinatorModuleUrl())};
    const processIncarnation = {
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: "test-boot",
      processStartId: "child-attempt-" + String(process.pid),
    };
    const isSameProcessIncarnation = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return error?.code === "EPERM"; }
    };
    try {
      const ownership = await acquireAgentRootOwnership(${JSON.stringify(root)}, {
        homeDir: ${JSON.stringify(home)}, processIncarnation, isSameProcessIncarnation,
      });
      process.stdout.write("owned\\n");
      ownership.release();
    } catch (error) {
      if (error instanceof Error && error.message.includes("already using this agent root")) {
        process.stdout.write("conflict\\n");
      } else {
        process.stderr.write(String(error?.stack ?? error));
        process.exitCode = 1;
      }
    }
  `;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code !== 0) rejectPromise(new Error(stderr || `child exited ${String(code)}`));
      else if (stdout.trim() === "owned") resolvePromise("owned");
      else if (stdout.trim() === "conflict") resolvePromise("conflict");
      else rejectPromise(new Error(`unexpected child output: ${stdout}`));
    });
  });
}

async function eventuallyChildAcquires(root: string, home: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await childAttempt(root, home)).toBe("owned");
  }, { timeout: 5_000, interval: 25 });
}

function spawnHolder(root: string, home: string): {
  process: ReturnType<typeof spawn>;
  ready: Promise<void>;
  exited: Promise<void>;
} {
  const source = `
    import { acquireAgentRootOwnership } from ${JSON.stringify(coordinatorModuleUrl())};
    const processIncarnation = {
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: "test-boot",
      processStartId: "child-holder-" + String(process.pid),
    };
    const isSameProcessIncarnation = (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return error?.code === "EPERM"; }
    };
    await acquireAgentRootOwnership(${JSON.stringify(root)}, {
      homeDir: ${JSON.stringify(home)}, processIncarnation, isSameProcessIncarnation,
    });
    setInterval(() => {}, 60_000);
    process.stdout.write("ready\\n");
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.stdout.once("data", (chunk) => {
      if (String(chunk).includes("ready")) resolvePromise();
      else rejectPromise(new Error(`holder did not become ready: ${String(chunk)}`));
    });
    child.once("exit", (code) => rejectPromise(new Error(stderr || `holder exited ${String(code)}`)));
  });
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  return { process: child, ready, exited };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

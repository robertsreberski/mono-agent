import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const processIdentity = vi.hoisted(() => ({
  current: {
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-parent",
  },
}));

vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => processIdentity.current,
  isSameProcessIncarnation: (pid: number) => processExists(pid),
}));

import {
  AGENT_ROOT_OWNED_ELSEWHERE_ERROR,
  AGENT_ROOT_WORKSPACE_REQUIRED_ERROR,
  PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_ERROR,
  agentRootLeasePath,
  acquireAgentRootOwnership,
  assertAgentRootLeaseOutsideWorkspace,
  releaseAgentRootOwnershipWhenIdle,
} from "../agent-root-coordinator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    await expect(readdir(dirname(leasePath))).resolves.toEqual([]);
  }, { timeout: 2_000, interval: 10 });
}

function coordinatorModuleUrl(): string {
  return pathToFileURL(join(process.cwd(), "dist/agent-root-coordinator.js")).href;
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

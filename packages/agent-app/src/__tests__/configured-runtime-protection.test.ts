import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";

const runtimeState = vi.hoisted(() => ({
  run: vi.fn(),
  disposeAllSessions: vi.fn(async () => undefined),
}));
const processIdentity = vi.hoisted(() => ({
  current: {
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-configured-runtime",
  },
}));

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mono-agent/runtime-adapter")>(),
  createMonoRuntime: () => ({
    run: runtimeState.run,
    disposeAllSessions: runtimeState.disposeAllSessions,
  }),
}));

vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => processIdentity.current,
  isSameProcessIncarnation: (pid: number) => processExists(pid),
}));

const { createConfiguredAgentRuntime } = await import("../index.js");
const {
  AGENT_ROOT_REQUIRED_ERROR,
  agentRootLeasePath,
  acquireAgentRootOwnership,
} = await import("../agent-root-coordinator.js");
const { PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR } = await import("../process-jobs-runtime.js");
const {
  loadProcessJobsRootRegistryProtection,
  registerProcessJobsRoot,
} = await import("../process-jobs-root-registry.js");

const PI_MODEL = {
  sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol",
  reference: "pi:openai-codex:gpt-5.6-sol",
} as const;
const CLAUDE_MODEL = {
  sdk: "claude", model: "claude-opus-4-8", reference: "claude:claude-opus-4-8",
} as const;
const sandboxEngine = {
  id: "configured-runtime-protection-test",
  async isAvailable() { return true; },
  async prepareCommand(command: unknown) { return command; },
} as never;

const temporaryDirectories: string[] = [];
const ownerships: Array<{
  ownership: { release(): void };
  leasePath: string;
}> = [];

afterEach(async () => {
  const held = ownerships.splice(0);
  for (const { ownership } of held) ownership.release();
  await Promise.all(held.map(async ({ leasePath }) => {
    await vi.waitFor(async () => {
      await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 2_000, interval: 10 });
  }));
  runtimeState.run.mockReset();
  runtimeState.disposeAllSessions.mockReset();
  runtimeState.disposeAllSessions.mockResolvedValue(undefined);
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("public configured raw runtime protection", () => {
  it("constructs lazily but rejects run before provider work when agent-root cwd is omitted", async () => {
    const fixture = await runtimeFixture("required-root");
    const runtime = createConfiguredAgentRuntime(configFor(fixture.root, fixture.workspace));

    expect(runtimeState.run).not.toHaveBeenCalled();
    await expect(runtime.run("system", runOptions(CLAUDE_MODEL, fixture.workspace))).rejects.toThrow(
      AGENT_ROOT_REQUIRED_ERROR,
    );
    expect(runtimeState.run).not.toHaveBeenCalled();
  });

  it("preserves a legitimate non-Pi raw runtime while the durable registry is empty", async () => {
    const fixture = await runtimeFixture("empty-registry");
    const owner = await seededOwnership(fixture);
    runtimeState.run.mockResolvedValue({ text: "legitimate non-pi result" });
    const runtime = createConfiguredAgentRuntime({
      config: configFor(fixture.root, fixture.workspace),
      cwd: fixture.root,
    });

    await expect(runtime.run("system", runOptions(CLAUDE_MODEL, fixture.workspace))).resolves.toMatchObject({
      text: "legitimate non-pi result",
    });
    expect(runtimeState.run).toHaveBeenCalledOnce();
    await runtime.disposeAllSessions?.();
    owner.release();
  });

  it("rejects a non-Pi raw runtime against retained private roots before provider invocation", async () => {
    const fixture = await runtimeFixture("non-pi-sealed");
    const owner = await seededOwnership(fixture, join(fixture.root, ".state", "jobs"));
    const runtime = createConfiguredAgentRuntime({
      config: configFor(fixture.root, fixture.workspace),
      cwd: fixture.root,
      sandboxEngine,
    });

    await expect(runtime.run("system", runOptions(CLAUDE_MODEL, fixture.workspace))).rejects.toThrow(
      PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR,
    );
    expect(runtimeState.run).not.toHaveBeenCalled();
    await runtime.disposeAllSessions?.();
    owner.release();
  });

  it("captures the current registry generation on every raw-runtime run", async () => {
    const fixture = await runtimeFixture("generation-refresh");
    const owner = await seededOwnership(fixture);
    runtimeState.run.mockResolvedValue({ text: "empty-registry result" });
    const runtime = createConfiguredAgentRuntime({
      config: configFor(fixture.root, fixture.workspace),
      cwd: fixture.root,
      sandboxEngine,
    });

    await expect(runtime.run("system", runOptions(CLAUDE_MODEL, fixture.workspace))).resolves.toMatchObject({
      text: "empty-registry result",
    });
    await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: join(fixture.root, ".state", "jobs"),
      coordinator: owner.coordinator,
    });

    await expect(runtime.run("system", runOptions(CLAUDE_MODEL, fixture.workspace))).rejects.toThrow(
      PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR,
    );
    expect(runtimeState.run).toHaveBeenCalledOnce();
    await runtime.disposeAllSessions?.();
    owner.release();
  });

  it("keeps cooperative ownership through a dispose timeout until a late provider truly settles", async () => {
    const fixture = await runtimeFixture("late-provider");
    const owner = await seededOwnership(fixture, join(fixture.root, ".state", "jobs"));
    let settleProvider!: (value: unknown) => void;
    const providerSettlement = new Promise((resolvePromise) => { settleProvider = resolvePromise; });
    runtimeState.run.mockImplementation(async () => await providerSettlement);
    runtimeState.disposeAllSessions.mockRejectedValue(new Error("injected dispose timeout"));
    const runtime = createConfiguredAgentRuntime({
      config: configFor(fixture.root, fixture.workspace),
      cwd: fixture.root,
      sandboxEngine,
    });
    const running = runtime.run("system", runOptions(PI_MODEL, fixture.workspace));
    await vi.waitFor(() => expect(runtimeState.run).toHaveBeenCalledOnce());
    owner.release();

    await expect(runtime.disposeAllSessions?.()).rejects.toThrow("injected dispose timeout");
    await expect(childAttempt(fixture.root, fixture.home)).resolves.toBe("conflict");

    settleProvider({ text: "late result" });
    await expect(running).resolves.toMatchObject({ text: "late result" });
    await vi.waitFor(async () => {
      expect(await childAttempt(fixture.root, fixture.home)).toBe("owned");
    }, { timeout: 5_000, interval: 25 });
  });
});

async function runtimeFixture(label: string): Promise<{
  root: string;
  workspace: string;
  home: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), `mono-agent-configured-runtime-${label}-`));
  temporaryDirectories.push(parent);
  const lexicalRoot = join(parent, "agent");
  const lexicalWorkspace = join(lexicalRoot, "workspace");
  const home = join(parent, "home");
  await Promise.all([
    mkdir(lexicalWorkspace, { recursive: true, mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
  ]);
  return {
    root: await realpath(lexicalRoot),
    workspace: await realpath(lexicalWorkspace),
    home,
  };
}

async function seededOwnership(
  fixture: { root: string; workspace: string; home: string },
  stateDir?: string,
) {
  const ownership = await acquireAgentRootOwnership(fixture.root, { homeDir: fixture.home });
  ownerships.push({
    ownership,
    leasePath: agentRootLeasePath(ownership.agentRoot, fixture.home),
  });
  const empty = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
  ownership.coordinator.synchronizeGeneration(empty.generation);
  if (stateDir !== undefined) {
    await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir,
      coordinator: ownership.coordinator,
    });
  }
  return ownership;
}

function configFor(root: string, workspace: string): MonoAgentConfig {
  return {
    runtime: {
      model: PI_MODEL,
      executionMode: "sdk",
      workspace,
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: join(root, "IDENTITY.md"), selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(root, "artifacts") },
    traceability: { registryDir: join(root, "trace") },
  } as unknown as MonoAgentConfig;
}

function runOptions(model: typeof PI_MODEL | typeof CLAUDE_MODEL, workspace: string): never {
  return {
    model,
    executionMode: "sdk",
    cwd: workspace,
    messages: [{ role: "user", content: "hello" }],
    allowedTools: [],
    disallowedTools: [],
  } as never;
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
      processStartId: "configured-runtime-child-" + String(process.pid),
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
      await new Promise((resolve) => setTimeout(resolve, 25));
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

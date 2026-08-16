import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeHooks = vi.hoisted(() => {
  const sandboxEngine = {
    id: "local-tui-boundary-test",
    isAvailable: vi.fn(async () => true),
    prepareCommand: vi.fn(async (command: unknown) => command),
  };
  return {
    run: vi.fn(),
    create: vi.fn(),
    dispose: vi.fn(async () => undefined),
    sandboxEngine,
  };
});

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  return {
    ...actual,
    createSrtSandboxEngine: () => runtimeHooks.sandboxEngine,
    createMonoRuntime: (options: unknown) => {
      runtimeHooks.create(options);
      return {
        configureTools() {},
        run: (...args: unknown[]) => runtimeHooks.run(...args),
        disposeAllSessions: runtimeHooks.dispose,
      };
    },
  };
});

const { createLocalConfigurationSession } = await import("../local-configuration.js");

const temporaryDirectories: string[] = [];

beforeEach(() => {
  runtimeHooks.run.mockReset();
  runtimeHooks.create.mockClear();
  runtimeHooks.dispose.mockClear();
  runtimeHooks.sandboxEngine.isAvailable.mockClear();
  runtimeHooks.run.mockResolvedValue({
    text: "local response",
    events: [],
    cancelled: false,
    usage: {},
    failureKind: null,
  });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("local TUI configured runtime boundary", () => {
  it("rejects a non-Pi fallback before any provider run when process-job state is configured", async () => {
    const fixture = await localFixture({ fallback: "claude:claude-opus-4-8" });
    const session = await createLocalConfigurationSession({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: {},
    });
    try {
      await expect(session.responder.respond(localRequest(), { append: async () => undefined }))
        .rejects.toThrow("Process-job private state requires a Pi-native runtime.");
      expect(runtimeHooks.run).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  });

  it("attests unresolved clear-sessions recovery before the local provider boundary", async () => {
    const fixture = await localFixture();
    await writeFile(join(fixture.registryRoot, "pending"), "unresolved\n", { mode: 0o600 });
    const session = await createLocalConfigurationSession({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: {},
    });
    try {
      await expect(session.responder.respond(localRequest(), { append: async () => undefined }))
        .rejects.toThrow(
          "Clear-sessions recovery is unresolved; run restart --clear-sessions before model execution.",
        );
      expect(runtimeHooks.run).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  });

  it("protects both private roots while preserving ordinary local TUI tools", async () => {
    const fixture = await localFixture();
    const session = await createLocalConfigurationSession({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: {},
    });
    try {
      await expect(session.responder.respond(localRequest(), { append: async () => undefined }))
        .resolves.toMatchObject({ text: "local response" });
    } finally {
      await session.dispose();
    }

    expect(runtimeHooks.run).toHaveBeenCalledOnce();
    const options = runtimeHooks.run.mock.calls[0]?.[1] as RuntimeRunOptions | undefined;
    expect(options?.allowedTools).toEqual(["Read", "Write", "Bash"]);
    expect(options?.disallowedTools).toEqual([]);
    expect(options?.sandboxEngine).toBe(runtimeHooks.sandboxEngine);
    expect(options?.sandboxPolicy).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
      protectedRoots: expect.arrayContaining([
        fixture.processJobsStateDir,
        fixture.registryRoot,
      ]),
    });
  });
});

function localRequest(): never {
  return {
    conversationId: "tui-local",
    text: "Keep ordinary operator access.",
    metadata: { source: "tui", tui: { local: true } },
    abortSignal: new AbortController().signal,
  } as never;
}

async function localFixture(options: { readonly fallback?: string } = {}): Promise<{
  readonly cwd: string;
  readonly configPath: string;
  readonly processJobsStateDir: string;
  readonly registryRoot: string;
}> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-local-tui-boundary-")));
  temporaryDirectories.push(cwd);
  const configPath = join(cwd, "mono-agent.config.json");
  const privateRoot = join(cwd, ".mono-agent");
  const registryRoot = join(privateRoot, "clear-sessions-v1");
  const processJobsStateDir = join(privateRoot, "process-jobs");
  await Promise.all([
    mkdir(registryRoot, { recursive: true, mode: 0o700 }),
    mkdir(processJobsStateDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(privateRoot, 0o700),
    chmod(registryRoot, 0o700),
    chmod(processJobsStateDir, 0o700),
    writeFile(join(cwd, "IDENTITY.md"), "# Local TUI boundary test\n"),
  ]);
  await writeFile(configPath, `${JSON.stringify({
    agent: { name: "Local boundary test" },
    runtime: {
      model: "pi:openai-codex:gpt-5.5",
      ...(options.fallback === undefined ? {} : { fallbacks: [{ model: options.fallback }] }),
      routeSafety: "per-route-native",
      retry: { primaryAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      workspace: ".",
    },
    context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: ["Read", "Write", "Bash"], disallowedTools: [] },
    artifacts: { dir: "./artifacts" },
    continuations: { enabled: false },
    processJobs: { enabled: true, stateDir: ".mono-agent/process-jobs" },
  }, null, 2)}\n`);
  return { cwd, configPath, processJobsStateDir, registryRoot };
}

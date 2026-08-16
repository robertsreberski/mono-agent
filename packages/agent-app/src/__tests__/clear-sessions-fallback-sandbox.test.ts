import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeLike,
  RuntimeRunOptions,
  SandboxEngine,
  SandboxPolicy,
  RuntimeToolOptions,
} from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

const processRunnerHooks = vi.hoisted(() => ({
  run: undefined as ((command: { readonly command: string; readonly args?: readonly string[] }) => unknown) | undefined,
}));

vi.mock("../../../agent-runtime/src/agent/tools/shared/process-runner.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runPreparedProcess: async (command: { readonly command: string; readonly args?: readonly string[] }) => {
      if (processRunnerHooks.run === undefined) {
        throw new Error("The fallback sandbox test process runner was not configured.");
      }
      return processRunnerHooks.run(command);
    },
  };
});

// This deliberately crosses the package-private boundary: the regression is
// deciding only when the actual Pi turn builder creates Read/Write/Bash with
// the fallback attempt's projected sandbox context.
// @ts-expect-error -- package-private JavaScript deciding sink has no public declaration.
import { buildTurnTools } from "../../../agent-runtime/src/ai/providers/pi-native/turn-runner.js";
import { loadAppCoreConfig } from "../app-config.js";
import { createConfiguredAgentResponder } from "../configured-agent.js";
import { configuredRuntimeFallbackModels } from "../runtime-routes.js";
import { clearSessionsRegistryRoot } from "../sessions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  processRunnerHooks.run = undefined;
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("clear-sessions fallback sandbox boundary", () => {
  it(
    "skips a non-Pi primary before resolving real Pi tools that keep the registry private",
    { timeout: 240_000 },
    async () => {
      const workspace = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-clear-fallback-")));
      temporaryDirectories.push(workspace);
      const configPath = join(workspace, "mono-agent.config.json");
      const registryRoot = clearSessionsRegistryRoot(workspace);
      const registryCanary = join(registryRoot, "fallback-canary.txt");
      const siblingPath = join(workspace, "ordinary-sibling.txt");
      const canary = "EXACT_CLEAR_SESSIONS_FALLBACK_SECRET";
      const enforcedPolicies: SandboxPolicy[] = [];
      const sandboxEngine = deterministicBoundaryEngine(registryRoot, enforcedPolicies);
      processRunnerHooks.run = (command) => {
        const serialized = [command.command, ...(command.args ?? [])].join("\n");
        if (serialized.includes("protected route denied")) {
          return processResult(77, "", "protected route denied");
        }
        if ((command.args ?? []).at(-1) === siblingPath) {
          return processResult(0, Buffer.from("ordinary sibling remains readable\n").toString("base64"));
        }
        if (serialized.includes("cat ordinary-sibling.txt")) {
          return processResult(0, "ordinary sibling remains readable\n");
        }
        throw new Error(`Unexpected fallback sandbox process: ${command.command}`);
      };
      await Promise.all([
        mkdir(registryRoot, { recursive: true, mode: 0o700 }),
        mkdir(join(workspace, "artifacts"), { recursive: true }),
      ]);
      await Promise.all([
        chmod(join(workspace, ".mono-agent"), 0o700),
        chmod(registryRoot, 0o700),
        writeFile(join(workspace, "IDENTITY.md"), "Clear-sessions fallback boundary test\n"),
        writeFile(siblingPath, "ordinary sibling remains readable\n"),
      ]);
      await writeFile(configPath, `${JSON.stringify({
        runtime: {
          model: "claude:claude-opus-4-8",
          fallbacks: [{ model: "pi:openai-codex:gpt-5.6-sol" }],
          routeSafety: "per-route-native",
          retry: { primaryAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
          workspace: ".",
        },
        context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
        tools: { allowedTools: ["Read", "Write", "Bash"], disallowedTools: [] },
        artifacts: { dir: "./artifacts" },
      }, null, 2)}\n`);
      const config = await loadAppCoreConfig({ cwd: workspace, configPath, env: {} });
      const routes = [config.runtime.model, ...configuredRuntimeFallbackModels(config.runtime)];
      expect(routes.map((route) => route.sdk)).toEqual(["claude", "pi"]);

      let primaryTools: RuntimeToolOptions | undefined;
      let primaryRun: RuntimeRunOptions | undefined;
      const primary: MonoRuntimeLike = {
        configureTools(next) { primaryTools = next; },
        async run(_systemPrompt, options) {
          primaryRun = options;
          throw new Error("The protected non-Pi route must be skipped before provider execution.");
        },
      };

      let piTools: RuntimeToolOptions | undefined;
      let piRun: RuntimeRunOptions | undefined;
      let proof: PiToolProof | undefined;
      const pi: MonoRuntimeLike = {
        configureTools(next) { piTools = next; },
        async run(_systemPrompt, options) {
          piRun = options;
          // Request preflight proved the registry empty. Simulate a trusted
          // host-side change after that preflight, then prove every Pi
          // filesystem surface still enforces the native boundary.
          await writeFile(registryCanary, `${canary}\n`, { mode: 0o600 });
          proof = await exercisePiTools(options, piTools, {
            workspace,
            registryCanary,
            siblingPath,
          });
          return {
            text: "Pi fallback tool boundary verified",
            events: [],
            cancelled: false,
            usage: {},
            failureKind: null,
          };
        },
      };
      const runtime = createMonoRuntime({
        fallbackChain: routes.map((model) => ({ model })),
        routeSafety: "per-route-native",
        retry: { backoffMs: 0, maxBackoffMs: 0 },
        resolveAttempt: ({ model }) => ({ runtime: model.sdk === "claude" ? primary : pi }),
      });
      const responder = await createConfiguredAgentResponder({
        config,
        cwd: workspace,
        runtime,
        sandboxEngine,
      });

      try {
        const response = await responder.respond({
          conversationId: "clear-sessions-fallback",
          text: "Exercise the fallback boundary.",
          abortSignal: new AbortController().signal,
        }, { append: async () => {} });

        expect(response.text).toContain("Pi fallback tool boundary verified");
      } finally {
        await (responder as { dispose?: () => Promise<void> }).dispose?.();
      }

      // The protected-root gate skips the non-Pi route before resolver/provider
      // construction. The later Pi attempt receives the complete contract.
      expect(primaryTools).toBeUndefined();
      expect(primaryRun).toBeUndefined();
      expect(piTools?.sandboxEngine).toBe(sandboxEngine);
      expect(piTools?.sandboxPolicy?.protectedRoots).toContain(registryRoot);
      expect(piRun?.sandboxEngine).toBeDefined();
      expect(piRun?.sandboxPolicy?.protectedRoots).toContain(registryRoot);
      expect(enforcedPolicies.length).toBeGreaterThan(0);
      for (const policy of enforcedPolicies) {
        expect(policy.protectedRoots).toContain(registryRoot);
      }

      expect(proof?.protectedRead).toBe("Error: Protected filesystem read was denied.");
      expect(proof?.protectedWrite).toBe("Error: Protected filesystem write was denied.");
      expect(proof?.protectedBash).not.toContain(canary);
      expect(proof?.protectedBash).toMatch(/denied|not permitted|operation not permitted|exit code|error/iu);
      expect(proof?.siblingRead).toContain("ordinary sibling remains readable");
      expect(proof?.siblingBash).toContain("ordinary sibling remains readable");
      expect(await readFile(registryCanary, "utf8")).toBe(`${canary}\n`);
    },
  );
});

interface PiToolProof {
  readonly protectedRead: string;
  readonly protectedWrite: string;
  readonly protectedBash: string;
  readonly siblingRead: string;
  readonly siblingBash: string;
}

async function exercisePiTools(
  options: RuntimeRunOptions,
  toolContext: RuntimeToolOptions | undefined,
  paths: {
    readonly workspace: string;
    readonly registryCanary: string;
    readonly siblingPath: string;
  },
): Promise<PiToolProof> {
  const built = await buildTurnTools({}, {
    options: {
      ...options,
      allowedTools: ["Read", "Write", "Bash"],
      cwd: paths.workspace,
      mcpServers: {},
      toolContext,
    },
    capabilities: { tool_use: true },
    toolLimits: {
      bashOutputLimitChars: 20_000,
      bashTimeoutMs: 10_000,
      imageInlineMaxBytes: 250_000,
      toolPayloadMaxBytes: 250_000,
      toolTextLimitChars: 20_000,
    },
    approvalManager: null,
    runtime: { model: { id: "fallback-tool-proof" } },
    resolved: { model: "fallback-tool-proof" },
    onEvent: () => {},
    runtimeWarnings: [],
  });
  try {
    const read = requiredTool(built.tools, "Read");
    const write = requiredTool(built.tools, "Write");
    const bash = requiredTool(built.tools, "Bash");
    const protectedRead = await capturedToolText(read, "read-protected", {
      file_path: paths.registryCanary,
    });
    const protectedWrite = await capturedToolText(write, "write-protected", {
      file_path: paths.registryCanary,
      content: "COMPROMISED",
    });
    const protectedBash = await capturedToolText(bash, "bash-protected", {
      command: "cat .mono-agent/clear-sessions-v1/fallback-canary.txt",
      workdir: paths.workspace,
    });
    const siblingRead = await capturedToolText(read, "read-sibling", {
      file_path: paths.siblingPath,
    });
    const siblingBash = await capturedToolText(bash, "bash-sibling", {
      command: "cat ordinary-sibling.txt",
      workdir: paths.workspace,
    });
    return { protectedRead, protectedWrite, protectedBash, siblingRead, siblingBash };
  } finally {
    await built.closeRunTools();
    await Promise.all(built.mcpClients.map(async (client: { close(): Promise<void> }) => await client.close()));
  }
}

function requiredTool(
  tools: ReadonlyArray<{ readonly name?: string; execute: (id: string, input: unknown) => Promise<unknown> }>,
  name: string,
): { execute(id: string, input: unknown): Promise<unknown> } {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing Pi ${name} tool.`);
  return tool;
}

async function capturedToolText(
  tool: { execute(id: string, input: unknown): Promise<unknown> },
  id: string,
  input: unknown,
): Promise<string> {
  try {
    return toolText(await tool.execute(id, input));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function toolText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("content" in value)) return String(value);
  const content = (value as { readonly content?: readonly unknown[] }).content;
  if (!Array.isArray(content)) return String(value);
  return content.map((part) => {
    if (typeof part === "object" && part !== null && "text" in part) {
      return String((part as { readonly text?: unknown }).text ?? "");
    }
    return "";
  }).join("\n");
}

function deterministicBoundaryEngine(
  registryRoot: string,
  enforcedPolicies: SandboxPolicy[],
): SandboxEngine {
  return {
    id: "clear-sessions-route-proof",
    async isAvailable() { return true; },
    async prepareCommand(command, policy) {
      enforcedPolicies.push(policy);
      const serialized = [command.command, ...(command.args ?? [])].join("\n");
      const targetsRegistry = serialized.includes(registryRoot)
        || serialized.includes(".mono-agent/clear-sessions-v1");
      if (targetsRegistry) {
        return {
          command: process.execPath,
          args: ["-e", "process.stderr.write('protected route denied');process.exit(77)"],
          cwd: command.cwd ?? policy.root,
          sandboxed: true,
        };
      }
      return {
        ...command,
        args: command.args ?? [],
        cwd: command.cwd ?? policy.root,
        sandboxed: true,
      };
    },
  };
}

function processResult(code: number, stdout: string, stderr = ""): Record<string, unknown> {
  return {
    code,
    signal: null,
    stdout,
    stderr,
    spawnError: null,
    timedOut: false,
    aborted: false,
    bufferExceeded: false,
    groupExitConfirmed: true,
    durationMs: 1,
  };
}

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { sendA2AMessage } from "@mono-agent/a2a-adapter";
import { listTraceRuns } from "@mono-agent/observability";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import type {
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
} from "@mono-agent/telegram-adapter";

import { writeMultiAgentDeploymentFiles } from "../deployment.js";
import { startMultiAgentDemo } from "../multi-agent-demo.js";
import type { MultiAgentRole } from "../orchestrator-responder.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-multi-demo-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("multi-agent demo", () => {
  it("routes an orchestrator A2A request through researcher and worker and records distinct traces", async () => {
    const dir = await tempDir();
    const files = await writeMultiAgentDeploymentFiles({ cwd: process.cwd(), configDir: dir });
    const fakeRuntime = createFakeRuntime();
    const demo = await startMultiAgentDemo({
      cwd: process.cwd(),
      configDir: files.configDir,
      env: {},
      startTelegram: false,
      runtimeFactory: (role) => fakeRuntime.runtimeFor(role),
    });

    try {
      expect(demo.telegramStatus).toMatchObject({ kind: "disabled" });
      expect(demo.orchestratorStatus.kind).toBe("running");
      expect(demo.researcherStatus.kind).toBe("running");
      expect(demo.workerStatus.kind).toBe("running");
      if (demo.orchestratorStatus.kind !== "running") {
        throw new Error("orchestrator not running");
      }

      const response = await sendA2AMessage({
        agentUrl: demo.orchestratorStatus.agentCardUrl,
        text: "Research current context and inspect the workspace.",
      });
      expect(response.text).toBe("Final synthesis used collaborator tool reports.");
      expect(fakeRuntime.calls.map((call) => call.role)).toEqual(["orchestrator", "researcher", "worker"]);
      const orchestratorCall = fakeRuntime.calls.find((call) => call.role === "orchestrator");
      expect(orchestratorCall?.options.allowedTools).toEqual(["ask_collaborator"]);
      expect(orchestratorCall?.options.mcpServers).toMatchObject({
        collaborators: { type: "http" },
      });
      expect(fakeRuntime.calls.find((call) => call.role === "researcher")?.options.allowedTools).toEqual(["WebSearch", "WebFetch"]);
      expect(fakeRuntime.calls.find((call) => call.role === "worker")?.options.allowedTools).toEqual(["Read", "Grep", "Bash"]);

      const traceability = await listTraceRuns({ registryDir: demo.traceRegistryDir });
      expect(traceability.sources.map((source) => source.sourceId).sort()).toEqual([
        "multi-agent-orchestrator",
        "multi-agent-researcher",
        "multi-agent-worker",
      ]);
      expect(traceability.runs.map((run) => run.source.sourceId).sort()).toEqual([
        "multi-agent-orchestrator",
        "multi-agent-researcher",
        "multi-agent-worker",
      ]);

      for (const role of ["orchestrator", "researcher", "worker"] as const) {
        const artifactFiles = await readdir(files.roles[role].artifactDir);
        expect(artifactFiles.some((file) => file.endsWith(".summary.json"))).toBe(true);
        const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
        expect(await readFile(join(files.roles[role].artifactDir, summaryFile as string), "utf8")).toContain(role);
      }
    } finally {
      await demo.stop();
    }
  });

  it("starts Telegram through startTelegramAdapter with the collaborative orchestrator wiring", async () => {
    const dir = await tempDir();
    const files = await writeMultiAgentDeploymentFiles({ cwd: process.cwd(), configDir: dir });
    const fakeRuntime = createFakeRuntime();
    let captured: TelegramAdapterStartOptions | undefined;
    let stopped = false;
    const startResult: TelegramAdapterStartResult = {
      async stop() {
        stopped = true;
      },
    };

    const demo = await startMultiAgentDemo({
      cwd: process.cwd(),
      configDir: files.configDir,
      env: {
        MONO_AGENT_TELEGRAM_ENABLED: "true",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "test-token",
        MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "42,99",
      },
      runtimeFactory: (role) => fakeRuntime.runtimeFor(role),
      telegramStartAdapter: async (options) => {
        captured = options;
        return startResult;
      },
    });

    try {
      expect(demo.telegramStatus).toMatchObject({
        kind: "running",
        allowedChatCount: 2,
        allowAllChats: false,
      });
      expect(captured?.botToken).toBe("test-token");
      expect(captured?.allowedChatIds).toEqual(["42", "99"]);
      expect(captured?.allowAllChats).toBe(false);
      expect(captured?.allowedUpdates).toEqual(["message"]);
      expect(captured?.deleteWebhookOnStart).toBe(true);
      expect(captured?.messages?.unauthorizedText).toContain("not allowlisted");

      // The wired responder is the collaborative orchestrator: invoking it runs
      // the orchestrator runtime, which fans out to researcher and worker.
      const responder = captured?.responder;
      if (responder === undefined) {
        throw new Error("expected a responder to be wired into Telegram");
      }
      const controller = new AbortController();
      const response = await responder.respond(
        {
          conversationId: "telegram:42",
          text: "Research current context and inspect the workspace.",
          abortSignal: controller.signal,
        } as never,
        {
          async append() {
            /* terminal stream is unused for this assertion */
          },
        } as never,
      );
      expect(response.text).toBe("Final synthesis used collaborator tool reports.");
      expect(fakeRuntime.calls.map((call) => call.role)).toEqual(["orchestrator", "researcher", "worker"]);
    } finally {
      await demo.stop();
    }
    expect(stopped).toBe(true);
  });
});

function createFakeRuntime(): {
  readonly calls: Array<{ role: MultiAgentRole; prompt: string; options: RuntimeRunOptions }>;
  runtimeFor(role: MultiAgentRole): { run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> };
} {
  const calls: Array<{ role: MultiAgentRole; prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtimeFor(role) {
      return {
        async run(prompt, options) {
          calls.push({ role, prompt, options });
          options.onEvent?.({ type: "fake-event", role });
          if (role === "orchestrator") {
            return await runFakeOrchestrator(options);
          }
          return {
            text: textForRole(role),
            model: options.model.model,
            sdk: options.model.sdk,
            capabilitiesUsed: [role],
            cost: { totalUsd: 0 },
          };
        },
      };
    },
  };
}

async function runFakeOrchestrator(options: RuntimeRunOptions): Promise<RuntimeResult> {
  const serverConfig = isRecord(options.mcpServers?.collaborators)
    ? options.mcpServers.collaborators
    : undefined;
  if (typeof serverConfig?.url !== "string") {
    return {
      text: "Missing collaborator tool.",
      model: options.model.model,
      sdk: options.model.sdk,
      capabilitiesUsed: ["orchestrator"],
      cost: { totalUsd: 0 },
      error: "Missing collaborator tool.",
      failureKind: "missing_collaborator_tool",
    };
  }
  const client = new Client({ name: "multi-agent-demo-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverConfig.url)) as unknown as Transport);
  try {
    const researcher = await client.callTool({
      name: "ask_collaborator",
      arguments: {
        id: "researcher",
        message: "Research current context.",
      },
    });
    const worker = await client.callTool({
      name: "ask_collaborator",
      arguments: {
        id: "worker",
        message: "Inspect the workspace.",
      },
    });
    expect(textFromToolResult(researcher)).toContain("Research report with source https://example.com.");
    expect(textFromToolResult(worker)).toContain("Worker read the dedicated workspace.");
  } finally {
    await client.close();
  }
  return {
    text: "Final synthesis used collaborator tool reports.",
    model: options.model.model,
    sdk: options.model.sdk,
    capabilitiesUsed: ["orchestrator", "mcp:collaborators"],
    cost: { totalUsd: 0 },
  };
}

function textForRole(role: MultiAgentRole): string {
  if (role === "researcher") {
    return "Research report with source https://example.com.";
  }
  if (role === "worker") {
    return "Worker read the dedicated workspace.";
  }
  return "Final synthesis used collaborator reports.";
}

function textFromToolResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const part = content.find((entry): entry is { type: "text"; text: string } => {
    return isRecord(entry) && entry.type === "text" && typeof entry.text === "string";
  });
  return part?.text ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

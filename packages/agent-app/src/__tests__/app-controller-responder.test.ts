import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import { loadAppCoreConfig } from "../app-config.js";
import { buildResponder, type ResponderControllerPort } from "../app-controller-responder.js";
import {
  PUBLISH_REPLY_FILE_TOOL_NAME,
  REPLY_ARTIFACT_MCP_SERVER_NAME,
} from "../reply-artifacts.js";
import { createSeenNotifyDestinationCache } from "../seen-conversations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("reply artifact responder composition", () => {
  it("refuses every configured host-private root, including relocated durable history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-app-responder-private-roots-"));
    tempDirs.push(workspace);
    const privateSentinel = "composition-host-private-sentinel";
    const artifactDir = join(workspace, "data", "artifacts");
    const historyRoot = resolve(artifactDir, "..", "history");
    const canonicalConfigPath = join(workspace, "host-j", "source.txt");
    const configReadPath = join(workspace, "host-k", "source.txt");
    const identityPath = join(workspace, "host-a", "info.txt");
    const soulPath = join(workspace, "host-b", "tone.txt");
    const skillsRoot = join(workspace, "host-c");
    const memoryPath = join(workspace, "host-d", "knowledge.txt");
    const mcpConfigPath = join(workspace, "host-e", "tooling.json");
    const piAuthPath = join(workspace, "host-f", "provider-access.json");
    const piSessionsRoot = join(workspace, "host-g");
    const traceRegistryDir = join(workspace, "host-h");
    const continuationStateDir = join(workspace, "host-i");
    const historyCandidate = join(historyRoot, "host-data.txt");
    const candidates = [
      { label: "artifact root", path: join(artifactDir, "host-data.txt") },
      { label: "derived attachments", path: join(artifactDir, "attachments", "host-data.txt") },
      { label: "derived outbound other run", path: join(artifactDir, "outbound", "not-current", "host-data.txt") },
      { label: "derived history", path: historyCandidate },
      { label: "cwd state", path: join(workspace, ".mono-agent", "host-data.txt") },
      { label: "canonical config", path: canonicalConfigPath },
      { label: "read config", path: configReadPath },
      { label: "identity", path: identityPath },
      { label: "soul", path: soulPath },
      { label: "skills", path: join(skillsRoot, "host-data.txt") },
      { label: "memory", path: memoryPath },
      { label: "MCP config", path: mcpConfigPath },
      { label: "Pi auth", path: piAuthPath },
      { label: "provider sessions", path: join(piSessionsRoot, "host-data.txt") },
      { label: "trace registry", path: join(traceRegistryDir, "host-data.txt") },
      { label: "continuation state", path: join(continuationStateDir, "host-data.txt") },
    ] as const;
    await Promise.all([...new Set(candidates.map(({ path }) => dirname(path)))]
      .map(async (dir) => await mkdir(dir, { recursive: true })));
    await chmod(historyRoot, 0o700);

    const rawConfig = {
      agent: { name: privateSentinel },
      runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
      providers: {
        piAuthPath: "./host-f/provider-access.json",
        piNative: { piSessionsRoot: "./host-g" },
      },
      context: {
        identityPath: "./host-a/info.txt",
        soulPath: "./host-b/tone.txt",
        skillsRoot: "./host-c",
        selectedSkills: [],
      },
      memory: { mode: "lite", path: "./host-d/knowledge.txt", writeMode: "disabled" },
      tools: {
        allowedTools: [PUBLISH_REPLY_FILE_TOOL_NAME],
        disallowedTools: [],
        mcpConfigPath: "./host-e/tooling.json",
      },
      artifacts: { dir: "./data/artifacts" },
      traceability: { registryDir: "./host-h", globalDiscovery: false },
      continuations: { enabled: false, stateDir: "./host-i" },
    };
    const serializedConfig = `${JSON.stringify(rawConfig, null, 2)}\n`;
    await Promise.all([
      writeFile(canonicalConfigPath, serializedConfig),
      writeFile(configReadPath, serializedConfig),
      writeFile(identityPath, privateSentinel),
      writeFile(soulPath, privateSentinel),
      writeFile(join(skillsRoot, "host-data.txt"), privateSentinel),
      writeFile(memoryPath, privateSentinel),
      writeFile(mcpConfigPath, '{"mcpServers":{}}\n'),
      writeFile(piAuthPath, privateSentinel),
      writeFile(join(piSessionsRoot, "host-data.txt"), privateSentinel),
      writeFile(join(traceRegistryDir, "host-data.txt"), privateSentinel),
      writeFile(join(continuationStateDir, "host-data.txt"), privateSentinel),
      writeFile(join(artifactDir, "host-data.txt"), privateSentinel),
      writeFile(join(artifactDir, "attachments", "host-data.txt"), privateSentinel),
      writeFile(join(artifactDir, "outbound", "not-current", "host-data.txt"), privateSentinel),
      writeFile(historyCandidate, privateSentinel),
      writeFile(join(workspace, ".mono-agent", "host-data.txt"), privateSentinel),
    ]);

    const coreConfig = await loadAppCoreConfig({ cwd: workspace, configPath: configReadPath, env: {} });
    expect(coreConfig.artifacts.dir).toBe(artifactDir);
    const publicationResults: Array<{ readonly label: string; readonly result: unknown }> = [];
    const runtime = {
      async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        const servers = options.mcpServers as Readonly<Record<string, { readonly url: string }>> | undefined;
        const spec = servers?.[REPLY_ARTIFACT_MCP_SERVER_NAME];
        if (spec === undefined) throw new Error("Reply artifact MCP server was not composed.");
        const client = new Client({ name: "private-root-composition-test", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
          for (const candidate of candidates) {
            publicationResults.push({
              label: candidate.label,
              result: await client.callTool({
                name: PUBLISH_REPLY_FILE_TOOL_NAME,
                arguments: { path: candidate.path },
              }),
            });
          }
        } finally {
          await client.close().catch(() => undefined);
          // The history store permits only its own inventory. Remove this
          // harmless probe before the responder appends the completed turn.
          await rm(historyCandidate, { force: true });
        }
        return { text: "composition complete" };
      },
      async disposeAllSessions() {},
    };
    const memory = {
      async load() { return undefined; },
      async appendHostSummary(conversationId: string) {
        return { conversationId, source: "composition-test", bytesWritten: 0 };
      },
    };
    const controller: ResponderControllerPort = {
      cwd: workspace,
      configPath: canonicalConfigPath,
      configReadPath,
      env: {},
      logger: undefined,
      runtime,
      activeRuntimes: [],
      interactionBridge: undefined,
      continuationService: undefined,
      seenNotifyDestinations: createSeenNotifyDestinationCache(),
      sandboxEngineFor: () => undefined,
      memoryStore: async () => memory as never,
      ensureSharedMemoryRetrieval: () => undefined,
      reportMemoryRecallStatus: () => false,
      supermemoryMcpRuntimeOptions: () => undefined,
      adapterSendToolsRuntimeOptions: async () => ({ blockingToolNames: [] }),
      requestModelOverrideRuntimeOptions: () => ({
        extension: async () => ({ runtimeOptions: {}, cleanup: async () => {} }),
        targetsDirectOpenCode: () => false,
      }),
      buildRuntimeForModel: () => () => runtime,
      observabilityContext: async () => ({}),
      recordExporterWarning() {},
      recordSessionEvent() {},
    };

    const responder = await buildResponder(controller, coreConfig, "telegram");
    const response = await responder.respond({
      conversationId: "composition-private-roots",
      text: "Try every configured private path.",
      abortSignal: new AbortController().signal,
    }, { append: async () => {} }).finally(async () => {
      await (responder as { dispose?: () => Promise<void> }).dispose?.();
    });

    expect(publicationResults.map(({ label }) => label)).toEqual(candidates.map(({ label }) => label));
    for (const { result } of publicationResults) {
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { published: false, code: "artifact_publish_failed" },
      });
    }
    expect(response.parts).toHaveLength(candidates.length);
    expect(response.parts?.every((part) => part.type === "failure" && part.code === "artifact_publish_failed"))
      .toBe(true);
    const serializedFailures = JSON.stringify({ publicationResults, parts: response.parts });
    expect(serializedFailures).not.toContain(privateSentinel);
    for (const candidate of candidates) expect(serializedFailures).not.toContain(candidate.path);
  });
});

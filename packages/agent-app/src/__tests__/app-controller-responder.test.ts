import { chmod, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import { loadAppCoreConfig } from "../app-config.js";
import {
  buildResponder,
  replyArtifactStorageMaxBytesForMcpApps,
  type ResponderControllerPort,
} from "../app-controller-responder.js";
import { DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES } from "../mcp-apps.js";
import {
  DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES,
  PUBLISH_REPLY_FILE_TOOL_NAME,
  REPLY_ARTIFACT_MCP_SERVER_NAME,
} from "../reply-artifacts.js";
import { createSeenNotifyDestinationCache } from "../seen-conversations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("reply artifact responder composition", () => {
  it("does not reserve MCP App audit storage when MCP Apps are disabled", () => {
    expect(replyArtifactStorageMaxBytesForMcpApps(false)).toBe(DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES);
    expect(replyArtifactStorageMaxBytesForMcpApps(true)).toBe(
      DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES - DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES,
    );
  });

  it("builds a disabled-MCP-Apps responder with the full physical reply-artifact budget", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-app-responder-disabled-mcp-apps-"));
    tempDirs.push(workspace);
    const artifactDir = join(workspace, "artifacts");
    const configPath = join(workspace, "mono-agent.config.json");
    const identityPath = join(workspace, "IDENTITY.md");
    const soulPath = join(workspace, "SOUL.md");
    const sourcePath = join(workspace, "report.txt");
    const fillerPath = join(artifactDir, "reply-files", "capacity-probe", "content");
    await mkdir(dirname(fillerPath), { recursive: true });
    await Promise.all([
      writeFile(identityPath, "Disabled MCP Apps composition test"),
      writeFile(soulPath, "Keep the test deterministic"),
      writeFile(sourcePath, "publish me"),
      writeFile(fillerPath, ""),
    ]);
    await truncate(
      fillerPath,
      DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES - DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES + 1,
    );
    await writeFile(configPath, `${JSON.stringify({
      agent: { name: "disabled-mcp-apps-composition" },
      runtime: { model: "codex:gpt-5.6-terra", workspace: "." },
      context: {
        identityPath: "./IDENTITY.md",
        soulPath: "./SOUL.md",
        selectedSkills: [],
      },
      tools: { allowedTools: [PUBLISH_REPLY_FILE_TOOL_NAME], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
      continuations: { enabled: false },
    }, null, 2)}\n`);
    const coreConfig = await loadAppCoreConfig({ cwd: workspace, configPath, env: {} });
    let publicationResult: unknown;
    const runtime = {
      async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        expect(options.mcpApps).toBeUndefined();
        const servers = options.mcpServers as Readonly<Record<string, { readonly url: string }>> | undefined;
        const spec = servers?.[REPLY_ARTIFACT_MCP_SERVER_NAME];
        if (spec === undefined) throw new Error("Reply artifact MCP server was not composed.");
        const client = new Client({ name: "disabled-mcp-apps-budget-test", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
          publicationResult = await client.callTool({
            name: PUBLISH_REPLY_FILE_TOOL_NAME,
            arguments: { path: sourcePath },
          });
        } finally {
          await client.close().catch(() => undefined);
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
      configPath,
      configReadPath: configPath,
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
      conversationId: "composition-disabled-mcp-apps",
      text: "Publish the report.",
      abortSignal: new AbortController().signal,
    }, { append: async () => {} }).finally(async () => {
      await (responder as { dispose?: () => Promise<void> }).dispose?.();
    });

    expect(publicationResult).toMatchObject({
      structuredContent: { published: true },
    });
    expect(response.parts).toEqual([
      expect.objectContaining({ type: "attachment" }),
    ]);
  });

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
    const authorizedFilePath = join(workspace, "exports", "ordinary-report.txt");
    const authorizedFileContents = "composition-authorized-public-content";
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
    await Promise.all([...new Set([...candidates.map(({ path }) => dirname(path)), dirname(authorizedFilePath)])]
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
      writeFile(authorizedFilePath, authorizedFileContents),
    ]);

    const coreConfig = await loadAppCoreConfig({ cwd: workspace, configPath: configReadPath, env: {} });
    expect(coreConfig.artifacts.dir).toBe(artifactDir);
    const publicationResults: Array<{ readonly label: string; readonly result: unknown }> = [];
    let authorizedPublicationResult: unknown;
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
          authorizedPublicationResult = await client.callTool({
            name: PUBLISH_REPLY_FILE_TOOL_NAME,
            arguments: { path: authorizedFilePath },
          });
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
    const failures = response.parts?.filter((part) => part.type === "failure") ?? [];
    expect(failures).toHaveLength(candidates.length);
    expect(failures.every((part) => part.code === "artifact_publish_failed")).toBe(true);
    expect(authorizedPublicationResult).toMatchObject({
      structuredContent: {
        published: true,
        attachmentId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/u),
      },
    });
    const attachmentId = (authorizedPublicationResult as {
      structuredContent: { attachmentId: string };
    }).structuredContent.attachmentId;
    expect(response.parts).toHaveLength(candidates.length + 1);
    expect(response.parts?.filter((part) => part.type === "attachment")).toEqual([
      expect.objectContaining({
        type: "attachment",
        id: attachmentId,
        reference: { scheme: "mono-agent-artifact", id: attachmentId },
      }),
    ]);
    await expect(readFile(join(artifactDir, "reply-files", attachmentId, "content"), "utf8"))
      .resolves.toBe(authorizedFileContents);
    const serializedOutbound = JSON.stringify({
      publicationResults,
      authorizedPublicationResult,
      parts: response.parts,
    });
    expect(serializedOutbound).not.toContain(privateSentinel);
    expect(serializedOutbound).not.toContain(authorizedFileContents);
    expect(serializedOutbound).not.toContain(authorizedFilePath);
    for (const candidate of candidates) expect(serializedOutbound).not.toContain(candidate.path);
  });
});

import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAppCoreConfig } from "../app-config.js";
import {
  buildResponder,
  replyArtifactStorageMaxBytesForMcpApps,
  requestModelOverrideRuntimeOptions as createRequestModelOverrideRuntimeOptions,
  type ResponderControllerPort,
} from "../app-controller-responder.js";
import { DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES } from "../mcp-apps.js";
import {
  DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES,
  PUBLISH_REPLY_FILE_TOOL_NAME,
  REPLY_ARTIFACT_MCP_SERVER_NAME,
} from "../reply-artifacts.js";
import { createSeenNotifyDestinationCache } from "../seen-conversations.js";
import { startTuiAdapter } from "@mono-agent/operator-adapter";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  agentRootLeasePath,
  acquireAgentRootOwnership,
  type AgentRootOwnership,
} from "../agent-root-coordinator.js";
import {
  loadProcessJobsRootRegistryProtection,
  registerProcessJobsRoot,
  type ProcessJobsRootRegistrySnapshot,
} from "../process-jobs-root-registry.js";
import { resolveProcessJobsProtectionPosture } from "../process-jobs-protection.js";

const processIdentity = vi.hoisted(() => ({
  current: {
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-responder",
  },
}));

vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => processIdentity.current,
  isSameProcessIncarnation: () => true,
}));

const tempDirs: string[] = [];
const rootOwnerships: Array<{ ownership: AgentRootOwnership; leasePath: string }> = [];

afterEach(async () => {
  const held = rootOwnerships.splice(0);
  for (const { ownership } of held) ownership.release();
  await Promise.all(held.map(async ({ leasePath }) => {
    await vi.waitFor(async () => {
      await expect(lstat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }, { timeout: 2_000, interval: 10 });
  }));
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("reply artifact responder composition", () => {
  it("does not reserve MCP App audit storage when MCP Apps are disabled", () => {
    expect(replyArtifactStorageMaxBytesForMcpApps(false)).toBe(DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES);
    expect(replyArtifactStorageMaxBytesForMcpApps(true)).toBe(
      DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES - DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES,
    );
    expect(replyArtifactStorageMaxBytesForMcpApps(false, 4096)).toBe(4096);
    expect(replyArtifactStorageMaxBytesForMcpApps(true, 2_097_152)).toBe(1_048_576);
    expect(replyArtifactStorageMaxBytesForMcpApps(true, "unlimited")).toBe("unlimited");
    expect(() => replyArtifactStorageMaxBytesForMcpApps(true, 1_048_576)).toThrow(/audit reserve/);
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
    const processJobsStateDir = join(workspace, "host-l");
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
      { label: "process-job state", path: join(processJobsStateDir, "host-data.txt") },
    ] as const;
    await Promise.all([...new Set([...candidates.map(({ path }) => dirname(path)), dirname(authorizedFilePath)])]
      .map(async (dir) => await mkdir(dir, { recursive: true })));
    await chmod(historyRoot, 0o700);

    const rawConfig = {
      agent: { name: privateSentinel },
      runtime: { model: "openai-codex:gpt-5.5", workspace: "." },
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
      processJobs: { enabled: false, stateDir: "./host-l" },
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
      writeFile(join(processJobsStateDir, "host-data.txt"), privateSentinel),
      writeFile(join(artifactDir, "host-data.txt"), privateSentinel),
      writeFile(join(artifactDir, "attachments", "host-data.txt"), privateSentinel),
      writeFile(join(artifactDir, "outbound", "not-current", "host-data.txt"), privateSentinel),
      writeFile(historyCandidate, privateSentinel),
      writeFile(join(workspace, ".mono-agent", "host-data.txt"), privateSentinel),
      writeFile(authorizedFilePath, authorizedFileContents),
    ]);

    const coreConfig = await loadAppCoreConfig({ cwd: workspace, configPath: configReadPath, env: {} });
    await chmod(processJobsStateDir, 0o700);
    const security = await controllerSecurity(
      workspace,
      coreConfig.runtime.workspace,
      processJobsStateDir,
    );
    expect(coreConfig.artifacts.dir).toBe(artifactDir);
    const publicationResults: Array<{ readonly label: string; readonly result: unknown }> = [];
    let authorizedPublicationResult: unknown;
    const sandboxEngine = {
      async isAvailable() { return true; },
      async prepareCommand(command: never) { return command; },
    };
    const sandboxEngineFor = vi.fn(() => sandboxEngine as never);
    let observedRuntimeOptions: RuntimeRunOptions | undefined;
    const runtime = {
      async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        observedRuntimeOptions = options;
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
      async persistCompletedTurn(turn: { runId: string; conversationId: string }) {
        return { id: turn.runId, runId: turn.runId, conversationId: turn.conversationId, source: "composition-test", bytesWritten: 0, admissionStatus: "admitted" as const };
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
      processJobsService: {
        settings: { stateDir: processJobsStateDir, maxChainDepth: 4 },
        controller: vi.fn(),
      } as never,
      processJobsStateDir,
      agentRootOwnership: security.ownership,
      processJobsRegistry: security.registry,
      seenNotifyDestinations: createSeenNotifyDestinationCache(),
      sandboxEngineFor,
      memoryStore: async () => memory as never,
      ensureSharedMemoryRetrieval: () => undefined,
      reportMemoryRecallStatus: () => false,
      adapterSendToolsRuntimeOptions: async () => ({ blockingToolNames: [] }),
      requestModelOverrideRuntimeOptions: () => ({
        extension: async () => ({ runtimeOptions: {}, cleanup: async () => {} }),
        compactionEndpoint: async () => ({}),
        targetsDirectOpenCode: () => false,
        targetsUnsupportedHistoryTool: () => false,
        targetsPiNative: () => true,
        targetsProcessJobsPiNative: () => true,
      }),
      buildRuntimeForModel: () => () => runtime,
      observabilityContext: async () => ({}),
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
    const canonicalProcessJobsStateDir = await realpath(processJobsStateDir);

    expect(publicationResults.map(({ label }) => label)).toEqual(candidates.map(({ label }) => label));
    expect(observedRuntimeOptions?.sandboxEngine).toBe(sandboxEngine);
    expect(observedRuntimeOptions?.sandboxPolicy).toMatchObject({
      mode: "native",
      network: { mode: "all" },
      protectedRoots: expect.arrayContaining([canonicalProcessJobsStateDir]),
    });
    expect(sandboxEngineFor).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: expect.objectContaining({
        mode: "native",
        network: { mode: "all", allowlist: [] },
        protectedRoots: expect.arrayContaining([canonicalProcessJobsStateDir]),
      }),
    }));
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

const PI_ROUTE = "openai-codex:gpt-5.6-sol";
const PI_FALLBACK_ROUTE = "ollama:qwen3:8b";
describe("process-job mixed fallback route guard", () => {
  it("selects the same model-owned endpoint block for promptless compaction as for a web turn", async () => {
    const baseModel = parseMonoRuntimeModelReference("openai:gpt-4.1");
    const model = "anthropic:claude-sonnet-4-6";
    const selection = createRequestModelOverrideRuntimeOptions({} as ResponderControllerPort, {
      runtime: { model: baseModel },
    } as Parameters<typeof createRequestModelOverrideRuntimeOptions>[1]);
    const turn = await selection.extension({ request: { metadata: { web: { model } } } } as never);
    const compact = await selection.compactionEndpoint(model);
    expect(compact).toMatchObject({
      customProvider: turn.runtimeOptions?.customProvider,
      customModel: turn.runtimeOptions?.customModel,
      modelCapabilities: turn.runtimeOptions?.modelCapabilities,
      isPrivateProvider: turn.runtimeOptions?.isPrivateProvider,
    });
    expect(compact.customProvider).toBeNull();
  });
  it("keeps degraded all-Pi fallback turns protected without exposing a controller", async () => {
    const fixture = await createRouteGuardFixture(PI_ROUTE, PI_FALLBACK_ROUTE, "degraded");
    try {
      const response = await fixture.responder.respond({
        conversationId: "slack:C1:1.1",
        text: "exercise protected fallback",
        abortSignal: new AbortController().signal,
      }, { append: async () => {} });

      expect(response.text).toContain("fallback route completed");
      expect(fixture.providerRunCounts).toEqual([1, 1]);
      expect(fixture.routeRunOptions).toHaveLength(2);
      for (const options of fixture.routeRunOptions) {
        expect(options.sandboxEngine).toBe(fixture.sandboxEngine);
        expect(options.processJobs).toBeUndefined();
        expect(options.sandboxPolicy).toMatchObject({
          mode: "native",
          fallback: "fail-closed",
          unsafeAllowHostProcess: false,
          readableRoots: [fixture.workspace],
        });
        expect(options.sandboxPolicy?.protectedRoots).toContain(fixture.processJobsStateDir);
        expect(options.sandboxPolicy?.protectedRoots).not.toContain(dirname(fixture.processJobsStateDir));
        expect(options.sandboxPolicy?.protectedRoots).not.toContain(dirname(fixture.siblingFile));
      }
      expect(relative(fixture.processJobsStateDir, fixture.siblingFile)).toMatch(/^\.\./u);
      expect(await readFile(fixture.siblingFile, "utf8")).toBe("normal sibling remains readable");
    } finally {
      await fixture.dispose();
    }
  });

  it.each([false, true])("keeps inactive off/omitted execution unwrapped (off=%s)", async (off) => {
    const fixture = await createRouteGuardFixture(PI_ROUTE, PI_FALLBACK_ROUTE, "none", false, false, off);
    try {
      await fixture.responder.respond({ conversationId: "slack:C1:host", text: "hello",
        abortSignal: new AbortController().signal }, { append: async () => {} });
      expect(fixture.sandboxEngineFor).not.toHaveBeenCalled();
      expect(fixture.routeRunOptions.length).toBeGreaterThan(0);
      for (const options of [...fixture.routeRunOptions, ...fixture.routeToolOptions]) {
        expect(options.sandboxPolicy?.mode).not.toBe("native");
        expect(options.sandboxPolicy?.protectedRoots ?? []).toEqual([]);
        expect(options.sandboxEngine).toBeUndefined();
      }
    } finally { await fixture.dispose(); }
  });

  it("keeps the full app responder and routed harness unprotected in validated unsafe posture", async () => {
    const fixture = await createRouteGuardFixture(
      PI_ROUTE,
      PI_FALLBACK_ROUTE,
      "live",
      true,
      true,
    );
    try {
      const response = await fixture.responder.respond({
        conversationId: "slack:C1:unsafe",
        text: "exercise trusted host tools",
        abortSignal: new AbortController().signal,
      }, { append: async () => {} });
      expect(response.text).toContain("fallback route completed");

      expect(fixture.providerRunCounts).toEqual([1, 1]);
      expect(fixture.sandboxEngineFor).not.toHaveBeenCalled();
      for (const options of fixture.routeRunOptions) {
        expect(options.sandboxEngine).toBeUndefined();
        expect(options.sandboxPolicy).toMatchObject({ mode: "off" });
        expect(options.sandboxPolicy?.protectedRoots ?? []).toHaveLength(0);
      }
      for (const options of fixture.routeToolOptions) {
        expect(options.sandboxEngine).toBeUndefined();
        expect(options.sandboxPolicy?.protectedRoots ?? []).toHaveLength(0);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("fails a degraded all-Pi turn before providers when the sandbox engine is unavailable", async () => {
    const fixture = await createRouteGuardFixture(
      PI_ROUTE,
      PI_FALLBACK_ROUTE,
      "degraded",
      false,
    );
    try {
      await expect(fixture.responder.respond({
        conversationId: "slack:C1:1.1",
        text: "do not invoke a provider without protection",
        abortSignal: new AbortController().signal,
      }, { append: async () => {} })).rejects.toThrow(
        "Process-job private state protection is unavailable.",
      );
      expect(fixture.providerRunCounts).toEqual([0, 0]);
    } finally {
      await fixture.dispose();
    }
  });

});

async function createRouteGuardFixture(
  primaryReference: string,
  fallbackReference: string | undefined,
  processJobsMode: "live" | "degraded" | "none",
  sandboxEngineAvailable = true,
  unsafe = false,
  off = false,
): Promise<{
  readonly responder: Awaited<ReturnType<typeof buildResponder>>;
  readonly providerRunCounts: readonly number[];
  readonly routeRunOptions: readonly RuntimeRunOptions[];
  readonly routeToolOptions: readonly RuntimeRunOptions[];
  readonly sandboxEngine: object;
  readonly sandboxEngineFor: ReturnType<typeof vi.fn>;
  readonly workspace: string;
  readonly processJobsStateDir: string;
  readonly siblingFile: string;
  readonly dispose: () => Promise<void>;
}> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "agent-app-process-job-route-guard-")));
  tempDirs.push(workspace);
  const configPath = join(workspace, "mono-agent.config.json");
  const processJobsStateDir = join(workspace, ".mono-agent", "process-jobs");
  const siblingFile = join(workspace, ".mono-agent", "attachments", "sibling.txt");
  await Promise.all([
    mkdir(processJobsStateDir, { recursive: true, mode: 0o700 }),
    mkdir(dirname(siblingFile), { recursive: true }),
    mkdir(join(workspace, "artifacts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "IDENTITY.md"), "Route guard integration test"),
    writeFile(join(workspace, "SOUL.md"), "Keep routing deterministic"),
    writeFile(siblingFile, "normal sibling remains readable"),
  ]);
  await writeFile(configPath, `${JSON.stringify({
    agent: { name: "process-job-route-guard" },
    runtime: {
      // Static agent JSON deliberately rejects ACP. The loaded result is
      // replaced below through the app's programmatic config seam so this one
      // integration matrix can cover ACP without weakening config validation.
      model: PI_ROUTE,
      ...(fallbackReference === undefined ? {} : { fallbacks: [{ model: fallbackReference }] }),
      retry: { primaryAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      workspace: ".",
    },
    context: {
      identityPath: "./IDENTITY.md",
      soulPath: "./SOUL.md",
      selectedSkills: [],
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: "./artifacts" },
    continuations: { enabled: false },
    processJobs: {
      enabled: processJobsMode !== "none",
      stateDir: ".mono-agent/process-jobs",
      ...(unsafe ? { unsafeAllowUnprotectedState: true } : {}),
    },
    ...(unsafe || off ? { sandbox: { mode: "off" } } : {}),
  }, null, 2)}\n`);
  const loadedConfig = await loadAppCoreConfig({ cwd: workspace, configPath, env: {} });
  const primaryModel = parseMonoRuntimeModelReference(primaryReference);
  const fallbackModel = fallbackReference === undefined
    ? undefined
    : parseMonoRuntimeModelReference(fallbackReference);
  const coreConfig = {
    ...loadedConfig,
    runtime: {
      ...loadedConfig.runtime,
      model: primaryModel,
      fallbacks: fallbackModel === undefined ? [] : [{ model: fallbackModel }],
    },
  };
  const security = await controllerSecurity(
    workspace,
    coreConfig.runtime.workspace,
    processJobsMode === "none" ? undefined : processJobsStateDir,
  );
  const routes = [
    coreConfig.runtime.model,
    coreConfig.runtime.fallbacks?.[0]?.model,
  ].filter((route): route is RuntimeModelReference => route !== undefined);
  expect(routes).toHaveLength(fallbackModel === undefined ? 1 : 2);
  const providerRunCounts = routes.map(() => 0);
  const routeRunOptions: RuntimeRunOptions[] = [];
  const routeToolOptions: RuntimeRunOptions[] = [];
  const routeRuntimes = routes.map((_route, index): MonoRuntimeLike => ({
    configureTools(options) { routeToolOptions.push(options as RuntimeRunOptions); },
    async run(_systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
      providerRunCounts[index] = (providerRunCounts[index] ?? 0) + 1;
      routeRunOptions.push(options);
      if (index === 0 && routes.length > 1) {
        return {
          text: null,
          error: "Connection error.",
          events: [],
          cancelled: false,
          usage: {},
          failureKind: "provider_unavailable",
        } as RuntimeResult;
      }
      return {
        text: "fallback route completed",
        events: [],
        cancelled: false,
        usage: {},
        failureKind: null,
      } as RuntimeResult;
    },
    async disposeAllSessions() {},
  }));
  const runtime = createMonoRuntime({
    fallbackChain: routes.map((model) => ({ model })),
    retry: { backoffMs: 0, maxBackoffMs: 0 },
    resolveAttempt: ({ attemptIndex }) => {
      const runtimeForAttempt = routeRuntimes[attemptIndex];
      return runtimeForAttempt === undefined ? undefined : { runtime: runtimeForAttempt };
    },
  });
  const memory = {
    async load() { return undefined; },
    async persistCompletedTurn(turn: { runId: string; conversationId: string }) {
      return { id: turn.runId, runId: turn.runId, conversationId: turn.conversationId, source: "route-guard-test", bytesWritten: 0, admissionStatus: "admitted" as const };
    },
  };
  const sandboxEngine = {
    id: "route-guard-test",
    async isAvailable() { return sandboxEngineAvailable; },
    async prepareCommand(command: unknown) { return command; },
  };
  const sandboxEngineFor = vi.fn(() => sandboxEngine as never);
  const processJobsProtectionPosture = resolveProcessJobsProtectionPosture({
    settings: {
      enabled: processJobsMode !== "none",
      unsafeAllowUnprotectedState: unsafe,
    },
    registry: security.registry,
    coreConfig,
  });
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
    processJobsService: processJobsMode === "live"
      ? {
          settings: { stateDir: processJobsStateDir, maxChainDepth: 4 },
          controller: vi.fn(),
        } as never
      : undefined,
    processJobsStateDir: processJobsMode === "none" ? undefined : processJobsStateDir,
    agentRootOwnership: security.ownership,
    processJobsRegistry: security.registry,
    processJobsProtectionPosture,
    seenNotifyDestinations: createSeenNotifyDestinationCache(),
    sandboxEngineFor,
    memoryStore: async () => memory as never,
    ensureSharedMemoryRetrieval: () => undefined,
    reportMemoryRecallStatus: () => false,
    adapterSendToolsRuntimeOptions: async () => ({ blockingToolNames: [] }),
    requestModelOverrideRuntimeOptions(coreConfigInput) {
      return createRequestModelOverrideRuntimeOptions(controller, coreConfigInput);
    },
    buildRuntimeForModel: () => () => runtime,
    observabilityContext: async () => ({}),
    recordSessionEvent() {},
  };
  const responder = await buildResponder(controller, coreConfig, "slack");
  return {
    responder,
    providerRunCounts,
    routeRunOptions,
    routeToolOptions,
    sandboxEngine,
    sandboxEngineFor,
    workspace,
    processJobsStateDir,
    siblingFile,
    dispose: async () => {
      await (responder as { dispose?: () => Promise<void> }).dispose?.();
    },
  };
}

it("compacts durable web conversations through the production responder composition and operator HTTP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compact-host-composition-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are a fictional test agent.");
  const primary = parseMonoRuntimeModelReference("openai-codex:gpt-5.5");
  const other = parseMonoRuntimeModelReference("openai-codex:gpt-5.4");
  const config: MonoAgentConfig = {
    runtime: { model: primary, fallbacks: [{ model: other }], workspace: dir,
      session: { mode: "continuous", idleTimeoutMs: 60_000, rollover: "daily",
        rolloverTimezone: "America/New_York", isolateProactive: true },
      compaction: { triggerRatio: 0.9 } },
    providers: { piNative: { piSessionsRoot: join(dir, "pi") } },
    context: { identityPath, selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(dir, "artifacts"), retention: { maxAgeDays: 365, maxCount: 100, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 100, dryRun: false } },
    traceability: { registryDir: join(dir, "sources") },
  };
  const providerCalls: RuntimeRunOptions[] = [];
  const compactedSessions: string[] = [];
  const provider: MonoRuntimeLike = {
    configureTools() {},
    async run(_prompt, options): Promise<RuntimeResult> {
      providerCalls.push(options);
      const sessionId = (options.sessionId ?? options.providerAttributionSessionId) as string;
      if (options.manualCompaction === true) {
        compactedSessions.push(sessionId);
        return { providerSessionId: sessionId, manualCompaction: { status: "succeeded", trigger: "manual",
          operationId: `compact-${compactedSessions.length}`, tokensBefore: 1000, tokensAfter: 300,
          tokenCountsExact: false } } as RuntimeResult;
      }
      return { text: "fictional answer", providerSessionId: sessionId };
    },
    async syncSession() { return true; },
    async refreshSession() {},
    async retireDurableSession() {},
    async invalidateSession() { return true; },
    async disposeSession() { return true; },
  };
  const router = (model: RuntimeModelReference, withFallback: boolean): MonoRuntimeLike => {
    const routed = createMonoRuntime({ fallbackChain: [{ model }, ...(withFallback ? [{ model: other }] : [])],
      resolveAttempt: () => ({ runtime: provider }) });
    // This scripted owner has no native journal matcher; the default router
    // seam belongs to an unrelated inner runtime and must not opt this fake in.
    delete routed.reconcileSessionTurn;
    return { ...routed,
    // The scripted provider is the durable Pi session owner; the router's
    // default inner runtime has no knowledge of this test's provider handle.
    syncSession: provider.syncSession!.bind(provider),
    refreshSession: provider.refreshSession!.bind(provider),
    retireDurableSession: provider.retireDurableSession!.bind(provider),
    invalidateSession: provider.invalidateSession!.bind(provider),
    };
  };
  const runtime = router(primary, true);
  const security = await controllerSecurity(dir, dir);
  const controller: ResponderControllerPort = {
    cwd: dir, configPath: join(dir, "mono-agent.config.json"), configReadPath: join(dir, "mono-agent.config.json"),
    env: {}, logger: undefined, runtime, activeRuntimes: [], interactionBridge: undefined,
    continuationService: undefined, processJobsService: undefined, processJobsStateDir: undefined,
    agentRootOwnership: security.ownership, processJobsRegistry: security.registry,
    seenNotifyDestinations: createSeenNotifyDestinationCache(), sandboxEngineFor: () => undefined,
    memoryStore: async () => ({ load: async () => undefined,
      persistCompletedTurn: async (turn: { runId: string; conversationId: string }) => ({
        id: turn.runId, runId: turn.runId, conversationId: turn.conversationId,
        source: "test", bytesWritten: 0, admissionStatus: "admitted" as const,
      }) }) as never,
    ensureSharedMemoryRetrieval: () => undefined, reportMemoryRecallStatus: () => false,
    adapterSendToolsRuntimeOptions: async () => ({ blockingToolNames: [] }),
    requestModelOverrideRuntimeOptions: () => ({
      extension: async ({ request }) => {
        const selected = (request.metadata?.web as { model?: string } | undefined)?.model;
        return { runtimeOptions: selected === undefined ? {} : { model: parseMonoRuntimeModelReference(selected) },
          cleanup: async () => {} };
      },
      compactionEndpoint: async () => ({}), targetsProcessJobsPiNative: () => true,
    }),
    buildRuntimeForModel: () => (model) => router(model, false),
    observabilityContext: async () => ({}), recordSessionEvent() {},
  };
  let responder: Awaited<ReturnType<typeof buildResponder>> | undefined;
  let operator: Awaited<ReturnType<typeof startTuiAdapter>> | undefined;
  try {
    responder = await buildResponder(controller, config, "tui");
    operator = await startTuiAdapter({ host: "127.0.0.1", port: 0, responder });
    for (const [index, model] of [undefined, primary.reference, other.reference].entries()) {
      const id = `web:fictional-${index}`;
      const response = await responder.respond({ conversationId: id, text: "A fictional turn",
        abortSignal: new AbortController().signal,
        ...(model === undefined ? {} : { metadata: { web: { model } } }),
      }, { append: async () => {} });
      expect(response.text).toBe("fictional answer");
      const turn = providerCalls.at(-1);
      expect(turn?.model?.reference).toBe(model ?? primary.reference);
      const url = `${operator.baseUrl}/v1/conversations/${encodeURIComponent(id)}/compact`;
      const compacted = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(model === undefined ? {} : { model }) });
      expect(compacted.status).toBe(200);
      expect(await compacted.json()).toMatchObject({ status: "succeeded", trigger: "manual",
        tokensBefore: 1000, tokensAfter: 300 });
      expect(compactedSessions.at(-1)).toBe(turn?.providerAttributionSessionId);
      expect(providerCalls.at(-1)?.manualCompaction).toBe(true);
    }
  } finally {
    await operator?.stop();
    await (responder as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
  }
});

async function controllerSecurity(
  agentRoot: string,
  workspace: string,
  stateDir?: string,
): Promise<{
  ownership: AgentRootOwnership;
  registry: ProcessJobsRootRegistrySnapshot;
}> {
  const home = await mkdtemp(join(tmpdir(), "mono-agent-responder-owner-"));
  tempDirs.push(home);
  const ownership = await acquireAgentRootOwnership(agentRoot, { homeDir: home });
  rootOwnerships.push({
    ownership,
    leasePath: agentRootLeasePath(ownership.agentRoot, home),
  });
  let registry = await loadProcessJobsRootRegistryProtection(ownership.agentRoot, workspace);
  ownership.coordinator.synchronizeGeneration(registry.generation);
  if (stateDir !== undefined) {
    const canonicalStateDir = await realpath(stateDir);
    const registration = await registerProcessJobsRoot({
      agentRoot: ownership.agentRoot,
      workspace,
      stateDir: canonicalStateDir,
      coordinator: ownership.coordinator,
    });
    registry = registration.snapshot;
  }
  return { ownership, registry };
}

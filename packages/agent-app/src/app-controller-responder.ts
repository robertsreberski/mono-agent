import { resolve } from "node:path";

import { loadToolPolicyFromJsonFileSync } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { modelReferenceKey } from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeLike,
  RuntimeExecutionMode,
  RuntimeModelReference,
  SandboxEngine,
} from "@mono-agent/runtime-adapter";

import { resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import {
  createConfiguredAgentResponderForApp,
  createConfiguredAgentRuntime,
  DEFAULT_HISTORY_MAX_MESSAGES,
} from "./configured-agent.js";
import type { ConfiguredAgentSessionEvent, createConfiguredMemory } from "./configured-agent.js";
import {
  adapterSendToolNames,
  createAdapterSendToolsRuntimeExtension,
  resolveAdapterSendToolsSettings,
} from "./adapter-send-tools.js";
import { composeRuntimeOptionExtensions, type RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import { createLocalConfigurationRuntimeExtension } from "./local-configuration.js";
import { createRunHistoryRuntimeExtension, isRunHistoryToolAllowed } from "./run-history.js";
import { createSessionHistoryRuntimeExtension, isSessionHistoryToolAllowed } from "./session-history.js";
import {
  createReplyArtifactService,
  DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES,
  isPublishReplyFileToolAllowed,
  replyArtifactStorageBudgetFor,
} from "./reply-artifacts.js";
import {
  createMcpAppService,
  DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES,
} from "./mcp-apps.js";
import { createReplyPartBudget } from "./reply-part-budget.js";
import {
  createRequestModelOverrideRuntimeExtension,
  requestModelOverrideTargetsDirectOpenCode,
  requestModelOverrideTargetsUnsupportedHistoryTool,
  requestModelOverrideTargetsPiNative,
} from "./request-model-override.js";
import { resolvePostedMessageIndexPath } from "./posted-message-index.js";
import { configuredRuntimeFallbackModels, runtimeUsesFallbackRouter } from "./runtime-routes.js";
import { isNotifyDestinationConversationId } from "./notify-destinations.js";
import { createSlackPostedReplyHistory } from "./posted-reply-history.js";
import {
  isInteractionToolName,
  historyToolRouteSupport,
  reasonOf,
  runtimeRouteContainsDirectOpenCode,
  runtimeRouteContainsUnsupportedHistoryTool,
  runtimeRouteSupportsMcpApps,
} from "./app-controller-utils.js";
import type { ChannelId, MonoAgentAppLogger } from "./channels.js";
import { loadContinuationSettings } from "./continuation-config.js";
import type { InteractionBridgeHandle } from "./interaction-bridge.js";
import type { ContinuationServiceHandle } from "./continuation-service.js";
import type { MemoryRetrievalService } from "./memory-retrieval.js";
import type { SeenNotifyDestinationCache } from "./seen-conversations.js";
import { agentArtifactDerivedRoots } from "./agent-artifact-paths.js";
import { createProcessJobsRuntimeExtension } from "./process-jobs-runtime.js";
import type { ProcessJobsServiceHandle } from "./process-jobs-service.js";
import { bindProcessJobWakeContextToResponder } from "./process-jobs-context.js";

type ConfiguredMemory = Awaited<ReturnType<typeof createConfiguredMemory>>;

export interface ResponderControllerPort {
  readonly cwd: string;
  readonly configPath: string;
  readonly configReadPath: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: MonoAgentAppLogger | undefined;
  readonly runtime: MonoRuntimeLike | undefined;
  readonly activeRuntimes: MonoRuntimeLike[];
  readonly interactionBridge: InteractionBridgeHandle | undefined;
  readonly continuationService: ContinuationServiceHandle | undefined;
  readonly processJobsService: ProcessJobsServiceHandle | undefined;
  readonly seenNotifyDestinations: SeenNotifyDestinationCache;
  sandboxEngineFor(coreConfig: MonoAgentConfig): SandboxEngine | undefined;
  memoryStore(coreConfig: MonoAgentConfig): Promise<ConfiguredMemory>;
  ensureSharedMemoryRetrieval(
    coreConfig: MonoAgentConfig,
    store: ConfiguredMemory,
  ): MemoryRetrievalService | undefined;
  reportMemoryRecallStatus(coreConfig: MonoAgentConfig, service: MemoryRetrievalService | undefined): boolean;
  supermemoryMcpRuntimeOptions(coreConfig: MonoAgentConfig): RuntimeOptionsExtension | undefined;
  adapterSendToolsRuntimeOptions(coreConfig: MonoAgentConfig): Promise<{
    readonly createExtension?: (
      targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
    ) => RuntimeOptionsExtension;
    readonly blockingToolNames: readonly string[];
  }>;
  requestModelOverrideRuntimeOptions(
    coreConfig: MonoAgentConfig,
    compatibility: { readonly mcpSources: readonly string[]; readonly indexSkillsActive: boolean },
  ): {
    readonly extension: RuntimeOptionsExtension;
    readonly targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean;
    readonly targetsUnsupportedHistoryTool: (metadata: Record<string, unknown> | undefined) => boolean;
    readonly targetsPiNative: (metadata: Record<string, unknown> | undefined) => boolean;
  };
  buildRuntimeForModel(
    coreConfig: MonoAgentConfig,
  ): (model: RuntimeModelReference, executionMode?: RuntimeExecutionMode) => MonoRuntimeLike;
  observabilityContext(): Promise<{
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  }>;
  recordExporterWarning(warning: { readonly phase: string; readonly message: string }): void;
  recordSessionEvent(event: ConfiguredAgentSessionEvent, coreConfig: MonoAgentConfig): void;
}

/**
 * The channel whose conversations the reader already owns a session boundary
 * for. `tui` is the gui/operator channel behind both `mono-agent tui` and the
 * web console: each console thread has a permanent conversation id and an
 * explicit "new thread" action, so a daily bucket on top of it just severs a
 * live conversation at midnight — the next morning's follow-up woke with no
 * transcript and had to reconstruct it through RunHistory.
 */
const SELF_BOUNDED_CHANNEL_ID = "tui";

/** @internal deterministic composition contract used by focused tests. */
export function replyArtifactStorageMaxBytesForMcpApps(mcpAppsEnabled: boolean): number {
  return DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES
    - (mcpAppsEnabled ? DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES : 0);
}

/** The rollover policy this channel's responder runs under. */
export function sessionRolloverForChannel(
  channelId: ChannelId | undefined,
  configured: MonoAgentConfig["runtime"]["session"]["rollover"],
): MonoAgentConfig["runtime"]["session"]["rollover"] {
  return channelId === SELF_BOUNDED_CHANNEL_ID ? "none" : configured;
}

export async function buildResponder(
  controller: ResponderControllerPort,
  coreConfig: MonoAgentConfig,
  channelId?: ChannelId,
): Promise<AgentResponder> {
  const sandboxEngine = controller.sandboxEngineFor(coreConfig);
  const sessionRollover = sessionRolloverForChannel(channelId, coreConfig.runtime.session.rollover);
  const runtime = controller.runtime ?? createConfiguredAgentRuntime({
    config: coreConfig,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
  });
  if (!controller.activeRuntimes.includes(runtime)) {
    controller.activeRuntimes.push(runtime);
  }
  const memoryBackend = await controller.memoryStore(coreConfig);
  const memoryRetrieval = controller.ensureSharedMemoryRetrieval(coreConfig, memoryBackend);
  const memory = memoryRetrieval ?? memoryBackend;
  const memoryRecallEnabled = controller.reportMemoryRecallStatus(coreConfig, memoryRetrieval);
  const supermemoryMcp = controller.supermemoryMcpRuntimeOptions(coreConfig);
  const adapterSendTools = await controller.adapterSendToolsRuntimeOptions(coreConfig);
  const historyToolSupport = historyToolRouteSupport(coreConfig);
  const replyPartBudget = createReplyPartBudget();
  const mcpAppsEnabled = runtimeRouteSupportsMcpApps(coreConfig);
  const replyArtifactStorage = replyArtifactStorageBudgetFor(
    coreConfig.artifacts.dir,
    replyArtifactStorageMaxBytesForMcpApps(mcpAppsEnabled),
  );
  const artifactDerivedRoots = agentArtifactDerivedRoots(coreConfig.artifacts.dir);
  const continuationStateDir = (await loadContinuationSettings({
    cwd: controller.cwd,
    configPath: controller.configReadPath,
    env: controller.env,
  })).stateDir;
  const replyArtifactPrivateRoots = [
    resolve(controller.cwd, ".mono-agent"),
    controller.configPath,
    controller.configReadPath,
    coreConfig.context.identityPath,
    coreConfig.context.soulPath,
    coreConfig.context.skillsRoot,
    coreConfig.memory?.path,
    coreConfig.tools.mcpConfigPath,
    coreConfig.providers?.piAuthPath,
    coreConfig.providers?.piNative?.piSessionsRoot,
    coreConfig.traceability.registryDir,
    continuationStateDir,
    artifactDerivedRoots.history,
  ].filter((path): path is string => path !== undefined);
  const replyArtifacts = createReplyArtifactService({
    artifactDir: coreConfig.artifacts.dir,
    workspace: coreConfig.runtime.workspace,
    privateRoots: replyArtifactPrivateRoots,
    retentionDays: coreConfig.artifacts.retention.maxAgeDays,
    replyPartBudget,
    storageBudget: replyArtifactStorage,
  });
  const mcpApps = mcpAppsEnabled
    ? createMcpAppService({
        artifactDir: coreConfig.artifacts.dir,
        retentionDays: coreConfig.artifacts.retention.maxAgeDays,
        replyPartBudget,
        storageBudget: replyArtifactStorage,
      })
    : undefined;
  const mcpAppsBase = mcpApps?.createExtension;
  const replyArtifactsBase = isPublishReplyFileToolAllowed(coreConfig.tools)
    && !runtimeRouteContainsDirectOpenCode(coreConfig)
    ? replyArtifacts.createExtension
    : undefined;
  const runHistoryBase = isRunHistoryToolAllowed(coreConfig.tools)
    && historyToolSupport.runHistory
    ? createRunHistoryRuntimeExtension({
        artifactDir: coreConfig.artifacts.dir,
        ...(coreConfig.runtime.session.rollover === undefined
          ? {}
          : { rollover: coreConfig.runtime.session.rollover }),
        onUnavailable: (error) => {
          controller.logger?.warn?.("RunHistory tool endpoint could not start; continuing without prior-run inspection.", {
            reason: reasonOf(error),
          });
        },
      })
    : undefined;
  const sessionHistoryBase = isSessionHistoryToolAllowed(coreConfig.tools)
    && historyToolSupport.sessionHistory
    ? createSessionHistoryRuntimeExtension({
        historyRoot: resolve(coreConfig.artifacts.dir, "..", "history"),
        ...(coreConfig.runtime.session.rollover === undefined
          ? {}
          : { rollover: coreConfig.runtime.session.rollover }),
        onUnavailable: (error) => {
          controller.logger?.warn?.("SessionHistory tool endpoint could not start; lifecycle persistence remains active.", {
            reason: reasonOf(error),
          });
        },
      })
    : undefined;
  // Always active: a no-op for interactive turns (which carry no cron/webhook
  // metadata), it applies the per-trigger model/effort override otherwise.
  const mcpSources: string[] = [];
  if (coreConfig.tools.mcpConfigPath !== undefined) {
    try {
      const names = Object.keys(loadToolPolicyFromJsonFileSync(coreConfig.tools.mcpConfigPath).mcpServers ?? {});
      if (names.length > 0) mcpSources.push(`tools.mcpConfigPath (${names.join(", ")})`);
    } catch {
      // Responder construction owns the missing/malformed policy error.
    }
  }
  if (memoryRecallEnabled) mcpSources.push("memory.recallTool");
  if (supermemoryMcp !== undefined) mcpSources.push("memory.supermemory.exposeMcpServer");
  if (adapterSendTools.blockingToolNames.length > 0) {
    mcpSources.push(`adapter send tools (${adapterSendTools.blockingToolNames.join(", ")})`);
  }
  const requestModelOverride = controller.requestModelOverrideRuntimeOptions(coreConfig, {
    mcpSources,
    indexSkillsActive: coreConfig.context.skillDisclosure === "index"
      && coreConfig.context.skillsRoot !== undefined,
  });
  const adapterSendToolsExtension = adapterSendTools.createExtension?.(
    requestModelOverride.targetsDirectOpenCode,
  );
  const mcpAppsExtension: RuntimeOptionsExtension | undefined = mcpAppsBase === undefined
    ? undefined
    : async (requestInput) => requestModelOverride.targetsDirectOpenCode(requestInput.request.metadata)
      ? { runtimeOptions: {}, cleanup: async () => {} }
      : await mcpAppsBase(requestInput);
  const replyArtifactsExtension: RuntimeOptionsExtension | undefined = replyArtifactsBase === undefined
    ? undefined
    : async (requestInput) => requestModelOverride.targetsDirectOpenCode(requestInput.request.metadata)
      ? { runtimeOptions: {}, cleanup: async () => {} }
      : await replyArtifactsBase(requestInput);
  const processJobsExtension = controller.processJobsService === undefined
    ? undefined
    : createProcessJobsRuntimeExtension({
        service: controller.processJobsService,
        coreConfig,
        channelId,
        targetsPiNative: requestModelOverride.targetsPiNative,
      });
  const runHistoryExtension: RuntimeOptionsExtension | undefined = runHistoryBase === undefined
    ? undefined
    : async (requestInput) => requestModelOverride.targetsDirectOpenCode(requestInput.request.metadata)
      ? { runtimeOptions: {}, cleanup: async () => {} }
      : await runHistoryBase(requestInput);
  const sessionHistoryExtension: RuntimeOptionsExtension | undefined = sessionHistoryBase === undefined
    ? undefined
    : async (requestInput) => requestModelOverride.targetsUnsupportedHistoryTool(requestInput.request.metadata)
      ? { runtimeOptions: {}, cleanup: async () => {} }
      : await sessionHistoryBase(requestInput);
  const localConfigurationExtension = createLocalConfigurationRuntimeExtension({
    cwd: controller.cwd,
    configPath: controller.configPath,
    configReadPath: controller.configReadPath,
    env: controller.env,
  });
  const runtimeOptionsForRequest = composeRuntimeOptionExtensions([
    supermemoryMcp,
    runHistoryExtension,
    sessionHistoryExtension,
    mcpAppsExtension,
    replyArtifactsExtension,
    adapterSendToolsExtension,
    processJobsExtension,
    requestModelOverride.extension,
    // Last and authoritative: only an opaque owner-created configuration
    // session can replace the daemon's ordinary action/MCP surface.
    localConfigurationExtension,
  ], {
    // SELF-CONFIG stays proposal-only for writes, but may inspect this exact
    // read-only host history capability under its authoritative policy.
    preserveMcpServersUnderOverride: sessionHistoryExtension === undefined ? [] : [sessionHistoryExtension],
  });
  // The override factory is needed whenever the ROUTER is active, not merely
  // when backups exist: the router freezes the model chain, so an override must
  // run on a runtime whose chain has it as primary. A primary configured for
  // same-model retries gets a retry-only chain and is therefore routed too —
  // keying this off configured backups alone silently ran per-trigger overrides
  // on the chain primary instead of the requested model. Only a genuinely
  // unrouted runtime honors the per-run model directly.
  const runtimeForModel = runtimeUsesFallbackRouter(coreConfig.runtime)
    ? controller.buildRuntimeForModel(coreConfig)
    : undefined;
  const observabilityContext = await controller.observabilityContext();
  const postedReplyHistory = createSlackPostedReplyHistory({
    maxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    ...(coreConfig.runtime.session.rollover === undefined
      ? {}
      : { rollover: coreConfig.runtime.session.rollover }),
    ...(coreConfig.runtime.session.rolloverTimezone === undefined
      ? {}
      : { rolloverTimezone: coreConfig.runtime.session.rolloverTimezone }),
  });
  const responder = await createConfiguredAgentResponderForApp({
    config: coreConfig,
    cwd: controller.cwd,
    runtime,
    ...(runtimeForModel === undefined ? {} : { runtimeForModel }),
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    ...(memory !== undefined && { memory }),
    ...(controller.interactionBridge === undefined ? {} : { turnHistoryEnricher: controller.interactionBridge }),
    ...(controller.interactionBridge === undefined ? {} : { progressCapabilityIssuer: controller.interactionBridge }),
    ...(controller.continuationService === undefined
      ? {}
      : { continuationCapabilityIssuer: controller.continuationService }),
    ...(runtimeOptionsForRequest === undefined ? {} : { runtimeOptionsForRequest }),
    onMemoryRecallUnavailable: (error) => {
      controller.logger?.warn?.(
        "MemoryRecall tool endpoint could not start; continuing without the explicit tool.",
        { error: reasonOf(error) },
      );
    },
    onMemoryWarning: (message) => {
      controller.logger?.warn?.(message);
    },
    onToolHistoryWarning: (message) => {
      controller.logger?.warn?.(message);
    },
    // Thread run-identifying context onto exported spans and surface per-run
    // export warnings to `exporterStatus` (agent-host only builds the exporter
    // when config.observability.exporters is non-empty).
    observabilityContext,
    exporterWarn: (warning) => controller.recordExporterWarning(warning),
    onSessionEvent: (event) => controller.recordSessionEvent(event, coreConfig),
  }, {
    // Only the responder's own bucketing changes. RunHistory above keeps the
    // CONFIGURED policy on purpose: it strips `#YYYY-MM-DD` only under `daily`,
    // and dropping that here would hide every run this console thread already
    // recorded under a dated id from the un-dated id it now runs as.
    ...(sessionRollover === undefined ? {} : { sessionRollover }),
    wrapHistoryStore: postedReplyHistory.wrapHistoryStore,
    // Follow the local JSONL source of truth, not outer exporter work:
    // exporter start/finish may still be pending after the summary commits.
    onRunArtifactCommitted: ({ conversationId }) => {
      if (isNotifyDestinationConversationId(conversationId)) {
        controller.seenNotifyDestinations.invalidate();
      }
    },
  });
  const replyResponder = replyArtifacts.wrapResponder(responder);
  const richReplyResponder = postedReplyHistory.wrapResponder(
    mcpApps === undefined ? replyResponder : mcpApps.wrapResponder(replyResponder),
  );
  return bindProcessJobWakeContextToResponder(richReplyResponder);
}

export function requestModelOverrideRuntimeOptions(
  controller: ResponderControllerPort,
  coreConfig: MonoAgentConfig,
  compatibility: { readonly mcpSources: readonly string[]; readonly indexSkillsActive: boolean },
): {
  readonly extension: RuntimeOptionsExtension;
  readonly targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean;
  readonly targetsUnsupportedHistoryTool: (metadata: Record<string, unknown> | undefined) => boolean;
  readonly targetsPiNative: (metadata: Record<string, unknown> | undefined) => boolean;
} {
  const options = {
    ...(controller.logger === undefined ? {} : { logger: controller.logger }),
    baseModel: coreConfig.runtime.model,
    ...(configuredRuntimeFallbackModels(coreConfig.runtime).length === 0
      ? {}
      : { fallbackModels: configuredRuntimeFallbackModels(coreConfig.runtime) }),
    ...(coreConfig.runtime.effort === undefined ? {} : { baseEffort: coreConfig.runtime.effort }),
    ...(coreConfig.runtime.maxTurns === undefined ? {} : { baseMaxTurns: coreConfig.runtime.maxTurns }),
    ...(compatibility.mcpSources.length === 0 ? {} : { mcpSources: compatibility.mcpSources }),
    ...(compatibility.indexSkillsActive ? { indexSkillsActive: true } : {}),
    ...(coreConfig.sandbox === undefined ? {} : { sandboxPolicy: coreConfig.sandbox }),
    toolPolicy: coreConfig.tools,
    ...(coreConfig.providers?.local === undefined ? {} : { localProviders: coreConfig.providers.local }),
  };
  const extension = createRequestModelOverrideRuntimeExtension(options);
  return {
    extension: async (input) => extension({ request: input.request }),
    targetsDirectOpenCode: (metadata) => requestModelOverrideTargetsDirectOpenCode(metadata, options),
    targetsUnsupportedHistoryTool: (metadata) => requestModelOverrideTargetsUnsupportedHistoryTool(metadata, options),
    targetsPiNative: (metadata) => requestModelOverrideTargetsPiNative(metadata, options),
  };
}

export function buildRuntimeForModel(
  controller: ResponderControllerPort,
  coreConfig: MonoAgentConfig,
): (model: RuntimeModelReference, executionMode?: RuntimeExecutionMode) => MonoRuntimeLike {
  const cache = new Map<string, MonoRuntimeLike>();
  const sandboxEngine = controller.sandboxEngineFor(coreConfig);
  return (model, executionMode) => {
    const key = `${modelReferenceKey(model)}|${executionMode ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const runtime = createConfiguredAgentRuntime({
      config: coreConfig,
      model,
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    });
    cache.set(key, runtime);
    controller.activeRuntimes.push(runtime);
    return runtime;
  };
}

export function supermemoryMcpRuntimeOptions(controller: ResponderControllerPort, coreConfig: MonoAgentConfig): RuntimeOptionsExtension | undefined {
  const memory = coreConfig.memory;
  if (memory?.backend !== "supermemory" || memory.supermemory?.exposeMcpServer !== true) {
    return undefined;
  }
  const apiKey = memory.supermemory.apiKey;
  if (apiKey === undefined) {
    controller.logger?.warn?.(
      "memory.supermemory.exposeMcpServer is on but no apiKey is set; the hosted Supermemory MCP server (cloud-only) was not injected.",
    );
    return undefined;
  }
  controller.logger?.info?.("Supermemory hosted MCP server injected (cloud-only).");
  const entry = {
    supermemory: {
      type: "http",
      url: "https://mcp.supermemory.ai/mcp",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  };
  return async () => ({ runtimeOptions: { mcpServers: entry }, cleanup: async () => {} });
}

export async function adapterSendToolsRuntimeOptions(controller: ResponderControllerPort, coreConfig: MonoAgentConfig): Promise<{
  readonly createExtension?: (
    targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
  ) => RuntimeOptionsExtension;
  readonly blockingToolNames: readonly string[];
}> {
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
  const bridgeEnv = controller.interactionBridge?.env();
  const appOwnedInteraction = controller.interactionBridge === undefined || bridgeEnv === undefined
    ? undefined
    : {
        bridgeUrl: controller.interactionBridge.url,
        bridgeToken: controller.interactionBridge.token,
        timeoutMs: Number(bridgeEnv.MONO_AGENT_ASK_USER_TIMEOUT_MS),
      };
  const settings = await resolveAdapterSendToolsSettings(input, {
    allowedTools: coreConfig.tools.allowedTools,
    disallowedTools: coreConfig.tools.disallowedTools,
    logger: controller.logger,
    suppressInteractionTools: runtimeRouteContainsDirectOpenCode(coreConfig),
    ...(appOwnedInteraction === undefined ? {} : { interaction: appOwnedInteraction }),
  });
  if (settings === undefined) {
    return { blockingToolNames: [] };
  }
  const toolNames = adapterSendToolNames(settings);
  const blockingToolNames = toolNames.filter((name) => !isInteractionToolName(name));
  controller.logger?.info?.("Adapter send tools enabled.", { tools: toolNames });
  // Forward the posted-message index path so `SlackSendMessage` links each post
  // back to the producing conversation (so a later in-thread reply resumes it).
  const indexPath = resolvePostedMessageIndexPath(await resolveAppArtifactDir(input));
  const interactionForChild = settings.askUser;
  const runOutputRoot = settings.telegram?.sendTools?.pathScope === "run-output"
    ? agentArtifactDerivedRoots(coreConfig.artifacts.dir).outbound
    : undefined;
  const createExtension = (
    targetsDirectOpenCode: (metadata: Record<string, unknown> | undefined) => boolean,
  ): RuntimeOptionsExtension => async (requestInput) => {
    const effectiveToolNames = targetsDirectOpenCode(requestInput.request.metadata)
      ? toolNames.filter((name) => !isInteractionToolName(name))
      : toolNames;
    if (effectiveToolNames.length === 0) {
      return { runtimeOptions: {}, cleanup: async () => {} };
    }
    const effectiveInteraction = effectiveToolNames.some(isInteractionToolName)
      ? interactionForChild
      : undefined;
    return await createAdapterSendToolsRuntimeExtension(
      controller.configReadPath,
      controller.cwd,
      effectiveToolNames,
      indexPath,
      effectiveInteraction,
      runOutputRoot,
      controller.interactionBridge,
    )(requestInput);
  };
  return { createExtension, blockingToolNames };
}

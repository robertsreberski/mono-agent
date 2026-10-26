import { completeContinuityUpkeep } from "@mono-agent/turn/host";
import { assertSupportedSessionsRoot } from "../conversation-admin/sessions-root.js";
import type { ConversationHistoryTurnInspection } from "@mono-agent/conversation";
import { persistedWebDeliveryId, serializeNativeSwitchHarness } from "./configured-native-switch.js";
import { implicitModelRuntimeOptions } from "./request-model-override.js";
import { effectiveSandboxBoundary } from "../service/sandbox/effective-sandbox.js";
import { configuredToolPolicyInput as toolPolicyInput } from "../host/computer-use.js";
import { isLiveSubagentInstance } from "../subagents/subagent-instances.js";
import {
  createConversationHarness,
  createSessionRuntimeResolver,
  createConversationResponder,
  createDurableHistoryStore,
  createToolPolicy,
} from "@mono-agent/conversation";
import type {
  ConversationHarness,
  ConversationHarnessOptions,
  ConversationHarnessRequest,
} from "@mono-agent/conversation";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { isNativeNotifyRequest, isSilentTurnAlreadyVisible, setToolActivityPathRoots } from "@mono-agent/contracts";
import { processJobWakeContextForRequest } from "../process-jobs/process-jobs-context.js";
import type { AgentResponder } from "@mono-agent/contracts";
import { MonoAgentConfigError, assertNoRetiredMonoAgentConfig } from "@mono-agent/config";
import { monoRuntimeSupportsSessionResume } from "@mono-agent/turn/host";
import { createManagedNativeJournalStorage } from "@mono-agent/turn/ai";
import { modelReferenceKey, parseMonoRuntimeModelReference, runtimeOptionsForLocalProvider } from "@mono-agent/turn/host/config";
import type {
  RuntimeModelReference,
} from "@mono-agent/turn/host/types";

import { agentArtifactDerivedRoots } from "../artifacts/agent-artifact-paths.js";
import { createConversationHistoryRuntimeExtension, isConversationHistoryToolAllowed } from "../request-tools/conversation-history.js";
import { createToolOutputArtifactsRuntimeExtension } from "../artifacts/tool-output-artifacts.js";
import {
  acquireAgentRootOwnership,
  assertAgentRootLeaseOutsideWorkspace,
  releaseAgentRootOwnershipWhenIdle,
} from "../durable-state/agent-root-coordinator.js";
import { resolveMemoryRecallSettings } from "../memory/memory-recall-settings.js";
import {
  createMemoryJournalRuntimeExtension,
  isMemoryJournalCapableStore,
  isMemoryJournalToolAllowed,
} from "../memory/memory-journal.js";
import { createPeerAgentRuntimeExtension } from "../peers/peer-agent.js";
import { verifyPeerOperatorHandoff } from "../peers/peer-provenance.js";
import {
  createSharedMemoryRecallRuntimeExtension,
  MemoryRetrievalService,
} from "../memory/memory-retrieval.js";
import {
  createMemoryRememberRuntimeExtension,
  isRememberCapableStore,
  isRememberToolAllowed,
} from "../memory/memory-remember.js";
import {
  clearSessionsSandboxPolicy,
  composeRuntimeOptionExtensions,
  createClearSessionsRuntimeExtension,
  type ClearSessionsRuntimeBoundaryOptions,
} from "./runtime-option-extensions.js";
import {
  configuredRuntimeFallbackModels,
  runtimeUsesFallbackRouter,
} from "./runtime-routes.js";
import {
  resolveProcessJobsProtectionPosture,
} from "../process-jobs/process-jobs-protection.js";
import {
  createProcessJobsRuntimeExtension,
  processJobsAvailableForRequest,
  backgroundSubagentsAvailableForRequest,
} from "../process-jobs/process-jobs-runtime.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  loadProcessJobsRootRegistryProtection,
  processJobsProtectionPolicyRoots,
  registerProcessJobsRoot,
} from "../process-jobs/process-jobs-root-registry.js";
import { activeProjectSkillSelections, isRetiredProjectSkillName } from "../skills/project-skills.js";

import type {
  ConfiguredAgentInternalHooks,
  ConfiguredAgentResponderOptions,
  ConfiguredConversationHarnessOptions,
  ConversationHarnessSessionOptionsWithEvents,
} from "./configured-agent-options.js";
import { composeRunRecorder, recorderCompositionDeps } from "./run-recording.js";
import { lazyConfiguredToolHistory } from "./configured-tool-history.js";
import {
  configuredSandboxEngine,
  configRuntimeFlags, runtimeHostOptionsForConfig,
  mergeStaticRuntimeOptions,
} from "./configured-runtime-options.js";
import { configuredMemoryForHarness, createConfiguredMemoryInternal } from "./configured-memory.js";
import { buildSubagentsOptions, createSubagentsRuntimeExtension, createConfiguredSubagentRegistry, bindConfiguredManagedSubagents } from "./configured-subagents.js";
import { createConfiguredAgentRuntimeForApp } from "./configured-runtime.js";
import { configuredRoutesOnlyPiNative } from "./configured-runtime-routes.js";
import { harnessWithAgentRootOwnership } from "./runtime-ownership.js";

export async function createConfiguredConversationHarness(options: ConfiguredConversationHarnessOptions): Promise<ConversationHarness> {
  return await createConfiguredConversationHarnessInternal(options);
}

async function createConfiguredConversationHarnessInternal(
  options: ConfiguredConversationHarnessOptions,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<ConversationHarness> {
  const config = options.config;
  assertNoRetiredMonoAgentConfig(config);
  await assertSupportedSessionsRoot(config.runtime.session.root);
  const switchConfig = config.runtime.session.modelSwitch;
  if (switchConfig?.enabled === true) {
    if (config.runtime.session.mode !== "continuous") throw new MonoAgentConfigError("invalid_json",
      "Web model switching requires continuous sessions.", { path: "runtime.session.mode" });
    if (!config.runtime.session.root) throw new MonoAgentConfigError("invalid_json",
      "Web model switching requires durable runtime.session.root.", { path: "runtime.session.root" });
  }
  // Config opt-in is not inferred from runtime capabilities; native storage
  // authority remains lazy and owner-held.
  const nativeModelSwitch = switchConfig?.enabled === true
    ? { native: createManagedNativeJournalStorage({ sessionsRoot: config.runtime.session.root! }) }
    : undefined;
  const recording = await recorderCompositionDeps(config, options, internalHooks);
  const ownership = await acquireAgentRootOwnership(options.cwd ?? process.cwd());
  const agentRoot = ownership.agentRoot;
  let ownershipTransferred = false;
  try {
  assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
  const loadedProcessJobsRegistry = internalHooks.processJobs?.registry
    ?? (internalHooks.bootstrapProcessJobs?.stateDir === undefined
      ? await loadProcessJobsRootRegistryProtection(ownership.agentRoot, config.runtime.workspace)
      : (await registerProcessJobsRoot({
          agentRoot: ownership.agentRoot,
          workspace: config.runtime.workspace,
          stateDir: internalHooks.bootstrapProcessJobs.stateDir,
          coordinator: ownership.coordinator,
        })).snapshot);
  const processJobsRegistry = loadedProcessJobsRegistry.kind === "failed"
    ? loadedProcessJobsRegistry
    : await attestProcessJobsRootRegistrySnapshot(
        loadedProcessJobsRegistry,
        config.runtime.workspace,
      );
  ownership.coordinator.synchronizeGeneration(processJobsRegistry.generation);
  const processJobsProtectionPosture = internalHooks.processJobs?.protectionPosture
    ?? resolveProcessJobsProtectionPosture({
      settings: internalHooks.bootstrapProcessJobs?.settings
        ?? { enabled: false, unsafeAllowUnprotectedState: false },
      registry: processJobsRegistry,
      coreConfig: config,
    });
  const processJobsProtectedRoots = processJobsProtectionPolicyRoots(processJobsRegistry);
  const artifactDerivedRoots = agentArtifactDerivedRoots(config.artifacts.dir);
  // Chat activity lines are formatted deep in the streaming layer, which has no
  // per-message workspace to hand down. Without this the root falls back to
  // `process.cwd()` — for a service-managed agent, whatever directory the
  // supervisor started it in — and tool previews expose the full machine layout.
  setToolActivityPathRoots({ workspaceRoot: config.runtime.workspace, homeDir: homedir() });
  const model = options.model ?? config.runtime.model;
  const fallbackModels = configuredRuntimeFallbackModels(config.runtime);
  const boundary = effectiveSandboxBoundary({ config, posture: processJobsProtectionPosture,
    protectedRoots: processJobsProtectedRoots });
  // Keep overlay authority available for a later inactive-to-retained transition,
  // but do not inject an engine into ordinary off/omitted execution.
  const protectionSandboxEngine = processJobsProtectionPosture.suppressSyntheticSandbox
    ? undefined : configuredSandboxEngine(options.sandboxEngine);
  const sandboxEngine = boundary.requiresEngine ? protectionSandboxEngine : undefined;
  const harnessSandboxPolicy = boundary.policy;
  const runtime = options.runtime ?? createConfiguredAgentRuntimeForApp({
    config,
    cwd: agentRoot,
    model,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
  }, {
    suppressSandboxEngine: !boundary.requiresEngine,
  });
  const runtimeForSession = createSessionRuntimeResolver({ runtime, model,
    ...(options.runtimeForModel === undefined ? {} : { runtimeForModel: options.runtimeForModel }),
  });
  const runtimeForModel = options.runtimeForModel === undefined ? undefined
    : (target: RuntimeModelReference) => runtimeForSession(modelReferenceKey(target));
  const clearSessionsBoundaryOptions = {
    cwd: agentRoot,
    ...(harnessSandboxPolicy === undefined ? {} : { sandboxPolicy: harnessSandboxPolicy }),
    ...(processJobsProtectionPosture.suppressSyntheticSandbox
      ? { suppressSyntheticSandbox: true }
      : {}),
  } satisfies ClearSessionsRuntimeBoundaryOptions;
  const routedClearSessionsPolicy = runtimeUsesFallbackRouter(config.runtime)
    ? clearSessionsSandboxPolicy(clearSessionsBoundaryOptions)
    : undefined;
  // Request policy is still attested and applied per turn below. Configure the
  // same stable engine/policy into the routed ToolContext so Pi filesystem
  // builtins resolve their native boundary there; per-route-native projection
  // clears both fields from every non-Pi attempt.
  runtime.configureTools?.({
    workspace: config.runtime.workspace,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    ...(routedClearSessionsPolicy === undefined ? {} : { sandboxPolicy: routedClearSessionsPolicy }),
  });
  // The memory LLM must NOT ride the channel `runtime`: that runtime carries the
  // channel fallback chain whose primary is `config.runtime.model`, and the
  // fallback router overrides each run's per-call `model` — so reusing it would
  // execute memory capture on `config.runtime.model` instead of
  // `config.memory.llm.model`. createConfiguredMemory builds the memory LLM its own
  // fallback-free runtime when no `memoryRuntime` is injected.
  const configuredMemory = options.memory ?? (await createConfiguredMemoryInternal(
    config,
    {
      cwd: agentRoot,

    },
    processJobsProtectionPosture,
  ));
  const memory = configuredMemoryForHarness(config, configuredMemory);
  const memoryReadToolsEnabled = resolveMemoryRecallSettings(config) !== undefined;
  const memoryRecall = !memoryReadToolsEnabled
    || !(memory instanceof MemoryRetrievalService)
    ? undefined
    : createSharedMemoryRecallRuntimeExtension(memory, {
        ...(options.onMemoryRecallUnavailable === undefined
          ? {}
          : { onUnavailable: options.onMemoryRecallUnavailable }),
      });
  // Chronological enumeration shares the explicit memory-read switch with
  // MemoryRecall, but additionally follows normal app-tool policy and requires
  // an affirmative local capability. External search backends stay incapable.
  const memoryJournal = !memoryReadToolsEnabled
    || !(memory instanceof MemoryRetrievalService)
    || !isMemoryJournalCapableStore(memory)
    || !isMemoryJournalToolAllowed(config.tools)
    ? undefined
    : createMemoryJournalRuntimeExtension(memory, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.onMemoryJournalUnavailable === undefined
          ? {}
          : { onUnavailable: options.onMemoryJournalUnavailable }),
      });
  // The durable write surface is gated three ways: the store must affirm the
  // capability (a read-only or external backend never does), the operator must
  // not have disabled it, and tool policy must allow it. Unlike MemoryRecall it
  // is allowlist-gated, so an operator can withhold writes while keeping recall.
  const memoryRemember = config.memory?.rememberTool?.enabled === false
    || !(memory instanceof MemoryRetrievalService)
    || !isRememberCapableStore(memory)
    || !isRememberToolAllowed(config.tools)
    ? undefined
    : createMemoryRememberRuntimeExtension(memory, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.onMemoryRememberUnavailable === undefined
          ? {}
          : { onUnavailable: options.onMemoryRememberUnavailable }),
      });
  const subagentDeps = { runtime, baseModel: model, ...(runtimeForModel === undefined ? {} : { runtimeForModel }) };
  const instanceRegistry = createConfiguredSubagentRegistry({
    config, runtime, agentRoot, processJobsRegistry, processJobs: internalHooks.processJobs,
    harnessSandboxPolicy, clearSessionsBoundaryOptions, sandboxEngine,
  });
  bindConfiguredManagedSubagents(config, instanceRegistry, internalHooks.processJobs);
  const persistentSubagents = instanceRegistry === undefined ? undefined
    : createSubagentsRuntimeExtension(config, subagentDeps, instanceRegistry);
  const peerAgent = createPeerAgentRuntimeExtension({
    config, service: internalHooks.processJobs?.service,
    channelId: internalHooks.processJobs?.channelId,
    conversationScheme: internalHooks.processJobs?.conversationScheme,
  });
  const conversationHistory = internalHooks.conversationHistoryExtension === null || config.runtime.session.continuity?.enabled === false || !isConversationHistoryToolAllowed(config.tools)
    ? undefined : internalHooks.conversationHistoryExtension ?? createConversationHistoryRuntimeExtension({
      historyRoot: artifactDerivedRoots.history,
      rollover: internalHooks.sessionRollover ?? config.runtime.session.rollover ?? "none",
      onUnavailable: () => options.onToolHistoryWarning?.("ConversationHistory endpoint could not start; retained evidence is unavailable this run."),
    });
  const composedRuntimeOptionsForRequest = composeRuntimeOptionExtensions([
    ({ request }) => {
      const admitted = () => {
        const wake = processJobWakeContextForRequest(request);
        return !isSilentTurnAlreadyVisible(request)
          && ((wake.kind === "resolved" && wake.context.pendingQuestion !== true)
            || isNativeNotifyRequest(request));
      };
      return admitted() && (request.attachments?.length ?? 0) === 0
        ? { runtimeOptions: { finishSilentlyController: {
            eligible: () => !request.abortSignal.aborted && admitted()
              && (request.attachments?.length ?? 0) === 0,
          } } }
        : {};
    },
    peerAgent,
    conversationHistory,
    memoryRecall,
    memoryJournal,
    memoryRemember,
    options.runtimeOptionsForRequest,
    persistentSubagents,
  ], {
    // The app-owned, read-only MemoryRecall endpoint is part of every configured
    // memory tier. Preserve only this exact extension under an authenticated
    // request override; arbitrary caller/action MCP extensions remain excluded.
    preserveMcpServersUnderOverride: memoryRecall === undefined ? [] : [memoryRecall],
  });
  const clearSessionsRuntimeOptionsForRequest = createClearSessionsRuntimeExtension(
    composedRuntimeOptionsForRequest,
    clearSessionsBoundaryOptions,
  );
  const processJobsRuntimeOptionsForRequest = createProcessJobsRuntimeExtension({
    next: clearSessionsRuntimeOptionsForRequest,
    ownership,
    registry: processJobsRegistry,
    service: internalHooks.processJobs?.service,
    coreConfig: config,
    baseModel: model,
    channelId: internalHooks.processJobs?.channelId,
    conversationScheme: internalHooks.processJobs?.conversationScheme,
    sandboxEngine: protectionSandboxEngine,
    protectionPosture: processJobsProtectionPosture,
    routesOnlyPiNative: internalHooks.processJobs?.routesOnlyPiNative
      ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
  });
  const toolOutputArtifactRoot = resolvePath(config.artifacts.dir, "tool-output");
  const runtimeOptionsForRequest = createToolOutputArtifactsRuntimeExtension(
    processJobsRuntimeOptionsForRequest,
    toolOutputArtifactRoot,
  );
  const subagents = buildSubagentsOptions(config, {
    runtime,
    baseModel: model,
    ...(runtimeForModel === undefined ? {} : { runtimeForModel }),
  });
  const runtimeOptions = mergeStaticRuntimeOptions(
    runtimeOptionsForLocalProvider(model, config.providers?.local),
    configRuntimeFlags(config),
    sandboxEngine === undefined ? undefined : { sandboxEngine },
    subagents,
    options.runtimeOptions,
  );
  const sessionOptions: ConversationHarnessSessionOptionsWithEvents = {
    mode: config.runtime.session.mode,
    idleTimeoutMs: config.runtime.session.idleTimeoutMs,
    // Continuous sessions belong to the primary's first attempt. The router
    // strips session state from retries and backups and withholds their resumable
    // result id; an unsynchronized durable answer rotates the epoch before the next turn.
    supportsResume: supportsSessionResume(),
    ...(config.runtime.session.isolateProactive === undefined
      ? {}
      : { isolateProactive: config.runtime.session.isolateProactive }),
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    ...(options.terminalRecoverySettlementMs === undefined
      ? {}
      : { terminalRecoverySettlementMs: options.terminalRecoverySettlementMs }),
  };
  const sessionsRoot = config.runtime.session.root;
  const retireDurableSession = runtime.retireDurableSession?.bind(runtime);
  const historyRoot = artifactDerivedRoots.history;
  const rollover = internalHooks.sessionRollover ?? config.runtime.session.rollover;
  const toolHistory = lazyConfiguredToolHistory({
    root: historyRoot,
    continuityEnabled: options.historyStore === undefined && config.runtime.session.continuity?.enabled !== false,
    packEnabled: config.runtime.session.continuity?.packEnabled !== false,
    ledgerEnabled: config.runtime.session.continuity?.ledgerEnabled === true,
    ...(config.runtime.session.continuity?.upkeep?.enabled ? { upkeep: { enabled: true,
      get model() { return (config.runtime.session.continuity?.upkeep?.extractionModel ?? config.runtime.model).reference; },
      recorderNamespace: recording.artifactDir,
      complete: async (prompt: string, signal: AbortSignal, budget?: { operationId: string; inputTokens: 64000 | 128000 }) => {
        const selected = config.runtime.session.continuity?.upkeep?.extractionModel ?? config.runtime.model;
        return await completeContinuityUpkeep(prompt, { ...runtimeHostOptionsForConfig(config), ...mergeStaticRuntimeOptions(runtimeOptionsForLocalProvider(selected, config.providers?.local), configRuntimeFlags(config), options.runtimeOptions),
          model: selected, abortSignal: signal, messages: [] }, config.runtime.session.continuity?.upkeep?.requireRequestCap === true, budget);
      } } } : {}),
    conversationHistoryAvailable: conversationHistory !== undefined,
    artifactRoot: toolOutputArtifactRoot,
    rollover,
    ...(options.onToolHistoryWarning === undefined
      ? {}
      : { onWarning: options.onToolHistoryWarning }),
  });
  const baseHistoryStore = options.historyStore ?? createDurableHistoryStore({
    root: historyRoot,
    ...(toolHistory.continuity === undefined ? {} : { continuity: toolHistory.continuity }),
    maxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    ...(nativeModelSwitch === undefined ? {} : { nativeJournalStorage: nativeModelSwitch.native }),
    ...(sessionsRoot === undefined || retireDurableSession === undefined
      ? {}
      : {
          ...(runtime.sessionTurnReconciliation !== "v1" || runtime.reconcileSessionTurn === undefined ? {} : {
            reconcileProviderSessionTurn: async (request: ConversationHistoryTurnInspection) => {
              const owner = runtimeForSession(request.modelKey);
              if (owner.sessionTurnReconciliation !== "v1" || owner.reconcileSessionTurn === undefined) throw new Error("Session owner cannot reconcile native turn evidence.");
              const selected = parseMonoRuntimeModelReference(request.modelKey);
              return await owner.reconcileSessionTurn({ descriptor: request.descriptor, purpose: request.purpose,
                ...(request.includeContinuity ? { includeContinuity: true } : {}),
                expectedInputs: request.expectedInputs, sessionsRoot: sessionsRoot,
                expectedModel: { provider: selected.provider, id: selected.model } });
            },
          }),
          retireProviderSession: async (providerSessionId: string, modelKey?: string): Promise<void> => {
            const owner = runtimeForSession(modelKey);
            if (owner.retireDurableSession === undefined) {
              throw new Error("Session owner cannot retire durable provider state.");
            }
            // Durable retirement detaches an open Pi handle before unlinking;
            // ordinary invalidation alone rejects while a cancelled turn unwinds.
            await owner.retireDurableSession(providerSessionId, sessionsRoot);
            if (owner.invalidateSession !== undefined) await owner.invalidateSession(providerSessionId);
            else await owner.disposeSession?.(providerSessionId);
          },
        }),
  });
  const historyStore = internalHooks.wrapHistoryStore?.(baseHistoryStore) ?? baseHistoryStore;
  // Conversation history and managed-tool history are distinct contracts. A
  // caller-supplied message store remains the sole message-history owner, while
  // the configured app keeps its independent lifecycle sidecar and
  // SessionHistory capability. Continuity borrows the default store owner;
  // acquisition stays lazy until a canonical mutation or managed-tool event.


  try {
    const harnessOptions: ConversationHarnessOptions = {
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    ...(config.context.skillMaxBytes === undefined ? {} : { skillMaxBytes: config.context.skillMaxBytes }),
    ...(config.context.skillDisclosure === undefined
      ? {}
      : {
          // Index disclosure inventories every installed skill, not only selected
          // ones. Until the explicit updater retires the legacy file, fall back
          // to selected-body loading so that stale configure instructions cannot
          // re-enter through ReadSkill.
          skillDisclosure: config.context.skillDisclosure === "index"
            && config.context.selectedSkills.some(isRetiredProjectSkillName)
            ? "full"
            : config.context.skillDisclosure,
        }),
    selectedSkills: activeProjectSkillSelections(config.context.selectedSkills),
    runtime,
    model,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    ...(config.runtime.maxTurns === undefined ? {} : { maxTurns: config.runtime.maxTurns }),
    ...(config.runtime.session.root === undefined
      ? {}
      : { sessionsRoot: config.runtime.session.root }),
    session: sessionOptions,
    ...(config.concurrency?.maxConcurrentRuns === undefined && config.concurrency?.maxPendingRuns === undefined
      ? {}
      : {
          concurrency: {
            ...(config.concurrency?.maxConcurrentRuns === undefined
              ? {}
              : { maxConcurrentRuns: config.concurrency.maxConcurrentRuns }),
            ...(config.concurrency?.maxPendingRuns === undefined
              ? {}
              : { maxPendingRuns: config.concurrency.maxPendingRuns }),
          },
        }),
    runtimeOptions,
    ...(instanceRegistry === undefined ? {} : { subagentInstancesFor: async ({ request }: { request: ConversationHarnessRequest }) =>
      (await (await instanceRegistry.open(request.conversationId)).list()).filter(isLiveSubagentInstance).slice(0, 12).map((record) => ({
        id: record.id, name: record.name, status: record.status, turns: record.turns,
        ...(record.reservation || record.recoveryJobId ? { jobId: record.reservation?.token ?? record.recoveryJobId } : {}),
        ...(record.recoveryBlocked ? { recoveryBlocked: true } : {}),
        ...(record.pendingQuestion ? { pendingQuestion: record.pendingQuestion } : {}),
        ageMs: Math.max(0, Date.now() - record.updatedAt),
        route: [record.definition.model?.reference, record.definition.effort].filter(Boolean).join("/"),
      })) }),
    ...(runtimeOptionsForRequest === undefined
      ? {}
      : { runtimeOptionsForRequest }),
    ...(options.runtimeOptionsForManualCompaction === undefined
      ? {}
      : { runtimeOptionsForManualCompaction: options.runtimeOptionsForManualCompaction }),
    // Same predicate the process-jobs extension uses, so the session block only
    // describes backgrounding on turns whose Exec/Bash actually offer it.
    verifiedPeerCallerFor: async ({ request }) => {
      if (request.metadata?.source !== "acp" || request.metadata.peerHandoff === undefined) return undefined;
      const verified = await verifyPeerOperatorHandoff(config.artifacts.dir, request.metadata.peerHandoff,
        request.conversationId, request.userMessage, config.traceability.sourceId);
      return verified?.caller;
    },
    backgroundSubagentsAvailable: (input) => backgroundSubagentsAvailableForRequest(input, {
      service: internalHooks.processJobs?.service,
      coreConfig: config,
      channelId: internalHooks.processJobs?.channelId,
      conversationScheme: internalHooks.processJobs?.conversationScheme,
      routesOnlyPiNative: internalHooks.processJobs?.routesOnlyPiNative
        ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
    }),
    backgroundProcessJobsAvailable: (input) => processJobsAvailableForRequest(input, {
      service: internalHooks.processJobs?.service,
      coreConfig: config,
      channelId: internalHooks.processJobs?.channelId,
      conversationScheme: internalHooks.processJobs?.conversationScheme,
      routesOnlyPiNative: internalHooks.processJobs?.routesOnlyPiNative
        ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
    }),
    ...(config.tools.mcpRequestContextServers === undefined
      ? {}
      : {
          mcpRequestContext: {
            serverNames: config.tools.mcpRequestContextServers,
            runOutputRoot: artifactDerivedRoots.outbound,
            ...(options.progressCapabilityIssuer === undefined
              ? {}
              : { progressCapabilityIssuer: options.progressCapabilityIssuer }),
          },
        }),
    ...(config.tools.continuationServers === undefined || options.continuationCapabilityIssuer === undefined
      ? {}
      : {
          continuationContext: {
            serverNames: config.tools.continuationServers,
            capabilityIssuer: options.continuationCapabilityIssuer,
          },
        }),
    ...(runtimeForModel === undefined ? {} : { runtimeForModel }),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    ...(config.memory?.capture?.cron === undefined ? {} : { memoryCaptureCron: config.memory.capture.cron }),
    ...(config.memory?.capture?.webhook === undefined ? {} : { memoryCaptureWebhook: config.memory.capture.webhook }),
    memoryRememberEnabled: memoryRemember !== undefined,
    memoryRememberDetails: memoryRemember !== undefined && memory instanceof MemoryRetrievalService
      && memory.supportsRememberDetails(),
    ...(options.onMemoryWarning === undefined ? {} : { onMemoryWarning: options.onMemoryWarning }),
    historyStore,
    toolHistory,
    ...(options.turnHistoryEnricher === undefined ? {} : { turnHistoryEnricher: options.turnHistoryEnricher }),
    // Inbound channel attachments are saved here (under the artifacts dir, which
    // sits inside a sandbox-readable root) so the agent can open them by path.
    attachmentsDir: artifactDerivedRoots.attachments,
    toolPolicy: createToolPolicy(toolPolicyInput(config, options.onComputerUseWarning ?? console.warn)),
    ...(harnessSandboxPolicy === undefined ? {} : { sandboxPolicy: harnessSandboxPolicy }),
    recorderFactory: ({ runId, conversationId, userInput, source, sourceDetail, isolated }) =>
      composeRunRecorder(recording, {
        runId,
        conversationId,
        runKind: "channel",
        ...(isolated === undefined ? {} : { isolated }),
        ...(userInput === undefined ? {} : { userInput }),
        ...(source === undefined ? {} : { source }),
        ...(sourceDetail === undefined ? {} : { sourceDetail }),
      }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    };
    const harness = nativeModelSwitch === undefined
      ? createConversationHarness(harnessOptions)
      : createConversationHarness(harnessOptions, {
      nativeModelSwitch: {
        ...nativeModelSwitch,
        sessionsRoot: sessionsRoot ?? "",
        deliveryId: persistedWebDeliveryId,
        // Reuse endpoint/effort/1M selection without changing request metadata
        // identity (which carries out-of-band host capabilities).
        implicitModel: async (request, modelKey) => ({ model: parseMonoRuntimeModelReference(modelKey), runtimeOptions: await implicitModelRuntimeOptions({ baseModel: model,
          ...(config.runtime.context1MModels === undefined ? {} : { context1MModels: config.runtime.context1MModels }),
          ...(config.runtime.effort === undefined ? {} : { baseEffort: config.runtime.effort }),
          ...(config.runtime.fallbacks === undefined ? {} : { fallbackRoutes: config.runtime.fallbacks }),
          ...(config.providers?.local === undefined ? {} : { localProviders: config.providers.local }) }, request.metadata, modelKey) }),
      },
    });
    ownershipTransferred = true;
    const owned = harnessWithAgentRootOwnership(harness, ownership);
    return nativeModelSwitch === undefined ? owned : serializeNativeSwitchHarness(owned, ownership.agentRoot, historyStore);

  } catch (error) {
    await toolHistory?.release?.().catch(() => undefined);
    throw error;
  }
  } finally {
    if (!ownershipTransferred) {
      await releaseAgentRootOwnershipWhenIdle(ownership).catch(() => undefined);
    }
  }
}

export async function createConfiguredAgentResponder(options: ConfiguredAgentResponderOptions): Promise<AgentResponder> {
  return await createConfiguredAgentResponderInternal(options);
}

/**
 * @internal Application-composition seam. This is deliberately absent from the
 * package root so cache bookkeeping does not enlarge the supported harness API.
 */
export async function createConfiguredAgentResponderForApp(
  options: ConfiguredAgentResponderOptions,
  internalHooks: ConfiguredAgentInternalHooks,
): Promise<AgentResponder> {
  return await createConfiguredAgentResponderInternal(options, internalHooks);
}

async function createConfiguredAgentResponderInternal(
  options: ConfiguredAgentResponderOptions,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<AgentResponder> {
  const session = options.config.runtime.session;
  const rollover = internalHooks.sessionRollover ?? session.rollover;
  return createConversationResponder({
    harness: await createConfiguredConversationHarnessInternal(options, internalHooks),
    ...(rollover === undefined ? {} : { rollover }),
    ...(session.rolloverTimezone === undefined ? {} : { rolloverTimezone: session.rolloverTimezone }),
    ...(session.rolloverNotice === undefined ? {} : { rolloverNotice: session.rolloverNotice }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }) as AgentResponder;
}

/** @internal Shared only with app-local history decorators; absent from the package root. */
export const DEFAULT_HISTORY_MAX_MESSAGES = 64;

function supportsSessionResume(): boolean {
  try {
    return monoRuntimeSupportsSessionResume();
  } catch {
    return false;
  }
}

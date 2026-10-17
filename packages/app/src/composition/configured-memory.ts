import { normalizeOptionalString } from "@mono-agent/contracts";
import type { MemoryStore } from "@mono-agent/contracts";
import { assertNoRetiredMonoAgentConfig } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { LlmComplete, LlmCompleteOptions } from "@mono-agent/memory/bujo";
import { isProviderAuthFailureText } from "@mono-agent/turn/ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { modelReferenceKey, parseMonoRuntimeModelReference, runtimeOptionsForLocalProvider } from "@mono-agent/turn/host/config";
import { createSrtSandboxEngine, mergeSandboxPolicies } from "@mono-agent/turn/host/sandbox";
import type { MonoRuntimeLike, RuntimeModelReference, RuntimeResult, RuntimeRunOptions } from "@mono-agent/turn/host/types";

import { completionOnlyRuntime } from "../configured-runtime-capabilities.js";
import { acquireAgentRootOwnership, assertAgentRootLeaseOutsideWorkspace, releaseAgentRootOwnershipWhenIdle, type AgentRootOwnership } from "../durable-state/agent-root-coordinator.js";
import { textFromMemoryRuntimeResult } from "../memory-llm-result.js";
import { isSharedRecallStore, MemoryRetrievalService } from "../memory-retrieval.js";
import type { ProcessJobsProtectionPosture } from "../process-jobs-protection.js";
import { loadProcessJobsRootRegistryProtection, attestProcessJobsRootRegistrySnapshot, processJobsProtectionPolicyRoots } from "../process-jobs-root-registry.js";
import { processJobsSandboxPolicy, PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR } from "../process-jobs-runtime.js";
import type { ConfiguredConversationHarnessOptions, RecorderCompositionDeps, StaticRuntimeOptions } from "./configured-agent-options.js";
import { configRuntimeFlags, mergeStaticRuntimeOptions, runtimeHostOptionsForConfig } from "./configured-runtime-options.js";
import { composeRunRecorder, recorderCompositionDeps } from "./run-recording.js";

/**
 * The SQLite/BuJo stack (better-sqlite3, sqlite-vec) loads lazily only when
 * memory is configured. This keeps memory-less composition lightweight.
 */
type MemoryBujoModule = typeof import("@mono-agent/memory/bujo");
type MemorySearchModule = typeof import("@mono-agent/memory/search");
type ConfiguredEmbeddingProvider = ReturnType<
  MemorySearchModule["createCircuitBreakerEmbeddingProvider"]
>;

let memoryBujoModule: MemoryBujoModule | undefined;
let memorySearchModule: MemorySearchModule | undefined;

const loadMemoryBujoModule = async (): Promise<MemoryBujoModule> =>
  (memoryBujoModule ??= await import("@mono-agent/memory/bujo"));
const loadMemorySearchModule = async (): Promise<MemorySearchModule> =>
  (memorySearchModule ??= await import("@mono-agent/memory/search"));

export function configuredMemoryForHarness(
  config: MonoAgentConfig,
  memory: MemoryStore | undefined,
): MemoryStore | undefined {
  if (memory instanceof MemoryRetrievalService || config.memory === undefined || !isSharedRecallStore(memory)) {
    return memory;
  }
  return new MemoryRetrievalService(memory, {
    maxBytes: config.memory.maxBytes,
    source: "memory-bujo",
    profileEnabled: config.memory.mode === "bujo" && config.memory.profile?.enabled === true,
    intentExpiry: config.memory.mode === "bujo" && config.memory.recall?.intentExpiry === true,
  });
}

// Bound embeddings calls so a slow/cold backend cannot stall a turn for the
// provider default (30s). The harness degrades recall to empty on timeout.
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 10_000;

interface ConfiguredMemoryDependencies {
  /** Volatile source-clock seam for disposable chronological evaluation. */
  readonly clock?: () => Date;
  /** Optional transport seam; private evaluation disables embedding redirects. */
  readonly embeddingsFetch?: typeof fetch;
  /** Canonical agent-root authority and folder used to resolve optional plugins. */
  readonly cwd?: string;
  /** Managed workers must use the plugin frozen into their app-side runtime closure. */
  readonly logger?: { warn(message: string): void };
  /**
   * Injection seam for the bujo memory LLM's runtime (tests). This runtime MUST
   * NOT carry the channel runtime's fallback chain: the agent-runtime fallback
   * router overrides each run's per-call `model` with the chain's primary entry.
   */
  readonly memoryRuntime?: MonoRuntimeLike;
  /** Optional app-owned recording context for memory LLM calls. */
  readonly observability?: Pick<
    ConfiguredConversationHarnessOptions,
    "observabilityContext"
  >;
}

export async function createConfiguredMemory(
  config: MonoAgentConfig,
  deps: ConfiguredMemoryDependencies = {},
): Promise<MemoryStore | undefined> {
  return await createConfiguredMemoryInternal(config, deps);
}

/** @internal App-only unsafe authority; deliberately absent from the package root. */
export async function createConfiguredMemoryForApp(
  config: MonoAgentConfig,
  deps: ConfiguredMemoryDependencies,
  protectionPosture: ProcessJobsProtectionPosture,
): Promise<MemoryStore | undefined> {
  return await createConfiguredMemoryInternal(config, deps, protectionPosture);
}

export async function createConfiguredMemoryInternal(
  config: MonoAgentConfig,
  deps: ConfiguredMemoryDependencies,
  protectionPosture?: ProcessJobsProtectionPosture,
): Promise<MemoryStore | undefined> {
  assertNoRetiredMonoAgentConfig(config);
  if (config.memory === undefined) {
    return undefined;
  }
  const { mode, path: root, maxBytes, embeddings: embeddingsConfig, llm: llmConfig } = config.memory;
  const bujo = await loadMemoryBujoModule();
  if (config.memory.capture !== undefined && (mode !== "bujo" || config.memory.writeMode !== "capture")) {
    throw new Error("memory.capture requires BuJo mode and capture writeMode.");
  }

  if (mode === "lite") {
    if (embeddingsConfig !== undefined || llmConfig !== undefined || config.memory.consolidation !== undefined) {
      throw new Error("memory.mode 'lite' is lexical-only and rejects embeddings, memory.llm, and consolidation.");
    }
    // Lite tier: FTS-only recall, no external deps.
    return bujo.createBujoMemoryStore({
      root,
      tier: "lite",
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // journal and bujo tiers both need embeddings for hybrid recall. A bounded
  // timeout keeps a slow backend (e.g. Ollama loading the model) from stalling
  // the request, and the circuit breaker fast-fails after repeated failures so
  // a sustained outage stops blocking recall entirely. The harness degrades
  // recall to empty (with a memory_degraded warning) when this errors.
  const search = await loadMemorySearchModule();
  // The loader carries only the credential name; the value is resolved here at
  // use. A declared name stays authoritative (an inline literal never stands in
  // for it), matching the loader's former behavior.
  const embeddingsApiKey = embeddingsConfig?.apiKeyEnv !== undefined
    ? normalizeOptionalString(process.env[embeddingsConfig.apiKeyEnv])
    : embeddingsConfig?.apiKey;
  if (embeddingsConfig?.apiKeyEnv !== undefined && embeddingsApiKey === undefined) {
    throw new Error(
      `memory.embeddings.apiKeyEnv ${embeddingsConfig.apiKeyEnv} is declared but has no resolved value; ` +
      `set ${embeddingsConfig.apiKeyEnv} before starting managed memory.`,
    );
  }
  const embeddings = wrapOwnedDirectEmbeddingProvider(
    search.createCircuitBreakerEmbeddingProvider(
      search.createEmbeddingProvider({
        provider: embeddingsConfig?.provider ?? "ollama",
        model: embeddingsConfig?.model ?? "nomic-embed-text:v1.5",
        ...(embeddingsConfig?.endpoint !== undefined && { endpoint: embeddingsConfig.endpoint }),
        ...(embeddingsApiKey !== undefined && { apiKey: embeddingsApiKey }),
        timeoutMs: embeddingsConfig?.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS,
        ...(embeddingsConfig?.instructions === undefined ? {} : { instructions: embeddingsConfig.instructions }),
      }, deps.embeddingsFetch),
      {
        ...(embeddingsConfig?.circuitBreaker?.failureThreshold !== undefined && {
          failureThreshold: embeddingsConfig.circuitBreaker.failureThreshold,
        }),
        ...(embeddingsConfig?.circuitBreaker?.cooldownMs !== undefined && {
          cooldownMs: embeddingsConfig.circuitBreaker.cooldownMs,
        }),
      },
    ),
    config,
    deps.cwd ?? process.cwd(),
  );
  const dim = embeddingsConfig?.dim ?? 768;

  if (mode === "journal") {
    if (embeddingsConfig === undefined) {
      throw new Error("memory.mode 'journal' requires memory.embeddings; configuration must not downshift tiers.");
    }
    if (llmConfig !== undefined || config.memory.consolidation !== undefined) {
      throw new Error("memory.mode 'journal' rejects memory.llm and consolidation; select bujo for curated capture.");
    }
    // Journal tier: hybrid recall + static, non-decaying salience; no chat LLM.
    return bujo.createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings,
      dim,
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // BuJo is a strict full-stack tier. The config loader enforces both
  // prerequisites; keep the composition boundary defensive for programmatic
  // callers that may construct MonoAgentConfig directly.
  if (embeddingsConfig === undefined || llmConfig === undefined) {
    throw new Error("memory.mode 'bujo' requires memory.embeddings and memory.llm; configuration must not downshift tiers.");
  }
  const recording =
    deps.observability === undefined
      ? undefined
      : await recorderCompositionDeps(config, {
          ...deps.observability,

        });
  const llm = configuredMemoryLlm(
    bujo,
    config,
    llmConfig,
    deps.memoryRuntime,
    recording,
    deps.cwd ?? process.cwd(),
    protectionPosture,
  );
  if (llm === undefined) {
    throw new Error("memory.mode 'bujo' could not construct the required memory.llm.");
  }
  const reconcileModel = config.memory.capture?.reconcileModel;
  const classifier = reconcileModel === undefined ? undefined : configuredMemoryLlm(
    bujo, config,
    { provider: "agent-host", model: reconcileModel,
      ...(llmConfig.provider === "agent-host" && llmConfig.trace !== undefined ? { trace: llmConfig.trace } : {}),
      ...(llmConfig.provider === "agent-host" && llmConfig.timeoutMs !== undefined ? { timeoutMs: llmConfig.timeoutMs } : {}),
    },
    deps.memoryRuntime, recording, deps.cwd ?? process.cwd(), protectionPosture,
  );
  if (reconcileModel !== undefined && classifier === undefined) throw new Error("memory.capture.reconcileModel could not construct a classifier LLM.");
  const captureLlm = classifier === undefined ? llm : {
    id: llm.id,
    complete(prompt: string, options?: Parameters<typeof llm.complete>[1]) {
      return (options?.label === "capture:reconcile-batch" || options?.label === "capture:reconcile"
        ? classifier : llm).complete(prompt, options);
    },
  };
  const { focus, only } = config.memory.capture ?? {};
  return bujo.createBujoMemoryStore({
    root,
    tier: "bujo",
    embeddings,
    dim,
    ...(maxBytes !== undefined && { maxBytes }),
    llm: captureLlm,
    ...(config.memory.recall === undefined ? {} : { recall: config.memory.recall }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(config.memory.capture === undefined ? {} : { capture: { ...(focus === undefined ? {} : { focus }), ...(only === undefined ? {} : { only }), ...(config.memory.capture.intentLifecycle === undefined ? {} : { intentLifecycle: config.memory.capture.intentLifecycle }) } }),
    ...(deps.logger !== undefined && { logger: deps.logger }),
  });
}

/** An operator-only, fallback-free memory LLM; does not start or write an agent store. */
export async function createConfiguredCurationLlm(
  config: MonoAgentConfig,
  modelOverride: string | undefined,
  memoryRuntime?: MonoRuntimeLike,
): Promise<LlmComplete> {
  const bujo = await import("@mono-agent/memory/bujo");
  const configured = config.memory?.llm;
  if (configured === undefined && modelOverride === undefined) throw new Error("memory-curate: memory.llm is not configured");
  const llmConfig = modelOverride === undefined ? configured! : {
    provider: modelOverride.startsWith("ollama:") ? "ollama" as const : "agent-host" as const,
    model: modelOverride.startsWith("ollama:") ? modelOverride.slice(7) : modelOverride,
    ...(modelOverride.startsWith("ollama:") && configured?.provider === "ollama" && configured.endpoint !== undefined
      ? { endpoint: configured.endpoint } : {}),
  };
  // Do not route operator-only completion through configuredMemoryLlm: that
  // path deliberately takes a root lease for in-process memory maintenance.
  // Curation has no tools, MCP or process jobs; it reads only the prompt passed
  // by the CLI. Protected-root tool sandboxing is unnecessary for a tool-less
  // completion, so it must not acquire a live agent's exclusive root lease.
  // Keeping the runtime private also lets us dispose its sessions
  // after each completion so the CLI does not retain provider handles.
  if (llmConfig.provider === "ollama") {
    return bujo.createOllamaLlm({ model: llmConfig.model,
      ...(llmConfig.endpoint === undefined ? {} : { endpoint: llmConfig.endpoint }) });
  }
  const model = parseMonoRuntimeModelReference(llmConfig.model);
  const runtime = memoryRuntime ?? createMonoRuntime(runtimeHostOptionsForConfig(config));
  const llm = createAgentHostMemoryLlm({ runtime, model, cwd: config.runtime.workspace,
    runtimeOptions: mergeStaticRuntimeOptions(runtimeOptionsForLocalProvider(model, config.providers?.local), configRuntimeFlags(config)),
    ...("timeoutMs" in llmConfig && llmConfig.timeoutMs !== undefined ? { timeoutMs: llmConfig.timeoutMs } : {}) });
  return { ...llm, async complete(prompt, options) {
    try { return await llm.complete(prompt, options); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "provider_auth" || error instanceof Error && isProviderAuthFailureText(error.message)) {
        throw Object.assign(new Error("memory-curate: provider authentication failed", { cause: error }),
          { code: "provider_auth" });
      }
      throw error;
    }
    // Session cleanup is best-effort: a close failure cannot replace the model
    // result or conceal the operator's real authentication/transport failure.
    finally { await runtime.disposeAllSessions?.().catch(() => undefined); }
  } };
}

function configuredMemoryLlm(
  bujo: MemoryBujoModule,
  config: MonoAgentConfig,
  llmConfig: NonNullable<MonoAgentConfig["memory"]>["llm"],
  // Explicit memory-LLM runtime (tests). MUST be fallback-chain-free — see the
  // `memoryRuntime` doc on createConfiguredMemory. When undefined the memory LLM
  // builds its own fallback-free runtime so the per-call memory model is primary.
  memoryRuntimeOverride: MonoRuntimeLike | undefined,
  recording: RecorderCompositionDeps | undefined,
  agentRoot: string | undefined,
  protectionPosture: ProcessJobsProtectionPosture | undefined,
): LlmComplete | undefined {
  if (llmConfig === undefined) {
    return undefined;
  }
  if (llmConfig.provider === "ollama") {
    // The ollama memory LLM does not ride `runtime.run`, so it is not recorded.
    return wrapOwnedDirectMemoryLlm(bujo.createOllamaLlm({
      model: llmConfig.model,
      ...(llmConfig.endpoint !== undefined && { endpoint: llmConfig.endpoint }),
    }), config, agentRoot);
  }
  const model = parseMonoRuntimeModelReference(llmConfig.model);
  // NOTE: createMonoRuntime is called WITHOUT a fallbackChain here on purpose, so
  // the per-call `model: config.memory.llm.model` is the sole/primary model. The
  // channel runtime (which carries the fallback chain whose primary is
  // `config.runtime.model`) is intentionally NOT reused — see the `memoryRuntime`
  // doc on createConfiguredMemory.
  const runtime = wrapPerRunOwnedConfiguredRuntime(
    memoryRuntimeOverride ?? createMonoRuntime(runtimeHostOptionsForConfig(config)),
    config,
    agentRoot,
    protectionPosture,
  );
  return createAgentHostMemoryLlm({
    runtime,
    model,
    cwd: config.runtime.workspace,
    runtimeOptions: mergeStaticRuntimeOptions(
      runtimeOptionsForLocalProvider(model, config.providers?.local),
      configRuntimeFlags(config),
    ),
    // Per-call timeout; default 60s. Configurable so a slow local model can be
    // given room on the heavier reconcile/entities steps.
    ...(llmConfig.timeoutMs === undefined ? {} : { timeoutMs: llmConfig.timeoutMs }),
    // `memory.llm.trace` (default on) gates recording; it only takes effect when
    // the app threaded observability deps into createConfiguredMemory.
    ...(recording !== undefined && llmConfig.trace !== false
      ? { recording: { deps: recording, baseConversationId: MEMORY_CONVERSATION_ID } }
      : {}),
  });
}

/**
 * Memory completion is a model-running surface even when no channel harness is
 * present. Acquire the canonical-root owner and protection generation for the
 * exact duration of the provider call; release follows actual runtime
 * settlement, never its abort signal.
 */
function wrapPerRunOwnedConfiguredRuntime(
  runtime: MonoRuntimeLike,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
  protectionPosture: ProcessJobsProtectionPosture | undefined,
): MonoRuntimeLike {
  // Memory completion has no storage-settlement caller. Do not advertise
  // inherited recovery methods that would bypass this per-run ownership lease.
  const completionRuntime = completionOnlyRuntime(runtime);
  return {
    ...completionRuntime,
    async run(systemPrompt, runOptions) {
      const ownership = await acquireAgentRootOwnership(agentRoot);
      let requestLease: ReturnType<AgentRootOwnership["coordinator"]["acquireRequestLease"]> | undefined;
      try {
        assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
        const loaded = await loadProcessJobsRootRegistryProtection(
          ownership.agentRoot,
          config.runtime.workspace,
        );
        ownership.coordinator.synchronizeGeneration(loaded.generation);
        const boundary = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
        requestLease = ownership.coordinator.acquireRequestLease(boundary.generation);
        const attested = await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
        const protectedRoots = processJobsProtectionPolicyRoots(attested);
        let effectiveOptions = runOptions;
        if (protectedRoots.length > 0) {
          if (protectionPosture?.suppressSyntheticSandbox !== true) {
            const sandboxEngine = runOptions.sandboxEngine ?? createSrtSandboxEngine();
            if (!await sandboxEngine.isAvailable().catch(() => false)) {
              throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
            }
            const sandboxPolicy = mergeSandboxPolicies(
              runOptions.sandboxPolicy,
              processJobsSandboxPolicy({ coreConfig: config, protectedRoots }),
            );
            if (sandboxPolicy === undefined) {
              throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
            }
            effectiveOptions = {
              ...runOptions,
              sandboxPolicy,
              sandboxEngine,
            };
          }
        }
        return await runtime.run(systemPrompt, effectiveOptions);
      } finally {
        requestLease?.releaseAfterSettlement();
        await releaseAgentRootOwnershipWhenIdle(ownership);
      }
    },
  };
}

/**
 * The direct (non-agent-host) memory LLM executes outside the channel harness.
 * Hold the same canonical-root owner and generation lease through the true
 * complete() settlement so an out-of-harness provider call cannot outlive the
 * protection generation it started under.
 *
 * A retained process-job root does NOT reject this provider. SRT confines the
 * MODEL'S TOOL LOOP; the host process is already unconfined and already reads
 * the private state dir. `LlmComplete` is a single `complete(prompt) => string`
 * over HTTP with no tools and no filesystem access, so there is nothing here
 * for confinement to protect — while rejecting it made `processJobs.enabled`
 * mutually exclusive with the bujo/journal memory tiers (mono-agent#664). The
 * lease, not the sandbox, is this seam's control.
 */
function wrapOwnedDirectMemoryLlm(
  llm: LlmComplete,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
): LlmComplete {
  return {
    ...llm,
    async complete(prompt, options) {
      const ownership = await acquireAgentRootOwnership(agentRoot);
      let requestLease: ReturnType<AgentRootOwnership["coordinator"]["acquireRequestLease"]> | undefined;
      try {
        assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
        const loaded = await loadProcessJobsRootRegistryProtection(
          ownership.agentRoot,
          config.runtime.workspace,
        );
        ownership.coordinator.synchronizeGeneration(loaded.generation);
        const boundary = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
        requestLease = ownership.coordinator.acquireRequestLease(boundary.generation);
        await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
        return await llm.complete(prompt, options);
      } finally {
        requestLease?.releaseAfterSettlement();
        await releaseAgentRootOwnershipWhenIdle(ownership);
      }
    },
  };
}

/**
 * Configured embedding providers execute outside the channel harness. Hold the
 * same canonical-root owner and generation lease through the true embed()
 * settlement so an out-of-harness provider call cannot outlive the protection
 * generation it started under.
 *
 * A retained process-job root does NOT reject this provider — see the sibling
 * `wrapOwnedDirectMemoryLlm` doc for the reasoning. `embed(texts) =>
 * number[][]` is one method with no model-steerable surface, and the bujo and
 * journal tiers REQUIRE it, so rejecting it disabled memory outright under the
 * safe posture (mono-agent#664).
 */
function wrapOwnedDirectEmbeddingProvider(
  provider: ConfiguredEmbeddingProvider,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
): ConfiguredEmbeddingProvider {
  return {
    ...provider,
    async embed(texts) {
      const ownership = await acquireAgentRootOwnership(agentRoot);
      let requestLease: ReturnType<AgentRootOwnership["coordinator"]["acquireRequestLease"]> | undefined;
      try {
        assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
        const loaded = await loadProcessJobsRootRegistryProtection(
          ownership.agentRoot,
          config.runtime.workspace,
        );
        ownership.coordinator.synchronizeGeneration(loaded.generation);
        const boundary = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
        requestLease = ownership.coordinator.acquireRequestLease(boundary.generation);
        await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
        return await provider.embed(texts);
      } finally {
        requestLease?.releaseAfterSettlement();
        await releaseAgentRootOwnershipWhenIdle(ownership);
      }
    },
  };
}

const MEMORY_LLM_SYSTEM_PROMPT = [
  "You are the private memory maintenance LLM for mono-agent.",
  "Return only the requested JSON or plain text.",
  "Do not use tools, inspect files, or perform external actions.",
].join(" ");

/** Fallback conversation id for recorded memory LLM runs that carry no ritual label. */
const MEMORY_CONVERSATION_ID = "memory:bujo";

function createAgentHostMemoryLlm(options: {
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly cwd: string;
  readonly runtimeOptions?: StaticRuntimeOptions;
  readonly timeoutMs?: number;
  /**
   * When set, each `complete()` is recorded as one run through the shared
   * local JSONL pipeline. The per-call `label` (e.g. "capture:extract")
   * selects the run's conversation id and id slug. Omitted → bare, unrecorded run.
   */
  readonly recording?: {
    readonly deps: RecorderCompositionDeps;
    readonly baseConversationId?: string;
  };
}): LlmComplete {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: `agent-host:${referenceOf(options.model)}`,
    async complete(prompt: string, opts?: LlmCompleteOptions): Promise<string> {
      const ctrl = new AbortController();
      const abort = (): void => ctrl.abort(opts?.abortSignal?.reason);
      if (opts?.abortSignal?.aborted === true) abort();
      else opts?.abortSignal?.addEventListener("abort", abort, { once: true });
      // Track whether OUR timeout fired vs an external abort. A provider that is slow or
      // misconfigured (e.g. a dead OAuth token whose refresh hangs) trips this timeout and the
      // runtime reports `cancelled` — without this flag the failure is mislabeled as a generic
      // "run was cancelled", which is exactly what made a 10-day memory outage hard to diagnose.
      let timedOut = false;
      const timer = setTimeout(() => {
        if (ctrl.signal.aborted) return;
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      const memoryOperation = memoryOperationFromLabel(opts?.label);
      const recorder =
        options.recording === undefined
          ? undefined
          : composeRunRecorder(options.recording.deps, {
              runId: createMemoryRunId(opts?.label),
              conversationId: memoryConversationId(options.recording.baseConversationId, opts?.label),
              userInput: prompt,
              systemPrompt: MEMORY_LLM_SYSTEM_PROMPT,
              runKind: "memory",
              source: "memory",
              ...(memoryOperation === undefined ? {} : { memoryOperation }),
              ...(memoryOperation === undefined ? {} : { sourceDetail: memoryOperation }),
            });
      try {
        await safeRecorderCall(() => recorder?.start?.());
        let result: RuntimeResult;
        try {
          result = await options.runtime.run(MEMORY_LLM_SYSTEM_PROMPT, {
            ...options.runtimeOptions,
            model: options.model,
            messages: [{ role: "user", content: prompt }],
            abortSignal: ctrl.signal,
            cwd: options.cwd,
            // StructuredOutput is a tool call that requires a follow-up finalization
            // turn in Pi-native. One turn rejects a successful tool submission as
            // "max turns reached" before its structured result can be returned.
            maxTurns: opts?.outputSchema === undefined ? 1 : 3,
            allowedTools: [],
            disallowedTools: [],
            mcpServers: {},
            ...(opts?.outputSchema === undefined ? {} : { outputSchema: opts.outputSchema }),
            ...(recorder === undefined ? {} : { onEvent: (event) => { recorder.onEvent(event); } }),
          } satisfies RuntimeRunOptions);
        } catch (error) {
          // `runtime.run` itself threw (e.g. the abort/timeout above) — record the
          // failure, then surface a timeout distinctly from an external abort.
          await safeRecorderCall(() => recorder?.fail(error));
          if (timedOut) {
            throw new Error(`agent-host memory LLM timed out after ${timeoutMs}ms (provider too slow or unavailable).`);
          }
          throw error;
        }
        // Record with the real outcome BEFORE textFromMemoryRuntimeResult, which throws
        // on failureKind/error; recorder.finish() classifies failed/succeeded/cancelled itself.
        await safeRecorderCall(() => recorder?.finish(result));
        return textFromMemoryRuntimeResult(result, {
          timedOut,
          timeoutMs,
          structuredOutputRequested: opts?.outputSchema !== undefined,
          ...(opts?.structuredResultKey === undefined ? {} : { structuredResultKey: opts.structuredResultKey }),
        });
      } finally {
        clearTimeout(timer);
        opts?.abortSignal?.removeEventListener("abort", abort);
      }
    },
  };
}

/**
 * Run a recorder lifecycle call best-effort. Recording is additive: a recorder
 * or artifact-write failure must never mask the memory LLM's real result or error.
 */
async function safeRecorderCall(fn: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // Swallow: recording failures are non-fatal by design.
  }
}

/** Build a `mem-`-prefixed run id (distinct from channel `run-` ids) with the ritual slug. */
function createMemoryRunId(label: string | undefined): string {
  return `mem-${memorySlug(label)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Conversation id for a recorded memory run: `memory:<label>` (per-ritual), else the base. */
function memoryConversationId(base: string | undefined, label: string | undefined): string {
  if (label !== undefined && label.length > 0) {
    return `memory:${label}`;
  }
  return base ?? MEMORY_CONVERSATION_ID;
}

function memorySlug(label: string | undefined): string {
  const slug = (label ?? "bujo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "bujo";
}

/**
 * Memory sub-operation for the `mono.agent.memory.operation` trace attribute.
 * The capture ritual labels are `capture:extract` / `capture:reconcile-batch`
 * (take the part after the colon) and the bare `reflect` / `migrate` (verbatim).
 */
function memoryOperationFromLabel(label: string | undefined): string | undefined {
  if (label === undefined || label.length === 0) {
    return undefined;
  }
  const op = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  return op.length > 0 ? op : undefined;
}

function referenceOf(model: RuntimeModelReference): string {
  return modelReferenceKey(model);
}

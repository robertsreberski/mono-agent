import {
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "@mono-agent/agent-harness";
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
  ConversationHistoryStore,
} from "@mono-agent/agent-harness";
import { resolve as resolvePath } from "node:path";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createBujoMemoryStore, createOllamaLlm } from "@mono-agent/memory-bujo";
import type { LlmComplete } from "@mono-agent/memory-bujo";
import { createCircuitBreakerEmbeddingProvider, createEmbeddingProvider } from "@mono-agent/memory-search";
import type { MemoryStore } from "@mono-agent/memory-store";
import { createCompositeRunRecorder, createJsonlRunRecorder } from "@mono-agent/observability";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunRecorder,
} from "@mono-agent/observability";
import { createPhoenixRunExporter } from "@mono-agent/observability-otel";
import {
  assertExecutionModeCompatible,
  createMonoRuntime,
  createPiOAuthApiKeyResolver,
  defaultExecutionModeForModel,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
} from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeFallbackChainEntry,
  MonoRuntimeLike,
  RuntimeExecutionMode,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import { createToolPolicy, loadToolPolicyFromJsonFileSync } from "@mono-agent/tool-policy";
import type { ToolPolicyInput } from "@mono-agent/tool-policy";

type StaticRuntimeOptions = NonNullable<AgentHarnessOptions["runtimeOptions"]>;

export interface ConfiguredAgentRuntimeOptions {
  readonly config: MonoAgentConfig;
  readonly model?: RuntimeModelReference;
  readonly executionMode?: string;
}

export interface ConfiguredAgentHarnessOptions {
  readonly config: MonoAgentConfig;
  readonly runtime?: MonoRuntimeLike;
  readonly model?: RuntimeModelReference;
  readonly executionMode?: string;
  readonly memory?: MemoryStore;
  readonly historyStore?: ConversationHistoryStore;
  readonly createRunId?: AgentHarnessOptions["createRunId"];
  readonly now?: AgentHarnessOptions["now"];
  readonly runtimeOptions?: AgentHarnessOptions["runtimeOptions"];
  readonly runtimeOptionsForRequest?: (
    input: AgentHarnessRuntimeOptionsInput,
  ) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;
  /**
   * Exporter-context fields the factory input cannot supply. Surfaced on the
   * exported root span so Phoenix traces map back to the running host and its
   * local artifacts.
   */
  readonly observabilityContext?: {
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  };
  /** Best-effort exporter warnings (timeouts, transport failures). */
  readonly exporterWarn?: (warning: { phase: string; message: string }) => void;
  /** Injection seam (tests); defaults to createPhoenixRunExporter. */
  readonly exporterFactory?: (config: PhoenixExporterConfig) => RunExporter;
}

export interface ConfiguredAgentResponderOptions extends ConfiguredAgentHarnessOptions {}

/**
 * Inputs the recorder composition needs that are stable across a run: the
 * artifact directory, the configured exporters, and the per-host export
 * context. Shared by the channel-run `recorderFactory` and the memory LLM so
 * both produce identical JSONL artifacts + Phoenix spans.
 */
interface RecorderCompositionDeps {
  readonly artifactDir: string;
  readonly exporters: readonly PhoenixExporterConfig[];
  readonly observabilityContext?: ConfiguredAgentHarnessOptions["observabilityContext"];
  readonly exporterWarn?: ConfiguredAgentHarnessOptions["exporterWarn"];
  readonly exporterFactory?: ConfiguredAgentHarnessOptions["exporterFactory"];
}

/**
 * Build a recorder for one run. The JSONL recorder is always built first and
 * returned unchanged when no exporter is configured, so default recording stays
 * byte-identical. When an exporter is present the JSONL recorder is wrapped so
 * export is best-effort and additive — exporter failures only surface as
 * warnings and never change the run outcome.
 */
function composeRunRecorder(
  deps: RecorderCompositionDeps,
  args: {
    readonly runId: string;
    readonly conversationId: string;
    readonly userInput?: string;
    readonly systemPrompt?: string;
    readonly runKind?: "memory" | "channel";
    readonly memoryOperation?: string;
  },
): RunRecorder {
  const jsonl = createJsonlRunRecorder({
    runId: args.runId,
    conversationId: args.conversationId,
    artifactDir: deps.artifactDir,
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
  });
  const exporterCfg = deps.exporters[0];
  if (exporterCfg === undefined) {
    return jsonl;
  }
  const exporter = (deps.exporterFactory ?? createPhoenixRunExporter)(exporterCfg);
  const context: RunExportContext = {
    runId: args.runId,
    conversationId: args.conversationId,
    ...(deps.observabilityContext?.sourceId === undefined
      ? {}
      : { sourceId: deps.observabilityContext.sourceId }),
    ...(deps.observabilityContext?.sourceLabel === undefined
      ? {}
      : { sourceLabel: deps.observabilityContext.sourceLabel }),
    ...(deps.observabilityContext?.configPath === undefined
      ? {}
      : { configPath: deps.observabilityContext.configPath }),
    artifactDir: deps.artifactDir,
    includeSensitiveData: exporterCfg.includeSensitiveData ?? false,
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.runKind === undefined ? {} : { runKind: args.runKind }),
    ...(args.memoryOperation === undefined ? {} : { memoryOperation: args.memoryOperation }),
  };
  return createCompositeRunRecorder({
    recorder: jsonl,
    exporter,
    context,
    timeoutMs: exporterCfg.timeoutMs ?? 5000,
    ...(deps.exporterWarn === undefined ? {} : { onWarning: deps.exporterWarn }),
  });
}

/** Collect the recorder-composition deps from the host config + harness options. */
function recorderCompositionDeps(
  config: MonoAgentConfig,
  options: Pick<
    ConfiguredAgentHarnessOptions,
    "observabilityContext" | "exporterWarn" | "exporterFactory"
  >,
): RecorderCompositionDeps {
  return {
    artifactDir: config.artifacts.dir,
    exporters: config.observability?.exporters ?? [],
    ...(options.observabilityContext === undefined
      ? {}
      : { observabilityContext: options.observabilityContext }),
    ...(options.exporterWarn === undefined ? {} : { exporterWarn: options.exporterWarn }),
    ...(options.exporterFactory === undefined ? {} : { exporterFactory: options.exporterFactory }),
  };
}

export function createConfiguredAgentRuntime(config: MonoAgentConfig): MonoRuntimeLike;
export function createConfiguredAgentRuntime(options: ConfiguredAgentRuntimeOptions): MonoRuntimeLike;
export function createConfiguredAgentRuntime(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  return createMonoRuntime({
    ...runtimeHostOptionsForConfig(config),
    ...(fallbackChainForConfig(config, isRuntimeOptions(input) ? input : undefined)),
  });
}

/**
 * When backup models are configured, runs go through the agent-runtime fallback
 * router with the effective primary model first. Fallback entries use their
 * default execution mode.
 */
function fallbackChainForConfig(
  config: MonoAgentConfig,
  options: ConfiguredAgentRuntimeOptions | undefined,
): { fallbackChain?: readonly MonoRuntimeFallbackChainEntry[] } {
  const fallbackModels = config.runtime.fallbackModels;
  if (fallbackModels === undefined || fallbackModels.length === 0) {
    return {};
  }
  const primaryModel = options?.model ?? config.runtime.model;
  const primaryExecutionMode = options?.executionMode ?? config.runtime.executionMode;
  return {
    fallbackChain: [
      { model: primaryModel, executionMode: primaryExecutionMode as RuntimeExecutionMode },
      ...fallbackModels.map((model) => ({ model })),
    ],
  };
}

export function createConfiguredAgentHarness(options: ConfiguredAgentHarnessOptions): AgentHarness {
  const config = options.config;
  const model = options.model ?? config.runtime.model;
  const executionMode = options.executionMode ?? config.runtime.executionMode;
  const runtime = options.runtime ?? createConfiguredAgentRuntime({ config, model, executionMode });
  const memory = options.memory ?? createConfiguredMemory(config, { runtime });
  const runtimeOptions = mergeStaticRuntimeOptions(
    runtimeOptionsForLocalProvider(model, config.providers?.local),
    configRuntimeFlags(config),
    options.runtimeOptions,
  );

  return createAgentHarness({
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    ...(config.context.skillMaxBytes === undefined ? {} : { skillMaxBytes: config.context.skillMaxBytes }),
    ...(config.context.skillDisclosure === undefined ? {} : { skillDisclosure: config.context.skillDisclosure }),
    selectedSkills: config.context.selectedSkills,
    runtime,
    model,
    executionMode,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    ...(config.runtime.maxTurns === undefined ? {} : { maxTurns: config.runtime.maxTurns }),
    ...(config.providers?.piNative?.piSessionsRoot === undefined
      ? {}
      : { piSessionsRoot: config.providers.piNative.piSessionsRoot }),
    session: {
      mode: config.runtime.session.mode,
      idleTimeoutMs: config.runtime.session.idleTimeoutMs,
      ...(config.runtime.session.isolateProactive === undefined
        ? {}
        : { isolateProactive: config.runtime.session.isolateProactive }),
    },
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
    ...(options.runtimeOptionsForRequest === undefined
      ? {}
      : { runtimeOptionsForRequest: options.runtimeOptionsForRequest }),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    historyStore: options.historyStore ?? createInMemoryHistoryStore({ maxMessages: historyMaxMessages(config.runtime.maxTurns) }),
    // Inbound channel attachments are saved here (under the artifacts dir, which
    // sits inside a sandbox-readable root) so the agent can open them by path.
    attachmentsDir: resolvePath(config.artifacts.dir, "attachments"),
    toolPolicy: createToolPolicy(toolPolicyInput(config)),
    ...(config.sandbox === undefined ? {} : { sandboxPolicy: config.sandbox }),
    recorderFactory: ({ runId, conversationId, userInput }) =>
      composeRunRecorder(recorderCompositionDeps(config, options), {
        runId,
        conversationId,
        runKind: "channel",
        ...(userInput === undefined ? {} : { userInput }),
      }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function createConfiguredAgentResponder(options: ConfiguredAgentResponderOptions): AgentResponder {
  const session = options.config.runtime.session;
  return createAgentResponder({
    harness: createConfiguredAgentHarness(options),
    ...(session.rollover === undefined ? {} : { rollover: session.rollover }),
    ...(session.rolloverTimezone === undefined ? {} : { rolloverTimezone: session.rolloverTimezone }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }) as AgentResponder;
}

function historyMaxMessages(maxTurns: number | undefined): number {
  return maxTurns === undefined || maxTurns <= 0 ? 0 : maxTurns * 2;
}

// Bound embeddings calls so a slow/cold backend cannot stall a turn for the
// provider default (30s). The harness degrades recall to empty on timeout.
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 10_000;

export function createConfiguredMemory(
  config: MonoAgentConfig,
  deps: {
    logger?: { warn(message: string): void };
    runtime?: MonoRuntimeLike;
    /**
     * When supplied, the bujo memory LLM records each `complete()` as a run via
     * the same JSONL + Phoenix pipeline as channel runs (subject to the
     * `memory.llm.trace` toggle). Omitted → memory LLM runs unrecorded.
     */
    observability?: Pick<
      ConfiguredAgentHarnessOptions,
      "observabilityContext" | "exporterWarn" | "exporterFactory"
    >;
  } = {},
): MemoryStore | undefined {
  if (config.memory === undefined) {
    return undefined;
  }
  const { mode, path: root, maxBytes, embeddings: embeddingsConfig, llm: llmConfig } = config.memory;

  if (mode === "lite") {
    // Lite tier: FTS-only recall, no external deps.
    return createBujoMemoryStore({
      root,
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // journal and bujo tiers both need embeddings for hybrid recall. A bounded
  // timeout keeps a slow backend (e.g. Ollama loading the model) from stalling
  // the request, and the circuit breaker fast-fails after repeated failures so
  // a sustained outage stops blocking recall entirely. The harness degrades
  // recall to empty (with a memory_degraded warning) when this errors.
  const embeddings = createCircuitBreakerEmbeddingProvider(
    createEmbeddingProvider({
      provider: embeddingsConfig?.provider ?? "ollama",
      model: embeddingsConfig?.model ?? "nomic-embed-text:v1.5",
      ...(embeddingsConfig?.endpoint !== undefined && { endpoint: embeddingsConfig.endpoint }),
      ...(embeddingsConfig?.apiKey !== undefined && { apiKey: embeddingsConfig.apiKey }),
      timeoutMs: embeddingsConfig?.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS,
    }),
    {
      ...(embeddingsConfig?.circuitBreaker?.failureThreshold !== undefined && {
        failureThreshold: embeddingsConfig.circuitBreaker.failureThreshold,
      }),
      ...(embeddingsConfig?.circuitBreaker?.cooldownMs !== undefined && {
        cooldownMs: embeddingsConfig.circuitBreaker.cooldownMs,
      }),
    },
  );
  const dim = embeddingsConfig?.dim ?? 768;

  if (mode === "journal") {
    // Journal tier: hybrid recall + decay; no chat LLM.
    return createBujoMemoryStore({
      root,
      embeddings,
      dim,
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // bujo tier: full stack — embeddings + optional chat LLM for capture/reflect/migrate.
  const recording =
    deps.observability === undefined
      ? undefined
      : recorderCompositionDeps(config, deps.observability);
  const llm = configuredMemoryLlm(config, llmConfig, deps.runtime, recording);
  return createBujoMemoryStore({
    root,
    embeddings,
    dim,
    ...(maxBytes !== undefined && { maxBytes }),
    ...(llm === undefined ? {} : { llm }),
    ...(deps.logger !== undefined && { logger: deps.logger }),
  });
}

function runtimeHostOptionsForConfig(config: MonoAgentConfig): Parameters<typeof createMonoRuntime>[0] {
  return {
    workspace: config.runtime.workspace,
    qaOutputDir: config.artifacts.dir,
    ...(config.providers?.piAuthPath === undefined
      ? {}
      : { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: config.providers.piAuthPath }) }),
  };
}

function configuredMemoryLlm(
  config: MonoAgentConfig,
  llmConfig: NonNullable<MonoAgentConfig["memory"]>["llm"],
  runtimeOverride: MonoRuntimeLike | undefined,
  recording: RecorderCompositionDeps | undefined,
): LlmComplete | undefined {
  if (llmConfig === undefined) {
    return undefined;
  }
  if (llmConfig.provider === "ollama") {
    // The ollama memory LLM does not ride `runtime.run`, so it is not recorded.
    return createOllamaLlm({
      model: llmConfig.model,
      ...(llmConfig.endpoint !== undefined && { endpoint: llmConfig.endpoint }),
    });
  }
  const model = parseMonoRuntimeModelReference(llmConfig.model);
  const executionMode = llmConfig.executionMode ?? defaultExecutionModeForModel(model);
  assertExecutionModeCompatible(model, executionMode);
  if (executionMode !== "sdk") {
    throw new Error("memory.llm provider agent-host supports SDK execution mode only.");
  }
  const runtime = runtimeOverride ?? createMonoRuntime(runtimeHostOptionsForConfig(config));
  return createAgentHostMemoryLlm({
    runtime,
    model,
    executionMode,
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
  readonly executionMode: RuntimeExecutionMode;
  readonly cwd: string;
  readonly runtimeOptions?: StaticRuntimeOptions;
  readonly timeoutMs?: number;
  /**
   * When set, each `complete()` is recorded as one run through the shared
   * JSONL + Phoenix pipeline. The per-call `label` (e.g. "capture:distill")
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
    async complete(prompt: string, opts?: { readonly label?: string }): Promise<string> {
      const ctrl = new AbortController();
      // Track whether OUR timeout fired vs an external abort. A provider that is slow or
      // misconfigured (e.g. a dead OAuth token whose refresh hangs) trips this timeout and the
      // runtime reports `cancelled` — without this flag the failure is mislabeled as a generic
      // "run was cancelled", which is exactly what made a 10-day memory outage hard to diagnose.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
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
              ...(memoryOperation === undefined ? {} : { memoryOperation }),
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
            executionMode: options.executionMode,
            cwd: options.cwd,
            maxTurns: 1,
            allowedTools: [],
            disallowedTools: [],
            mcpServers: {},
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
        return textFromMemoryRuntimeResult(result, { timedOut, timeoutMs });
      } finally {
        clearTimeout(timer);
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
 * The ritual labels are `capture:distill` / `capture:reconcile` / `capture:entities`
 * (take the part after the colon) and the bare `reflect` / `migrate` (verbatim).
 */
function memoryOperationFromLabel(label: string | undefined): string | undefined {
  if (label === undefined || label.length === 0) {
    return undefined;
  }
  const op = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  return op.length > 0 ? op : undefined;
}

function textFromMemoryRuntimeResult(
  result: RuntimeResult,
  opts?: { readonly timedOut?: boolean; readonly timeoutMs?: number },
): string {
  if (result.cancelled === true) {
    if (opts?.timedOut === true) {
      throw new Error(`agent-host memory LLM timed out after ${opts.timeoutMs ?? "?"}ms (provider too slow or unavailable).`);
    }
    throw new Error("agent-host memory LLM run was cancelled.");
  }
  if (typeof result.failureKind === "string" && result.failureKind.length > 0) {
    throw new Error(`agent-host memory LLM failed (${result.failureKind}): ${result.error ?? "unknown error"}`);
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`agent-host memory LLM failed: ${result.error}`);
  }
  return typeof result.text === "string" ? result.text : "";
}

function referenceOf(model: RuntimeModelReference): string {
  return model.reference ?? `${model.sdk}:${model.provider === undefined ? "" : `${model.provider}:`}${model.model}`;
}

function mergeStaticRuntimeOptions(
  ...optionsList: readonly (StaticRuntimeOptions | undefined)[]
): StaticRuntimeOptions {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolPolicyInput(config: MonoAgentConfig): ToolPolicyInput {
  if (config.tools.mcpConfigPath === undefined) {
    return {
      allowedTools: config.tools.allowedTools,
      disallowedTools: config.tools.disallowedTools,
    };
  }
  // SDK runtimes only consume inline mcpServers, so the referenced mcp.json is
  // resolved here; the path is still forwarded for CLI runtimes that take it.
  const filePolicy = loadToolPolicyFromJsonFileSync(config.tools.mcpConfigPath);
  return {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    mcpConfigPath: config.tools.mcpConfigPath,
    ...(filePolicy.mcpServers === undefined ? {} : { mcpServers: filePolicy.mcpServers }),
  };
}

function configRuntimeFlags(config: MonoAgentConfig): StaticRuntimeOptions | undefined {
  const { permissionMode } = config.runtime;
  // NOTE: there is intentionally no reasoning-summary runtime option. The sole pi
  // runtime (pi-native) derives reasoning from `effort` and does not consume an
  // explicit summary level, and the codex/claude CLIs emit summaries
  // unconditionally — so the former `piReasoningSummary` runtime option was dead
  // plumbing and the `runtime.reasoningSummary` config field was removed.
  const piNative = config.providers?.piNative;
  if (
    permissionMode === undefined
    && piNative?.piMaxRetries === undefined
    && piNative?.maxRetryDelayMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(piNative?.piMaxRetries === undefined ? {} : { piMaxRetries: piNative.piMaxRetries }),
    ...(piNative?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: piNative.maxRetryDelayMs }),
  };
}

function isRuntimeOptions(value: MonoAgentConfig | ConfiguredAgentRuntimeOptions): value is ConfiguredAgentRuntimeOptions {
  return "config" in value;
}

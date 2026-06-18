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
    recorderFactory: ({ runId, conversationId, userInput }) => {
      // The JSONL recorder is always built first and returned unchanged when no
      // exporter is configured, so default recording stays byte-identical.
      const jsonl = createJsonlRunRecorder({
        runId,
        conversationId,
        artifactDir: config.artifacts.dir,
        ...(userInput === undefined ? {} : { userInput }),
      });
      const exporters = config.observability?.exporters ?? [];
      const exporterCfg = exporters[0];
      if (exporterCfg === undefined) {
        return jsonl;
      }
      // Best-effort, additive export: wrap the JSONL recorder so exporter
      // failures only surface as warnings and never change the run outcome.
      const exporter = (options.exporterFactory ?? createPhoenixRunExporter)(exporterCfg);
      const context: RunExportContext = {
        runId,
        conversationId,
        ...(options.observabilityContext?.sourceId === undefined
          ? {}
          : { sourceId: options.observabilityContext.sourceId }),
        ...(options.observabilityContext?.sourceLabel === undefined
          ? {}
          : { sourceLabel: options.observabilityContext.sourceLabel }),
        ...(options.observabilityContext?.configPath === undefined
          ? {}
          : { configPath: options.observabilityContext.configPath }),
        artifactDir: config.artifacts.dir,
        includeSensitiveData: exporterCfg.includeSensitiveData ?? false,
        ...(userInput === undefined ? {} : { userInput }),
      };
      return createCompositeRunRecorder({
        recorder: jsonl,
        exporter,
        context,
        timeoutMs: exporterCfg.timeoutMs ?? 5000,
        ...(options.exporterWarn === undefined ? {} : { onWarning: options.exporterWarn }),
      });
    },
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function createConfiguredAgentResponder(options: ConfiguredAgentResponderOptions): AgentResponder {
  return createAgentResponder({
    harness: createConfiguredAgentHarness(options),
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
  deps: { logger?: { warn(message: string): void }; runtime?: MonoRuntimeLike } = {},
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
  const llm = configuredMemoryLlm(config, llmConfig, deps.runtime);
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
): LlmComplete | undefined {
  if (llmConfig === undefined) {
    return undefined;
  }
  if (llmConfig.provider === "ollama") {
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
  });
}

const MEMORY_LLM_SYSTEM_PROMPT = [
  "You are the private memory maintenance LLM for mono-agent.",
  "Return only the requested JSON or plain text.",
  "Do not use tools, inspect files, or perform external actions.",
].join(" ");

function createAgentHostMemoryLlm(options: {
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly executionMode: RuntimeExecutionMode;
  readonly cwd: string;
  readonly runtimeOptions?: StaticRuntimeOptions;
  readonly timeoutMs?: number;
}): LlmComplete {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: `agent-host:${referenceOf(options.model)}`,
    async complete(prompt: string): Promise<string> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { ctrl.abort(); }, timeoutMs);
      try {
        const result = await options.runtime.run(MEMORY_LLM_SYSTEM_PROMPT, {
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
        } satisfies RuntimeRunOptions);
        return textFromMemoryRuntimeResult(result);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function textFromMemoryRuntimeResult(result: RuntimeResult): string {
  if (result.cancelled === true) {
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
  // NOTE: config.runtime.reasoningSummary is intentionally NOT forwarded. The
  // sole pi runtime (pi-native) derives reasoning from `effort` and does not
  // consume an explicit summary level, and the codex/claude CLIs emit summaries
  // unconditionally — so the former `piReasoningSummary` runtime option was dead
  // plumbing. The config field is retained for back-compat but has no effect here.
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

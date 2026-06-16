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
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { join } from "node:path";

import { createEntityGraphStore } from "@mono-agent/memory-graph";
import { createJournalMemoryStore } from "@mono-agent/memory-journal";
import { resolveMemoryMcpMainPath } from "@mono-agent/memory-mcp";
import { createBujoMemoryStore, createOllamaLlm } from "@mono-agent/memory-bujo";
import { createMarkdownMemoryStore } from "@mono-agent/memory-md";
import type { MemoryStore } from "@mono-agent/memory-store";
import { createEmbeddingProvider } from "@mono-agent/memory-search";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import {
  createMonoRuntime,
  createPiOAuthApiKeyResolver,
  runtimeOptionsForLocalProvider,
} from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeFallbackChainEntry,
  MonoRuntimeLike,
  RuntimeExecutionMode,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import { createToolPolicy, loadToolPolicyFromJsonFileSync } from "@mono-agent/tool-policy";
import type { ToolPolicyInput } from "@mono-agent/tool-policy";

const MEMORY_RECALL_TOOLS = [
  "memory_read_day",
  "memory_list_days",
  "memory_grep",
  "memory_search",
  "entity_get",
] as const;

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
}

export interface ConfiguredAgentResponderOptions extends ConfiguredAgentHarnessOptions {}

export function createConfiguredAgentRuntime(config: MonoAgentConfig): MonoRuntimeLike;
export function createConfiguredAgentRuntime(options: ConfiguredAgentRuntimeOptions): MonoRuntimeLike;
export function createConfiguredAgentRuntime(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  return createMonoRuntime({
    workspace: config.runtime.workspace,
    qaOutputDir: config.artifacts.dir,
    ...(config.providers?.piAuthPath === undefined
      ? {}
      : { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: config.providers.piAuthPath }) }),
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
  const memory = options.memory ?? createConfiguredMemory(config);
  const model = options.model ?? config.runtime.model;
  const executionMode = options.executionMode ?? config.runtime.executionMode;
  const runtimeOptions = mergeStaticRuntimeOptions(
    runtimeOptionsForLocalProvider(model, config.providers?.local),
    memoryMcpRuntimeOptions(config),
    configRuntimeFlags(config),
    options.runtimeOptions,
  );

  return createAgentHarness({
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    ...(config.context.skillMaxBytes === undefined ? {} : { skillMaxBytes: config.context.skillMaxBytes }),
    selectedSkills: config.context.selectedSkills,
    runtime: options.runtime ?? createConfiguredAgentRuntime({ config, model, executionMode }),
    model,
    executionMode,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    ...(config.runtime.maxTurns === undefined ? {} : { maxTurns: config.runtime.maxTurns }),
    session: {
      mode: config.runtime.session.mode,
      idleTimeoutMs: config.runtime.session.idleTimeoutMs,
    },
    runtimeOptions,
    ...(options.runtimeOptionsForRequest === undefined
      ? {}
      : { runtimeOptionsForRequest: options.runtimeOptionsForRequest }),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    historyStore: options.historyStore ?? createInMemoryHistoryStore({ maxMessages: historyMaxMessages(config.runtime.maxTurns) }),
    toolPolicy: createToolPolicy(toolPolicyInput(config)),
    ...(config.sandbox === undefined ? {} : { sandboxPolicy: config.sandbox }),
    recorderFactory: ({ runId, conversationId }) => createJsonlRunRecorder({
      runId,
      conversationId,
      artifactDir: config.artifacts.dir,
    }),
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

function createConfiguredMemory(config: MonoAgentConfig): MemoryStore | undefined {
  if (config.memory === undefined) {
    return undefined;
  }
  if (config.memory.mode === "bujo") {
    // BuJo memory: SQLite-indexed daily markdown with hybrid recall. Embeddings run in-process
    // (default local Ollama nomic-embed-text); an optional chat LLM enables the intelligent
    // capture/reflection/migration path. No silent markdown fallback — this branch owns "bujo".
    const embeddingsConfig = config.memory.embeddings;
    const embeddings = createEmbeddingProvider({
      provider: embeddingsConfig?.provider ?? "ollama",
      model: embeddingsConfig?.model ?? "nomic-embed-text:v1.5",
      ...(embeddingsConfig?.endpoint !== undefined && { endpoint: embeddingsConfig.endpoint }),
      ...(embeddingsConfig?.apiKey !== undefined && { apiKey: embeddingsConfig.apiKey }),
    });
    const llmConfig = config.memory.llm;
    return createBujoMemoryStore({
      root: config.memory.path,
      embeddings,
      dim: embeddingsConfig?.dim ?? 768,
      maxBytes: config.memory.maxBytes,
      ...(llmConfig?.provider === "ollama" && {
        llm: createOllamaLlm({
          model: llmConfig.model,
          ...(llmConfig.endpoint !== undefined && { endpoint: llmConfig.endpoint }),
        }),
      }),
    });
  }
  if (config.memory.mode === "journal") {
    // The entity graph lives next to the journal; its salient-entity digest is
    // folded into the always-in-context block so long-term memory is present
    // without loading the whole archive.
    const graph = createEntityGraphStore({ path: config.memory.graphPath ?? join(config.memory.path, "graph.jsonl") });
    return createJournalMemoryStore({
      rootDir: config.memory.path,
      maxBytes: config.memory.maxBytes,
      entityDigest: async () => {
        const digest = await graph.digest();
        return digest.length === 0 ? undefined : digest;
      },
    });
  }
  return createMarkdownMemoryStore({
    path: config.memory.path,
    maxBytes: config.memory.maxBytes,
    scope: config.memory.scope,
  });
}

function memoryMcpRuntimeOptions(config: MonoAgentConfig): StaticRuntimeOptions | undefined {
  if (
    config.memory === undefined ||
    config.memory.mode !== "journal" ||
    config.memory.tools?.enabled !== true
  ) {
    return undefined;
  }

  const allowedTools = [
    ...MEMORY_RECALL_TOOLS,
    ...(config.memory.tools.allowJournalAppend ? ["journal_append"] : []),
  ];

  const embeddings = config.memory.embeddings;
  return {
    allowedTools,
    mcpServers: {
      memory: {
        command: "node",
        args: [resolveMemoryMcpMainPath()],
        env: {
          MONO_AGENT_MEMORY_PATH: config.memory.path,
          ...(config.memory.graphPath === undefined
            ? {}
            : { MONO_AGENT_MEMORY_GRAPH_PATH: config.memory.graphPath }),
          ...(embeddings === undefined
            ? {}
            : {
                MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: embeddings.provider,
                MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: embeddings.model,
                ...(embeddings.endpoint === undefined
                  ? {}
                  : { MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: embeddings.endpoint }),
                ...(embeddings.apiKey === undefined
                  ? {}
                  : { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: embeddings.apiKey }),
              }),
        },
      },
    },
  };
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
  const { permissionMode, reasoningSummary } = config.runtime;
  if (permissionMode === undefined && reasoningSummary === undefined) {
    return undefined;
  }
  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(reasoningSummary === undefined ? {} : { piReasoningSummary: reasoningSummary }),
  };
}

function isRuntimeOptions(value: MonoAgentConfig | ConfiguredAgentRuntimeOptions): value is ConfiguredAgentRuntimeOptions {
  return "config" in value;
}

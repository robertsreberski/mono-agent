import {
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "@worklab-ai/agent-harness";
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
  ConversationHistoryStore,
} from "@worklab-ai/agent-harness";
import type { AgentResponder } from "@worklab-ai/agent-contracts";
import type { MonoAgentConfig } from "@worklab-ai/config";
import { createMarkdownMemoryStore } from "@worklab-ai/memory-md";
import type { MemoryStore } from "@worklab-ai/memory-md";
import { createJsonlRunRecorder } from "@worklab-ai/observability";
import {
  createMonoRuntime,
  runtimeOptionsForLocalProvider,
} from "@worklab-ai/runtime-adapter";
import type { MonoRuntimeLike, RuntimeModelReference } from "@worklab-ai/runtime-adapter";
import { createToolPolicy } from "@worklab-ai/tool-policy";
import type { ToolPolicyInput } from "@worklab-ai/tool-policy";

export interface ConfiguredAgentRuntimeOptions {
  readonly config: MonoAgentConfig;
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
  });
}

export function createConfiguredAgentHarness(options: ConfiguredAgentHarnessOptions): AgentHarness {
  const config = options.config;
  const memory = options.memory ?? createConfiguredMemory(config);
  const model = options.model ?? config.runtime.model;
  const executionMode = options.executionMode ?? config.runtime.executionMode;
  const runtimeOptions = {
    ...runtimeOptionsForLocalProvider(model, config.providers?.local),
    ...(options.runtimeOptions ?? {}),
  };

  return createAgentHarness({
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    selectedSkills: config.context.selectedSkills,
    runtime: options.runtime ?? createConfiguredAgentRuntime(config),
    model,
    executionMode,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    maxTurns: config.runtime.maxTurns,
    runtimeOptions,
    ...(options.runtimeOptionsForRequest === undefined
      ? {}
      : { runtimeOptionsForRequest: options.runtimeOptionsForRequest }),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    historyStore: options.historyStore ?? createInMemoryHistoryStore({ maxMessages: config.runtime.maxTurns * 2 }),
    toolPolicy: createToolPolicy(toolPolicyInput(config)),
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

function createConfiguredMemory(config: MonoAgentConfig): MemoryStore | undefined {
  if (config.memory === undefined) {
    return undefined;
  }
  return createMarkdownMemoryStore({
    path: config.memory.path,
    maxBytes: config.memory.maxBytes,
    scope: config.memory.scope,
  });
}

function toolPolicyInput(config: MonoAgentConfig): ToolPolicyInput {
  return {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    ...(config.tools.mcpConfigPath === undefined ? {} : { mcpConfigPath: config.tools.mcpConfigPath }),
  };
}

function isRuntimeOptions(value: MonoAgentConfig | ConfiguredAgentRuntimeOptions): value is ConfiguredAgentRuntimeOptions {
  return "config" in value;
}

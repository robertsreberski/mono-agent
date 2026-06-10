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
import { createMarkdownMemoryStore } from "@mono-agent/memory-md";
import type { MemoryStore } from "@mono-agent/memory-md";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import {
  createMonoRuntime,
  runtimeOptionsForLocalProvider,
} from "@mono-agent/runtime-adapter";
import type { MonoRuntimeLike, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import { createToolPolicy } from "@mono-agent/tool-policy";
import type { ToolPolicyInput } from "@mono-agent/tool-policy";

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
    runtime: options.runtime ?? createConfiguredAgentRuntime({ config, model, executionMode }),
    model,
    executionMode,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    maxTurns: config.runtime.maxTurns,
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

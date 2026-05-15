import type { HistoryMessage } from "@worklab-ai/context";
import type { MemoryStore } from "@worklab-ai/memory-md";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@worklab-ai/observability";
import type { MonoRuntimeLike, RuntimeExecutionMode, RuntimeModelReference, RuntimeResult, RuntimeRunOptions } from "@worklab-ai/runtime-adapter";
import type { ToolPolicy } from "@worklab-ai/tool-policy";

export type MemoryWriteMode = "disabled" | "append-host-summary";

export interface ConversationHistoryStore {
  load(conversationId: string): Promise<readonly HistoryMessage[]>;
  append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void>;
}

export interface InMemoryHistoryStoreOptions {
  readonly maxMessages?: number;
}

export interface AgentHarnessRequest {
  readonly conversationId: string;
  readonly userMessage: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly onEvent?: (event: RuntimeEventLike) => void;
}

export interface AgentHarnessFailure {
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface AgentHarnessResponse {
  readonly text?: string;
  readonly metadata: {
    readonly runId: string;
    readonly conversationId: string;
    readonly contextSources: readonly string[];
    readonly contextSectionIds: readonly string[];
    readonly runtime?: Record<string, unknown>;
    readonly summary?: RunSummary;
  };
  readonly failure?: AgentHarnessFailure;
}

export interface AgentHarness {
  run(request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
}

export interface AgentHarnessRecorderFactoryInput {
  readonly runId: string;
  readonly conversationId: string;
}

export interface AgentHarnessOptions {
  readonly identityPath: string;
  readonly soulPath?: string;
  readonly skillsRoot?: string;
  readonly selectedSkills?: readonly string[];
  readonly skillMaxBytes?: number;
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly executionMode: RuntimeExecutionMode;
  readonly cwd?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly runtimeOptions?: Omit<RuntimeRunOptions, "model" | "messages" | "abortSignal" | "executionMode" | "onEvent">;
  readonly memory?: MemoryStore;
  readonly memoryWriteMode?: MemoryWriteMode;
  readonly historyStore?: ConversationHistoryStore;
  readonly toolPolicy?: ToolPolicy;
  readonly recorderFactory?: (input: AgentHarnessRecorderFactoryInput) => RunRecorder;
  readonly createRunId?: () => string;
  readonly now?: () => Date;
}

export interface AgentRequestLike {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentMessageStreamLike {
  append(delta: string): Promise<void>;
}

export interface AgentResponseLike {
  readonly text?: string;
  readonly metadata?: Record<string, unknown>;
}

export type RuntimeFailureResult = Pick<RuntimeResult, "cancelled" | "error" | "failureKind" | "errorDetails">;

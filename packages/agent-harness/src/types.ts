import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@worklab-ai/agent-contracts";
import type { BuiltAgentContext, HistoryMessage } from "@worklab-ai/context";
import type { MemoryStore } from "@worklab-ai/memory-md";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@worklab-ai/observability";
import type { MonoRuntimeLike, RuntimeModelReference, RuntimeResult, RuntimeRunOptions } from "@worklab-ai/runtime-adapter";
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
  /** Retire all live provider sessions (graceful shutdown). */
  dispose?(): Promise<void>;
}

export type AgentSessionMode = "continuous" | "per-message";

export interface AgentHarnessSessionOptions {
  readonly mode: AgentSessionMode;
  readonly idleTimeoutMs: number;
  /**
   * Overrides backend capability detection (monoRuntimeSupportsSessionResume)
   * — primarily for tests and custom runtimes.
   */
  readonly supportsResume?: boolean;
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
  readonly executionMode?: string;
  readonly cwd?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly runtimeOptions?: Omit<RuntimeRunOptions, "model" | "messages" | "abortSignal" | "executionMode" | "onEvent">;
  readonly runtimeOptionsForRequest?: (
    input: AgentHarnessRuntimeOptionsInput,
  ) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;
  readonly memory?: MemoryStore;
  readonly memoryWriteMode?: MemoryWriteMode;
  readonly historyStore?: ConversationHistoryStore;
  readonly toolPolicy?: ToolPolicy;
  readonly recorderFactory?: (input: AgentHarnessRecorderFactoryInput) => RunRecorder;
  readonly createRunId?: () => string;
  readonly now?: () => Date;
  readonly session?: AgentHarnessSessionOptions;
}

export interface AgentHarnessRuntimeOptionsInput {
  readonly request: AgentHarnessRequest;
  readonly runId: string;
  readonly context: BuiltAgentContext;
}

export interface AgentHarnessRuntimeOptionsExtension {
  readonly runtimeOptions?: Omit<RuntimeRunOptions, "model" | "messages" | "abortSignal" | "executionMode" | "onEvent">;
  readonly cleanup?: () => void | Promise<void>;
}

export type AgentRequestLike = AgentRequestBase;
export type AgentMessageStreamLike = AgentMessageStream;
export type AgentResponseLike = AgentResponse;
export type AgentResponderLike = AgentResponder;

export type RuntimeFailureResult = Pick<RuntimeResult, "cancelled" | "error" | "failureKind" | "errorDetails">;

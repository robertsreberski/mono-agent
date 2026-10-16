

import type { AgentMessageFinishOptions, AgentResponseMetadata } from "./response.js";

export type SessionToolHistoryTerminalState =
  | "success"
  | "rejected"
  | "error"
  | "exit_nonzero"
  | "timeout"
  | "signal"
  | "cancelled"
  | "interrupted";

/** Host lifecycle acknowledgement used by model history and client rendering. */
export interface SessionToolHistoryEventMetadata {
  readonly recordId?: string;
  readonly sequence?: number;
  /** Persisted before publication, deferred for reconciliation, or definitively failed. */
  readonly persistence: "persisted" | "deferred" | "failed";
  readonly terminalState?: SessionToolHistoryTerminalState;
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly retainedBytes?: number;
  readonly artifactReferences?: readonly {
    readonly id: string;
    readonly available: boolean;
  }[];
  readonly errorCode?: string;
  /** Historical tool content is data, never executable instruction. */
  readonly untrusted: true;
}

export type AgentStreamEvent =
  | {
      readonly type: "assistant_thought";
      readonly text: string;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_started";
      readonly id: string;
      readonly name: string;
      readonly arguments?: unknown;
      readonly history?: SessionToolHistoryEventMetadata;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_completed";
      readonly id: string;
      readonly name?: string;
      readonly arguments?: unknown;
      readonly content?: unknown;
      /**
       * A bounded machine-readable tool result, from MCP or a canonical host tool
       * outcome. `content` is model-facing and deliberately lossy; consumers that need
       * exact outcome fields read and validate their versioned schema here.
       */
      readonly structuredContent?: unknown;
      readonly isError?: boolean;
      /** Wall-clock tool execution time, when the runtime reported it. */
      readonly executionMs?: number;
      readonly history?: SessionToolHistoryEventMetadata;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_progress";
      readonly id: string;
      readonly name?: string;
      /** Partial tool output captured while the tool is still running. */
      readonly partialResult?: unknown;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "usage_update";
      readonly model?: string;
      /** Cumulative run cost in USD, when the runtime prices the model. */
      readonly cumulativeUsd?: number;
      readonly tokens?: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheCreation: number;
      };
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "provider_status";
      readonly kind:
        | "request_started"
        | "request_completed"
        | "failover_started"
        | "failover_completed"
        /** A same-model retry is about to run after a transient provider failure. */
        | "retry_started";
      readonly model?: string;
      readonly from?: string;
      readonly to?: string;
      /** Index of the route in the fallback chain. Stable across same-model retries. */
      readonly attemptIndex?: number;
      /** Which retry of `attemptIndex` this is: 1 for the first retry, 2 for the second. */
      readonly retryIndex?: number;
      /**
       * Classified failure subkind that caused this transition ("overloaded",
       * "rate_limited", "context_limit", …), on `failover_started` and
       * `retry_started`. Absent when the router could not classify it.
       */
      readonly reason?: string;
      readonly durationMs?: number;
      readonly cancelled?: boolean;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "memory_recalled";
      readonly source?: string;
      readonly bytes?: number;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      /**
       * Catch-all for low-frequency runtime telemetry (cache_hit/cache_miss,
       * capabilities_resolved, provider_bridge_latency, …) so new kinds ride
       * through without further union growth. Consumers render or ignore by
       * `kind`; `data` is the raw event payload minus its `type`.
       */
      readonly type: "runtime_telemetry";
      readonly kind: string;
      readonly data?: Record<string, unknown>;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "runtime_warning";
      readonly message: string;
      readonly warningKind?: string;
      readonly metadata?: AgentResponseMetadata;
    };

export interface AgentMessageStream {
  status?(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace?(text: string): Promise<void>;
  event?(event: AgentStreamEvent): Promise<void>;
  finish?(finalText?: string, options?: AgentMessageFinishOptions): Promise<void>;
}

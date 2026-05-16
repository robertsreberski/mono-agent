/**
 * Structural agent contract for the TUI.
 *
 * Mirrors the shape exported by @worklab-ai/telegram-bridge so any
 * AgentResponder produced by createAgentResponder({ harness }) from
 * @worklab-ai/agent-harness can be wired in without an additional dep.
 *
 * Kept duplicated on purpose — a shared @worklab-ai/agent-contracts
 * package would couple every adapter to a new release boundary, which is
 * out of scope for v1.
 */

export interface AgentRequestLike {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentResponseLike {
  readonly text?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Stream surface the responder receives. The `append` method is the only
 * member required by the harness; `status`, `replace`, and `finish` are
 * optional convenience hooks that let richer responders push UI updates
 * (status spinner labels, full-text replacements, final flush).
 */
export interface AgentMessageStreamLike {
  status?(text: string): Promise<void>;
  append(delta: string): Promise<void>;
  replace?(text: string): Promise<void>;
  finish?(finalText?: string): Promise<void>;
}

export interface AgentResponderLike {
  respond(
    request: AgentRequestLike,
    stream: AgentMessageStreamLike,
  ): Promise<AgentResponseLike>;
}

export interface TuiAgentCancelledErrorOptions {
  readonly reason?: unknown;
}

/**
 * Thrown by the TUI host when the user cancels an in-flight response (esc
 * key, or programmatic stop). Mirrors @worklab-ai/telegram-bridge's
 * AgentResponderCancelledError so existing harness responders can rethrow
 * either type and the TUI will render the same `cancelled` badge.
 */
export class TuiAgentCancelledError extends Error {
  readonly reason?: unknown;

  constructor(
    message = "Agent response was cancelled.",
    options: TuiAgentCancelledErrorOptions = {},
  ) {
    super(message);
    this.name = "TuiAgentCancelledError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

/**
 * Recognises both the local TuiAgentCancelledError and the duck-typed
 * AgentResponderCancelledError from @worklab-ai/telegram-bridge so hosts
 * can throw either without coupling the TUI to telegram-bridge.
 */
export function isTuiAgentCancelledError(error: unknown): boolean {
  if (error instanceof TuiAgentCancelledError) {
    return true;
  }
  if (error instanceof Error && error.name === "AgentResponderCancelledError") {
    return true;
  }
  return false;
}

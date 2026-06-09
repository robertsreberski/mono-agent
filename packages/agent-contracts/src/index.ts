export type AgentRequestMetadata = Record<string, unknown>;
export type AgentResponseMetadata = Record<string, unknown>;

export interface AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: AgentRequestMetadata;
}

export interface AgentResponse {
  readonly text?: string;
  readonly metadata?: AgentResponseMetadata;
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
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly type: "tool_call_completed";
      readonly id: string;
      readonly name?: string;
      readonly arguments?: unknown;
      readonly content?: unknown;
      readonly isError?: boolean;
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
  finish?(finalText?: string): Promise<void>;
}

export interface AgentMessageStreamResult {
  readonly text?: string;
  readonly metadata?: AgentResponseMetadata;
}

export interface AgentResponder<
  Request extends AgentRequestBase = AgentRequestBase,
  Stream extends AgentMessageStream = AgentMessageStream,
  Response extends AgentResponse = AgentResponse,
> {
  respond(request: Request, stream: Stream): Promise<Response>;
}

export interface AgentResponseCancelledErrorOptions {
  readonly reason?: unknown;
}

export class AgentResponseCancelledError extends Error {
  readonly reason?: unknown;

  constructor(
    message = "Agent response was cancelled.",
    options: AgentResponseCancelledErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentResponseCancelledError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export function isAgentResponseCancelledError(
  error: unknown,
): error is AgentResponseCancelledError {
  if (error instanceof AgentResponseCancelledError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AgentResponseCancelledError" ||
    error.name === "AgentResponderCancelledError" ||
    error.name === "TuiAgentCancelledError";
}

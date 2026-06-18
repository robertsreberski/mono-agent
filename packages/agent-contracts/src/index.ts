export type AgentRequestMetadata = Record<string, unknown>;
export type AgentResponseMetadata = Record<string, unknown>;

/**
 * A multimodal attachment that accompanies a request — an image to be fed to a
 * vision model, or a document whose bytes (and/or extracted text) can be inlined
 * into the prompt. Transport-agnostic: channels populate it; runtimes consume it.
 */
export interface AgentAttachment {
  readonly kind: "image" | "document";
  /** MIME type, e.g. "image/png" or "application/pdf". */
  readonly mimeType: string;
  /** Raw attachment bytes, base64-encoded. */
  readonly data: string;
  /** Original file name, when known. */
  readonly name?: string;
  /** Size of the decoded bytes, when known. */
  readonly sizeBytes?: number;
  /** Extracted text for documents, when available. */
  readonly text?: string;
}

export interface AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: AgentRequestMetadata;
  readonly attachments?: readonly AgentAttachment[];
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

export interface AgentResponder<
  Request extends AgentRequestBase = AgentRequestBase,
  Stream extends AgentMessageStream = AgentMessageStream,
  Response extends AgentResponse = AgentResponse,
> {
  respond(request: Request, stream: Stream): Promise<Response>;
  /**
   * Optional: abort the in-flight turn for a conversation and clear any queued
   * follow-ups. Channels call this on an explicit user cancel (e.g. /cancel).
   */
  cancel?(conversationId: string, reason?: unknown): void;
}

export interface AgentResponseCancelledErrorOptions {
  readonly reason?: unknown;
}

export class AgentResponseCancelledError extends Error {
  readonly reason?: unknown;
  /**
   * Stable brand so the guard recognizes cancellation even across duplicate
   * class identities (e.g. two copies of this package in a dependency graph),
   * without string-matching subclass `name`s.
   */
  readonly agentResponseCancelled = true as const;

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
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { agentResponseCancelled?: unknown }).agentResponseCancelled === true
  );
}

export { CodedError, isCodedError } from "./coded-error.js";
export {
  BufferedMessageStream,
} from "./buffered-message-stream.js";
export type {
  BufferedMessageStreamOptions,
} from "./buffered-message-stream.js";
export {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  buildStreamingTailPreview,
  normalizeTrailing,
  splitTextByCodePoints,
} from "./stream-text.js";
export { toolHintFor } from "./tool-hints.js";
export {
  ResilientMessageStream,
  ChannelDeliveryError,
} from "./resilient-message-stream.js";
export type {
  ChannelTransport,
  ChannelSendOutcome,
  MessageRef,
  ResilientMessageStreamOptions,
  ResilientMessageStreamLogger,
  ResilientAgentMessageStream,
} from "./resilient-message-stream.js";

import type { AgentHarness, AgentHarnessFailure } from "./types.js";
import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
  AgentStreamEvent,
} from "@mono-agent/agent-contracts";

export class AgentHarnessFailureError extends Error {
  readonly failure: AgentHarnessFailure;

  constructor(failure: AgentHarnessFailure) {
    super(failure.message);
    this.name = "AgentHarnessFailureError";
    this.failure = failure;
  }
}

export type SessionRollover = "none" | "daily";

export function createAgentResponder(options: {
  readonly harness: AgentHarness;
  /**
   * Session rollover policy applied centrally to EVERY channel (cron, telegram,
   * slack, whatsapp, …) that routes through this responder. "daily" appends a
   * local-date bucket to the conversationId so a new calendar day starts a fresh
   * session (queue/warm-session/durable transcript/history all key off
   * conversationId), bounding unbounded growth. Default "none" = unchanged.
   */
  readonly rollover?: SessionRollover;
  readonly rolloverTimezone?: string;
  /** Injectable clock for the rollover date; defaults to the system clock. */
  readonly now?: () => Date;
}): AgentResponder & {
  dispose(): Promise<void>;
  cancel(conversationId: string, reason?: unknown): void;
} {
  if (typeof options.harness?.run !== "function") {
    throw new TypeError("createAgentResponder requires a harness with run().");
  }

  // Prefer submit() (queue-after-turn: a mid-run follow-up is answered on the
  // warm session after the current turn) and fall back to run() for harnesses
  // that do not implement it.
  const invoke = typeof options.harness.submit === "function"
    ? options.harness.submit.bind(options.harness)
    : options.harness.run.bind(options.harness);

  const now = options.now ?? ((): Date => new Date());
  const bucket = (conversationId: string): string =>
    bucketConversationId(conversationId, options.rollover, options.rolloverTimezone, now);

  return {
    async dispose(): Promise<void> {
      await options.harness.dispose?.();
    },
    cancel(conversationId: string, reason?: unknown): void {
      // Bucket identically to respond() so the cancel targets the same queue/
      // session key the in-flight turn is using.
      options.harness.cancel?.(bucket(conversationId), reason);
    },
    async deliverVerbatim(conversationId: string, text: string): Promise<void> {
      // Bucket identically to respond() so the verbatim post lands under the same
      // history/session key a later reply on this conversation will resume.
      await options.harness.appendVerbatimTurn?.(bucket(conversationId), text);
    },
    async respond(request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> {
      const runtimeEventStream = createRuntimeEventStream(stream);
      const response = await invoke({
        conversationId: bucket(request.conversationId),
        userMessage: request.text,
        abortSignal: request.abortSignal,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        onEvent: (event) => {
          const streamEvent = streamEventFromRuntimeEvent(event);
          if (streamEvent !== undefined) {
            runtimeEventStream.enqueueEvent(streamEvent);
          }
          const delta = assistantTextFromRuntimeEvent(event);
          if (delta.length > 0) {
            runtimeEventStream.enqueueText(delta);
          }
        },
      });
      await runtimeEventStream.flush();

      if (response.failure !== undefined) {
        throw new AgentHarnessFailureError(response.failure);
      }

      return {
        ...(response.text === undefined ? {} : { text: response.text }),
        metadata: { ...response.metadata },
      };
    },
  };
}

export function assistantTextFromRuntimeEvent(event: unknown): string {
  if (!isRecord(event) || event.type !== "assistant") {
    return "";
  }
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  let text = "";
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && stringField(block, "phase") !== "commentary" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

export function streamEventFromRuntimeEvent(event: unknown): AgentStreamEvent | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  if (event.type === "runtime_warning") {
    const message = stringField(event, "message");
    if (message === undefined) {
      return undefined;
    }
    const warningKind = stringField(event, "warning_kind");
    return {
      type: "runtime_warning",
      message,
      ...(warningKind === undefined ? {} : { warningKind }),
    };
  }
  if (event.type !== "assistant" && event.type !== "user") {
    return undefined;
  }
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (event.type === "assistant") {
      const thought = thoughtTextFromBlock(block);
      if (thought !== undefined) {
        return { type: "assistant_thought", text: thought };
      }
      if (block.type === "tool_use") {
        const id = stringField(block, "id");
        const name = stringField(block, "name");
        if (id !== undefined && name !== undefined) {
          return {
            type: "tool_call_started",
            id,
            name,
            ...(hasOwn(block, "input") ? { arguments: block.input } : {}),
          };
        }
      }
    }
    if (event.type === "user" && block.type === "tool_result") {
      const id = stringField(block, "tool_use_id") ?? stringField(block, "tool_call_id");
      if (id !== undefined) {
        return {
          type: "tool_call_completed",
          id,
          ...(hasOwn(block, "content") ? { content: block.content } : {}),
          ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
        };
      }
    }
  }
  return undefined;
}

function createRuntimeEventStream(stream: AgentMessageStream): {
  enqueueText(delta: string): void;
  enqueueEvent(event: AgentStreamEvent): void;
  flush(): Promise<void>;
} {
  // A serialized promise chain preserves the order of text deltas and events
  // while letting the runtime's onEvent stay synchronous. Each delta is appended
  // immediately (no microtask batching) so SSE consumers like Open WebUI receive
  // tokens as they are produced rather than in coalesced bursts; the SSE adapter
  // itself disables Nagle so each chunk leaves the socket promptly.
  let chain = Promise.resolve();
  let firstError: unknown;
  function enqueue(operation: () => Promise<void>): void {
    chain = chain
      .then(async () => {
        if (firstError !== undefined) {
          return;
        }
        await operation();
      })
      .catch((error: unknown) => {
        if (firstError === undefined) {
          firstError = error;
        }
      });
  }
  return {
    enqueueText(delta: string): void {
      if (delta.length === 0) {
        return;
      }
      enqueue(async () => {
        await stream.append(delta);
      });
    },
    enqueueEvent(event: AgentStreamEvent): void {
      enqueue(async () => {
        if (typeof stream.event === "function") {
          await stream.event(event);
          return;
        }
        if (event.type === "assistant_thought" && typeof stream.status === "function") {
          await stream.status(event.text);
        }
      });
    },
    async flush(): Promise<void> {
      await chain;
      if (firstError !== undefined) {
        throw firstError;
      }
    },
  };
}

function thoughtTextFromBlock(block: Record<string, unknown>): string | undefined {
  if (block.type === "thinking") {
    return stringField(block, "text") ?? stringField(block, "thinking") ?? stringField(block, "content");
  }
  if (block.type === "text" && stringField(block, "phase") === "commentary") {
    return stringField(block, "text");
  }
  return undefined;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Append a local-date bucket (`#YYYY-MM-DD`) to a conversationId under the
 * "daily" rollover policy. Idempotent — re-bucketing within the same day is a
 * no-op — and a passthrough when rollover is off. Exported for unit testing.
 */
export function bucketConversationId(
  conversationId: string,
  rollover: SessionRollover | undefined,
  timezone: string | undefined,
  now: () => Date,
): string {
  if (rollover !== "daily") {
    return conversationId;
  }
  const suffix = `#${formatRolloverDay(now(), timezone)}`;
  return conversationId.endsWith(suffix) ? conversationId : `${conversationId}${suffix}`;
}

function formatRolloverDay(date: Date, timezone: string | undefined): string {
  // en-CA renders as YYYY-MM-DD. Fall back to the system-local date when the
  // configured timezone is invalid rather than throwing on a hot path.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

import type {
  AgentHarness,
  AgentHarnessFailure,
  AgentMessageStreamLike,
  AgentRequestLike,
  AgentResponderLike,
  AgentResponseLike,
} from "./types.js";
import type { AgentStreamEvent } from "@worklab-ai/agent-contracts";

export class AgentHarnessFailureError extends Error {
  readonly failure: AgentHarnessFailure;

  constructor(failure: AgentHarnessFailure) {
    super(failure.message);
    this.name = "AgentHarnessFailureError";
    this.failure = failure;
  }
}

export function createAgentResponder(options: { readonly harness: AgentHarness }): {
  respond: AgentResponderLike["respond"];
} {
  if (typeof options.harness?.run !== "function") {
    throw new TypeError("createAgentResponder requires a harness with run().");
  }

  return {
    async respond(request: AgentRequestLike, stream: AgentMessageStreamLike): Promise<AgentResponseLike> {
      const runtimeEventStream = createRuntimeEventStream(stream);
      const response = await options.harness.run({
        conversationId: request.conversationId,
        userMessage: request.text,
        abortSignal: request.abortSignal,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
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

function createRuntimeEventStream(stream: AgentMessageStreamLike): {
  enqueueText(delta: string): void;
  enqueueEvent(event: AgentStreamEvent): void;
  flush(): Promise<void>;
} {
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
  return typeof value === "object" && value !== null;
}

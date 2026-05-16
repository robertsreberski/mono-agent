import type {
  AgentHarness,
  AgentHarnessFailure,
  AgentMessageStreamLike,
  AgentRequestLike,
  AgentResponderLike,
  AgentResponseLike,
} from "./types.js";

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
          const delta = assistantTextFromRuntimeEvent(event);
          if (delta.length > 0) {
            runtimeEventStream.enqueue(delta);
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
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function createRuntimeEventStream(stream: AgentMessageStreamLike): {
  enqueue(delta: string): void;
  flush(): Promise<void>;
} {
  let chain = Promise.resolve();
  let firstError: unknown;
  return {
    enqueue(delta: string): void {
      chain = chain
        .then(async () => {
          if (firstError !== undefined) {
            return;
          }
          await stream.append(delta);
        })
        .catch((error: unknown) => {
          if (firstError === undefined) {
            firstError = error;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

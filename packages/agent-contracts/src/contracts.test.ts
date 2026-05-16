import { describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
} from "./index.js";

describe("shared agent contracts", () => {
  it("defines a structural responder and message stream contract", async () => {
    const chunks: string[] = [];
    const stream: AgentMessageStream = {
      async append(delta) {
        chunks.push(delta);
      },
    };
    const responder: AgentResponder = {
      async respond(request: AgentRequestBase, output) {
        await output.append(`echo:${request.text}`);
        return { text: request.text, metadata: { ok: true } };
      },
    };

    const response = await responder.respond({
      conversationId: "local:1",
      text: "hello",
      abortSignal: new AbortController().signal,
    }, stream);

    expect(chunks).toEqual(["echo:hello"]);
    expect(response).toEqual({ text: "hello", metadata: { ok: true } });
  });

  it("recognizes canonical and compatibility cancellation errors", () => {
    const reason = { code: "cancelled" };
    const error = new AgentResponseCancelledError("stop", { reason });
    expect(error.name).toBe("AgentResponseCancelledError");
    expect(error.reason).toBe(reason);
    expect(isAgentResponseCancelledError(error)).toBe(true);

    class AgentResponderCancelledError extends Error {
      constructor() {
        super("legacy");
        this.name = "AgentResponderCancelledError";
      }
    }

    class TuiAgentCancelledError extends Error {
      constructor() {
        super("legacy");
        this.name = "TuiAgentCancelledError";
      }
    }

    expect(isAgentResponseCancelledError(new AgentResponderCancelledError())).toBe(true);
    expect(isAgentResponseCancelledError(new TuiAgentCancelledError())).toBe(true);
    expect(isAgentResponseCancelledError(new Error("boom"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
} from "../index.js";

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

  it("recognizes cancellation via instanceof, subclass, and cross-realm brand", () => {
    const reason = { code: "cancelled" };
    const error = new AgentResponseCancelledError("stop", { reason });
    expect(error.name).toBe("AgentResponseCancelledError");
    expect(error.reason).toBe(reason);
    expect(isAgentResponseCancelledError(error)).toBe(true);

    // Real subclasses (e.g. tui's TuiAgentCancelledError) extend the base, so
    // instanceof + the inherited brand recognizes them without naming them.
    class TuiAgentCancelledError extends AgentResponseCancelledError {
      constructor() {
        super("legacy");
        this.name = "TuiAgentCancelledError";
      }
    }
    expect(isAgentResponseCancelledError(new TuiAgentCancelledError())).toBe(true);

    // A duplicate class identity is still recognized via the stable brand.
    const crossRealm = { name: "AgentResponseCancelledError", agentResponseCancelled: true };
    expect(isAgentResponseCancelledError(crossRealm)).toBe(true);

    // Arbitrary errors that merely share a name are no longer matched.
    const nameOnly = new Error("legacy");
    nameOnly.name = "AgentResponderCancelledError";
    expect(isAgentResponseCancelledError(nameOnly)).toBe(false);
    expect(isAgentResponseCancelledError(new Error("boom"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentStreamEvent,
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

  it("rejects non-Error inputs without a cancellation brand", () => {
    expect(isAgentResponseCancelledError(undefined)).toBe(false);
    expect(isAgentResponseCancelledError(null)).toBe(false);
    expect(isAgentResponseCancelledError("cancelled")).toBe(false);
    expect(isAgentResponseCancelledError(42)).toBe(false);
    // Plain objects only match when the brand is exactly `true`.
    expect(isAgentResponseCancelledError({ agentResponseCancelled: false })).toBe(false);
    expect(isAgentResponseCancelledError({ agentResponseCancelled: "yes" })).toBe(false);
    expect(isAgentResponseCancelledError({})).toBe(false);
  });

  it("covers every AgentStreamEvent variant (compile-time exhaustiveness)", () => {
    // A switch with a `never`-typed default fails to compile if a new variant is
    // added to AgentStreamEvent.type without being handled here.
    function describeEvent(event: AgentStreamEvent): string {
      switch (event.type) {
        case "assistant_thought":
          return event.text;
        case "tool_call_started":
          return `${event.id}:${event.name}`;
        case "tool_call_completed":
          return event.id;
        case "runtime_warning":
          return event.message;
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    }

    expect(describeEvent({ type: "assistant_thought", text: "thinking" })).toBe("thinking");
    expect(describeEvent({ type: "tool_call_started", id: "t1", name: "search" })).toBe("t1:search");
    expect(describeEvent({ type: "tool_call_completed", id: "t1" })).toBe("t1");
    expect(describeEvent({ type: "runtime_warning", message: "warned" })).toBe("warned");
  });
});

import { describe, expect, it } from "vitest";

import {
  TuiAgentCancelledError,
  isTuiAgentCancelledError,
} from "../agent/responder.js";

describe("TuiAgentCancelledError", () => {
  it("defaults to the canonical cancelled message", () => {
    const error = new TuiAgentCancelledError();
    expect(error.name).toBe("TuiAgentCancelledError");
    expect(error.message).toBe("Agent response was cancelled.");
    expect(error.reason).toBeUndefined();
  });

  it("preserves a caller-supplied reason", () => {
    const reason = new Error("upstream abort");
    const error = new TuiAgentCancelledError("cancelled", { reason });
    expect(error.message).toBe("cancelled");
    expect(error.reason).toBe(reason);
  });
});

describe("isTuiAgentCancelledError", () => {
  it("recognises native instances", () => {
    expect(isTuiAgentCancelledError(new TuiAgentCancelledError())).toBe(true);
  });

  it("recognises duck-typed AgentResponderCancelledError from telegram-adapter", () => {
    class AgentResponderCancelledError extends Error {
      constructor() {
        super("cancelled");
        this.name = "AgentResponderCancelledError";
      }
    }
    expect(isTuiAgentCancelledError(new AgentResponderCancelledError())).toBe(true);
  });

  it("rejects unrelated errors and non-error values", () => {
    expect(isTuiAgentCancelledError(new Error("boom"))).toBe(false);
    expect(isTuiAgentCancelledError("cancelled")).toBe(false);
    expect(isTuiAgentCancelledError(undefined)).toBe(false);
  });
});

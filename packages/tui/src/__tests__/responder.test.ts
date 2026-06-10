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

  it("recognises a cross-realm cancellation via the stable brand", () => {
    // A duplicate agent-contracts copy (or another adapter's alias) produces an
    // error carrying the stable brand rather than a recognizable class identity.
    const crossRealm = {
      name: "AgentResponseCancelledError",
      agentResponseCancelled: true,
    };
    expect(isTuiAgentCancelledError(crossRealm)).toBe(true);
  });

  it("rejects unrelated errors, name-only lookalikes, and non-error values", () => {
    const nameOnly = new Error("cancelled");
    nameOnly.name = "AgentResponderCancelledError";
    expect(isTuiAgentCancelledError(nameOnly)).toBe(false);
    expect(isTuiAgentCancelledError(new Error("boom"))).toBe(false);
    expect(isTuiAgentCancelledError("cancelled")).toBe(false);
    expect(isTuiAgentCancelledError(undefined)).toBe(false);
  });
});

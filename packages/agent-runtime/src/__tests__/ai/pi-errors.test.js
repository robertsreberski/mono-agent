import { describe, expect, it } from "vitest";

import { isContextLimitError, normalizePiErrorMessage } from "../../ai/providers/pi-errors.js";

describe("isContextLimitError", () => {
  const contextLimitMessages = [
    // Previously-matched phrasings (must keep matching).
    "context_length_exceeded",
    "context length exceeded",
    "This model's maximum context length is 128000 tokens",
    "exceeds the context window",
    "too many tokens",
    "token limit exceeded",
    "prompt is too long",
    // Newly-covered phrasings.
    "max tokens reached",
    "max_tokens exceeded",
    "maximum tokens for this model",
    "context window exceeded",
    "context budget exhausted",
    "prompt too long",
    "the request exceeds max context",
    "exceeds maximum",
    "input tokens exceed the limit",
    "input exceeds the allowed size",
    "output tokens exceed the cap",
    "tokens exceed the model limit",
  ];

  for (const message of contextLimitMessages) {
    it(`classifies as context-limit: "${message}"`, () => {
      expect(isContextLimitError(message)).toBe(true);
    });
  }

  const nonContextLimitMessages = [
    "",
    "rate limit exceeded",
    "Rate limit reached for requests",
    "too many requests, slow down",
    "internal server error",
    "invalid api key",
    "network timeout",
  ];

  for (const message of nonContextLimitMessages) {
    it(`does not classify as context-limit: "${message}"`, () => {
      expect(isContextLimitError(message)).toBe(false);
    });
  }

  it("lets rate-limit wording win even when token wording is also present", () => {
    expect(isContextLimitError("rate limit: too many tokens")).toBe(false);
  });
});

describe("normalizePiErrorMessage", () => {
  it("unwraps a Codex error envelope", () => {
    const raw = 'Codex error: {"type":"error","error":{"message":"context_length_exceeded"}}';
    expect(normalizePiErrorMessage(raw)).toBe("context_length_exceeded");
  });

  it("returns null for empty input", () => {
    expect(normalizePiErrorMessage("")).toBeNull();
  });
});

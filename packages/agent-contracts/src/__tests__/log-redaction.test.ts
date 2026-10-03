import { describe, expect, it, vi } from "vitest";

import { createLogRedactor } from "../log-redaction.js";

const redactor = createLogRedactor({
  tokenMarker: "[REDACTED_TOKEN]",
  unavailableMarker: "[LOG_UNAVAILABLE]",
  truncatedMarker: "[LOG_TRUNCATED]",
  binaryMarker: "[BINARY_OMITTED]",
  tokenPatterns: [{ pattern: /opaque-[a-z]{8,}/gu }],
});

describe("shared diagnostic redaction", () => {
  it.each(["api%4bey", "ticket", "%74oken", "%74oken%ZZ", "auth[token]"])(
    "redacts sensitive query key %s while preserving non-sensitive URL context",
    (key) => {
      const safe = redactor.redactText(`https://host.invalid/path?${key}=private-value&page=3`);
      expect(safe).toBe(`https://host.invalid/path?${key}=[REDACTED_BEARER_CREDENTIAL]&page=3`);
    },
  );

  it("keeps token rules and diagnostic labels isolated between redactor instances", () => {
    const other = createLogRedactor({
      tokenMarker: "[OTHER_TOKEN]",
      unavailableMarker: "[OTHER_UNAVAILABLE]",
      truncatedMarker: "[OTHER_TRUNCATED]",
      binaryMarker: "[OTHER_BINARY]",
      tokenPatterns: [{ pattern: /different-[a-z]{8,}/gu }],
    });
    const input = "opaque-abcdefgh different-abcdefgh";
    expect(redactor.redactText(input)).toBe("[REDACTED_TOKEN] different-abcdefgh");
    expect(other.redactText(input)).toBe("opaque-abcdefgh [OTHER_TOKEN]");
    expect(other.redactText("a".repeat(16_385))).toBe("[OTHER_TRUNCATED]");
  });

  it("renders callback errors without executing inherited accessors or proxy traps", () => {
    const trap = vi.fn(() => { throw new Error("private-value"); });
    const accessorError = Object.create(Object.create(Error.prototype, {
      message: { get: trap },
      name: { get: trap },
    })) as Error;
    const proxy = new Proxy(new Error("private-value"), {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    for (const error of [accessorError, proxy]) {
      const safe = redactor.redactError(error, []);
      expect(safe).toBeInstanceOf(Error);
      expect(safe.message).toBe("[LOG_UNAVAILABLE]");
      expect(JSON.stringify(safe)).not.toContain("private-value");
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("preserves an error's safe diagnostic context and sanitizes its cause", () => {
    const failure = Object.assign(new TypeError("request failed: opaque-abcdefgh", {
      cause: { request: new URL("https://host.invalid/?ticket=private-value") },
    }), { phase: "connect" });
    Object.defineProperty(failure, "stack", {
      value: "TypeError: request failed: opaque-abcdefgh\n    at request (client.js:1:1)",
    });
    const safe = redactor.redactError(failure, []);
    expect(safe.name).toBe("TypeError");
    expect(safe.message).toBe("request failed: [REDACTED_TOKEN]");
    expect(safe.stack).toContain("request failed: [REDACTED_TOKEN]");
    expect(safe.cause).toEqual({
      request: "https://host.invalid/?ticket=[REDACTED_BEARER_CREDENTIAL]",
    });
    expect(JSON.stringify(safe)).toContain('"phase":"connect"');
  });

  it("contains async sink failures after applying bounded metadata sanitization", async () => {
    const sink = vi.fn(async () => { throw new Error("sink failed"); });
    const logger = redactor.createLogger({ error: sink }, []);
    logger?.error?.("request failed", { huge: new Array(257).fill("private-value") });
    await Promise.resolve();
    expect(sink).toHaveBeenCalledWith("request failed", { huge: ["[LOG_TRUNCATED]"] });
  });
});

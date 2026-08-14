import { describe, expect, it } from "vitest";

import { loadAdvisorConfig } from "../config.js";
import {
  advisorSuccess,
  advisorToolResult,
  continuityIdForSessionKey,
  createAdvisorOutputSchema,
  createReviewIterationInputSchema,
  normalizeAdvisorSessionKey,
} from "../protocol.js";

async function enabledConfig() {
  return await loadAdvisorConfig({
    env: {
      MONO_AGENT_ADVISOR_ENABLED: "true",
      MONO_AGENT_ADVISOR_MODEL: "claude:claude-opus-test",
      MONO_AGENT_ADVISOR_EFFORT: "xhigh",
    },
    json: {},
  });
}

describe("review_iteration protocol", () => {
  it("strictly rejects unknown input keys", async () => {
    const schema = createReviewIterationInputSchema(await enabledConfig());
    expect(schema.safeParse({
      session_key: "session",
      intent: "review it",
      patch: "diff --git a/a b/a",
      surprise: true,
    }).success).toBe(false);
  });

  it("bounds metadata keys, values, arrays, and entry count", async () => {
    const schema = createReviewIterationInputSchema(await enabledConfig());
    const base = { session_key: "session", intent: "review it", patch: "patch" };
    expect(schema.safeParse({ ...base, metadata: { "bad key": "value" } }).success).toBe(false);
    expect(schema.safeParse({ ...base, metadata: { ok: "x".repeat(2_049) } }).success).toBe(false);
    expect(schema.safeParse({ ...base, metadata: { ok: Array.from({ length: 17 }, () => "value") } }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      metadata: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, index])),
    }).success).toBe(false);
  });

  it("enforces the serialized payload ceiling in addition to field bounds", async () => {
    const config = await loadAdvisorConfig({
      env: {
        MONO_AGENT_ADVISOR_ENABLED: "true",
        MONO_AGENT_ADVISOR_MODEL: "claude:claude-opus-test",
        MONO_AGENT_ADVISOR_EFFORT: "high",
        MONO_AGENT_ADVISOR_MAX_REQUEST_BYTES: "1024",
      },
      json: {},
    });
    const parsed = createReviewIterationInputSchema(config).safeParse({
      session_key: "session",
      intent: "review",
      patch: "x".repeat(1_000),
    });
    expect(parsed.success).toBe(false);
  });

  it("normalizes the bounded key and derives the exact continuity id", () => {
    expect(normalizeAdvisorSessionKey("  session\t one  ")).toBe("session one");
    expect(continuityIdForSessionKey("  session\t one  ")).toBe(
      "advisor:2ceea2a90af451a0622c2c887249922c",
    );
    expect(() => normalizeAdvisorSessionKey("x".repeat(513))).toThrow("at most 512 characters");
    expect(() => normalizeAdvisorSessionKey("\u0000")).toThrow("control characters");
  });

  it("bounds the duplicated text and structured response by bytes", async () => {
    const config = await enabledConfig();
    const result = advisorToolResult(advisorSuccess({
      continuityId: continuityIdForSessionKey("session"),
      model: config.model ?? "missing",
      effort: config.effort ?? "none",
      review: "🙂".repeat(100_000),
    }), { maxOutputChars: 64_000, maxResponseBytes: 16_384 });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16_384);
    expect(result.structuredContent).toMatchObject({ code: "ok", status: "succeeded", truncated: true });
    expect(createAdvisorOutputSchema(config).safeParse(result.structuredContent).success).toBe(true);
  });
});

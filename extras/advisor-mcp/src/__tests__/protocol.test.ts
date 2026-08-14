import { describe, expect, it } from "vitest";

import { loadAdvisorConfig } from "../config.js";
import {
  advisorFailure,
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
    const privateKey = `private-${"x".repeat(10_000)}`;
    const parsed = schema.safeParse({
      session_key: "session",
      intent: "review it",
      patch: "diff --git a/a b/a",
      [privateKey]: true,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("unknown argument");
    expect(JSON.stringify(parsed.error?.issues)).not.toContain(privateKey);
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
      "advisor:5d94536cb4a4eddcc3232fe6df79391b",
    );
    expect(continuityIdForSessionKey("session one", "one")).not.toBe(
      continuityIdForSessionKey("session one", "two"),
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

  it("keeps UTF-16 character bounds valid when truncating astral text", async () => {
    const config = await enabledConfig();
    const result = advisorToolResult(advisorSuccess({
      continuityId: continuityIdForSessionKey("session"),
      model: config.model ?? "missing",
      effort: config.effort ?? "none",
      review: "🙂".repeat(2_000),
    }), { maxOutputChars: 1_024, maxResponseBytes: 1_048_576 });
    expect(String(result.structuredContent.review).length).toBeLessThanOrEqual(1_024);
    expect(createAdvisorOutputSchema({ ...config, maxOutputChars: 1_024 }).safeParse(result.structuredContent).success).toBe(true);
  });

  it("fails after sanitization empties output and redacts an unterminated private key", async () => {
    const config = await enabledConfig();
    const base = {
      continuityId: continuityIdForSessionKey("session"),
      model: config.model ?? "missing",
      effort: config.effort ?? "none",
    } as const;
    const empty = advisorToolResult(advisorSuccess({ ...base, review: "\u0001\u0002" }), config);
    expect(empty.isError).toBe(true);
    expect(empty.structuredContent).toMatchObject({ code: "advisor_empty_output", status: "failed" });

    const privateKey = advisorToolResult(advisorSuccess({
      ...base,
      review: "-----BEGIN PRIVATE KEY-----\nprivate-key-material-without-an-end-marker",
    }), config);
    expect(JSON.stringify(privateKey)).toContain("[REDACTED]");
    expect(JSON.stringify(privateKey)).not.toContain("private-key-material");
  });

  it("bounds and redacts exported failure messages without changing their code", async () => {
    const config = await enabledConfig();
    const result = advisorToolResult(advisorFailure({
      code: "advisor_run_failed",
      message: `Authorization: Bearer private-token /Users/example/private/repo ${"x".repeat(2_000)}`,
      continuityId: continuityIdForSessionKey("session"),
      model: config.model ?? "missing",
      effort: config.effort ?? "none",
    }), config);
    const serialized = JSON.stringify(result);
    expect(result.structuredContent).toMatchObject({ code: "advisor_run_failed" });
    expect(String((result.structuredContent.error as { message: string }).message).length).toBeLessThanOrEqual(512);
    expect(serialized).not.toMatch(/private-token|\/Users\/example/u);
  });
});

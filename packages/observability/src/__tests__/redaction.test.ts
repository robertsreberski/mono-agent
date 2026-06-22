import { describe, expect, it } from "vitest";

import { redactJsonValue, truncateString } from "../redaction.js";

describe("redactJsonValue", () => {
  it("redacts sensitive keys", () => {
    expect(redactJsonValue({ apiKey: "fixture", token: "fixture", nested: { secret: "x" } })).toEqual({
      apiKey: "[redacted]",
      token: "[redacted]",
      nested: { secret: "[redacted]" },
    });
  });

  it("keeps numeric values under sensitive-looking keys (token COUNTS, not secrets)", () => {
    // `*_tokens` match /token/ but are usage counts we need for cost observability;
    // secrets are always strings, so only the string token is redacted.
    expect(
      redactJsonValue({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 8, cost_usd: 0.5, token: "secret-abc" }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 8,
      cost_usd: 0.5,
      token: "[redacted]",
    });
  });

  it("marks circular references as [circular]", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    expect(redactJsonValue(value)).toEqual({ name: "root", self: "[circular]" });
  });

  it("caps recursion at depth 12 with [max-depth]", () => {
    // Build a chain 0..13 deep so the value AT depth 12 is replaced.
    let leaf: Record<string, unknown> = { end: "deep" };
    for (let i = 0; i < 13; i += 1) {
      leaf = { child: leaf };
    }
    const redacted = redactJsonValue(leaf) as Record<string, unknown>;
    // Walk down 12 levels of `child`; the 12th nested value is replaced by the sentinel.
    let cursor: unknown = redacted;
    for (let i = 0; i < 12; i += 1) {
      cursor = (cursor as Record<string, unknown>).child;
    }
    expect(cursor).toBe("[max-depth]");
  });
});

describe("truncateString", () => {
  it("returns the value unchanged at the maxStringBytes boundary", () => {
    const value = "a".repeat(64);
    expect(truncateString(value, 64)).toBe(value);
  });

  it("truncates one byte past the boundary with the UTF-8 byte count", () => {
    const value = "a".repeat(65);
    // Prior implementation used Buffer.byteLength(value, "utf8") === 65.
    expect(truncateString(value, 64)).toBe(`${value.slice(0, 64)}…[truncated 1 bytes]`);
  });

  it("keeps the retained text within the byte cap for multi-byte input (no split code points)", () => {
    // "😀" is 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes.
    const emoji = "😀".repeat(20); // 80 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(emoji).length).toBe(80);

    const out = truncateString(emoji, 64);
    const head = out.split("…[truncated")[0]!;
    // The kept head must not exceed the cap...
    expect(encoder.encode(head).length).toBeLessThanOrEqual(64);
    // ...and must remain whole emoji (4-byte boundary), not a split code point.
    expect(head).toBe("😀".repeat(16)); // 16 * 4 = 64 bytes
    expect(out).toBe(`${"😀".repeat(16)}…[truncated 16 bytes]`);
  });

  it("cuts CJK input on a UTF-8 boundary at or below the byte cap", () => {
    // Each CJK char is 3 UTF-8 bytes; 64 is not a multiple of 3.
    const cjk = "観".repeat(30); // 90 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(cjk).length).toBe(90);

    const out = truncateString(cjk, 64);
    const head = out.split("…[truncated")[0]!;
    // 21 chars = 63 bytes is the largest whole-character cut at or below 64.
    expect(encoder.encode(head).length).toBe(63);
    expect(encoder.encode(head).length).toBeLessThanOrEqual(64);
    expect(out).toBe(`${"観".repeat(21)}…[truncated 27 bytes]`);
  });
});

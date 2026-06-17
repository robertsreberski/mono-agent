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

  it("uses UTF-8 byte length (not code-unit length) for multi-byte input", () => {
    // "😀" is 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes.
    const emoji = "😀".repeat(20); // 80 UTF-8 bytes
    const expectedByteCount = new TextEncoder().encode(emoji).length;
    expect(expectedByteCount).toBe(80);
    // Parity with the prior Buffer.byteLength UTF-8 count.
    expect(Buffer.byteLength(emoji, "utf8")).toBe(expectedByteCount);
    expect(truncateString(emoji, 64)).toBe(`${emoji.slice(0, 64)}…[truncated ${expectedByteCount - 64} bytes]`);
  });

  it("matches prior Buffer-based byte count on CJK input", () => {
    // Each CJK char is 3 UTF-8 bytes.
    const cjk = "観".repeat(30); // 90 UTF-8 bytes
    const expectedByteCount = new TextEncoder().encode(cjk).length;
    expect(expectedByteCount).toBe(90);
    expect(Buffer.byteLength(cjk, "utf8")).toBe(expectedByteCount);
    expect(truncateString(cjk, 64)).toBe(`${cjk.slice(0, 64)}…[truncated ${expectedByteCount - 64} bytes]`);
  });
});

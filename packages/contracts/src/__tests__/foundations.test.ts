import { describe, expect, it } from "vitest";

import {
  BufferedMessageStream,
  CodedError,
  normalizeTrailing,
  splitTextByCodePoints,
} from "../index.js";
import { buildStreamingTailPreview } from "../stream-text.js";

describe("CodedError", () => {
  it("preserves subclass name and echoes the code into details", () => {
    class WidgetError extends CodedError<"broken" | "missing"> {}
    const error = new WidgetError("broken", "It broke.", { id: 7 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WidgetError");
    expect(error.code).toBe("broken");
    expect(error.details).toEqual({ id: 7, code: "broken" });
  });
});

describe("stream-text helpers", () => {
  it("splits by code points without cutting multi-byte chars", () => {
    expect(splitTextByCodePoints("hello", 10)).toEqual(["hello"]);
    expect(splitTextByCodePoints("abcd", 2)).toEqual(["ab", "cd"]);
    // emoji is a single code point unit via Array.from
    expect(splitTextByCodePoints("😀😀😀", 1)).toEqual(["😀", "😀", "😀"]);
    expect(() => splitTextByCodePoints("x", 0)).toThrow(RangeError);
  });

  it("builds a bounded tail preview with a prefix", () => {
    expect(buildStreamingTailPreview("short", 10)).toBe("short");
    const preview = buildStreamingTailPreview("abcdefghij", 5, "...\n");
    expect(preview.startsWith("...\n")).toBe(true);
    expect(Array.from(preview).length).toBeLessThanOrEqual(5);
  });

  it("normalizes trailing whitespace with a fallback", () => {
    expect(normalizeTrailing("hi  \n", "fallback")).toBe("hi");
    expect(normalizeTrailing("   ", "fallback")).toBe("fallback");
  });
});

describe("BufferedMessageStream", () => {
  it("accumulates appends, supports replace/finish, and exposes trimmed text", async () => {
    const stream = new BufferedMessageStream();
    await stream.append("a");
    await stream.append("b ");
    expect(stream.text).toBe("ab");
    await stream.replace("final  ");
    expect(stream.text).toBe("final");
    await stream.finish();
    expect(stream.text).toBe("final");
  });

  it("uses finalText on finish and throws via onClosed after finish", async () => {
    const stream = new BufferedMessageStream({
      onClosed: () => new Error("closed!"),
    });
    await stream.finish("done");
    expect(stream.text).toBe("done");
    await expect(stream.append("x")).rejects.toThrow("closed!");
    // finishing twice is a no-op
    await stream.finish("ignored");
    expect(stream.text).toBe("done");
  });
});

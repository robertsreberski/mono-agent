import { describe, expect, it } from "vitest";

import { splitTextForChat } from "../index.js";

/** Every non-whitespace character survives, in order. Boundary whitespace may not. */
function expectContentPreserved(chunks: readonly string[], text: string): void {
  const strip = (value: string): string => value.replace(/\s+/gu, "");
  expect(chunks.map(strip).join("")).toBe(strip(text));
}

function expectWellFormed(chunks: readonly string[], maxChars: number): void {
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(Array.from(chunk).length).toBeLessThanOrEqual(maxChars);
    expect(chunk.trim().length).toBeGreaterThan(0);
  }
}

describe("splitTextForChat", () => {
  it("returns the text by identity when it fits", () => {
    const text = "short enough";
    expect(splitTextForChat(text, 100)).toEqual([text]);
    expect(splitTextForChat(text, Array.from(text).length)).toEqual([text]);
  });

  it("rejects a non-positive or fractional budget, like splitTextByCodePoints", () => {
    expect(() => splitTextForChat("x", 0)).toThrow(RangeError);
    expect(() => splitTextForChat("x", -1)).toThrow(RangeError);
    expect(() => splitTextForChat("x", 1.5)).toThrow(RangeError);
  });

  it("prefers a paragraph break over a later line break", () => {
    // The blank line at 20 and a plain newline at 34 are both inside the window.
    const text = `${"a".repeat(20)}\n\n${"b".repeat(13)}\n${"c".repeat(30)}`;
    const chunks = splitTextForChat(text, 40);
    expect(chunks[0]).toBe("a".repeat(20));
    expect(chunks[1]).toBe(`${"b".repeat(13)}\n${"c".repeat(30)}`.slice(0, 40));
    expectContentPreserved(chunks, text);
    expectWellFormed(chunks, 40);
  });

  it("falls back to a line break when there is no paragraph break", () => {
    const text = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    const chunks = splitTextForChat(text, 40);
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
    expectContentPreserved(chunks, text);
  });

  it("falls back to a space when there is no newline", () => {
    const text = `${"a".repeat(30)} ${"b".repeat(30)}`;
    const chunks = splitTextForChat(text, 40);
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
    expectContentPreserved(chunks, text);
  });

  it("hard-cuts a blob with no boundary in the searched tail", () => {
    const text = "a".repeat(100);
    const chunks = splitTextForChat(text, 40);
    expect(chunks).toEqual(["a".repeat(40), "a".repeat(40), "a".repeat(20)]);
  });

  it("ignores a boundary that sits too early to be worth taking", () => {
    // The only space is at index 2 — taking it would emit a 2-char chunk and
    // leave the rest to be hard-cut anyway, so the blind cut is preferred.
    const text = `ab ${"c".repeat(97)}`;
    const chunks = splitTextForChat(text, 40);
    expect(chunks[0]).toBe(`ab ${"c".repeat(37)}`);
    expectWellFormed(chunks, 40);
  });

  it("never cuts a surrogate pair in half", () => {
    const text = "😀".repeat(50);
    const chunks = splitTextForChat(text, 10);
    expect(chunks).toEqual(Array.from({ length: 5 }, () => "😀".repeat(10)));
    expect(chunks.join("")).toBe(text);
  });

  it("keeps the indentation of the line after a break", () => {
    const text = `${"a".repeat(30)}\n    indented code line`;
    const chunks = splitTextForChat(text, 35);
    expect(chunks[1]).toBe("    indented code line");
  });

  it("collapses a run of newlines at the boundary rather than leading with them", () => {
    const text = `${"a".repeat(30)}\n\n\n\n${"b".repeat(30)}`;
    const chunks = splitTextForChat(text, 40);
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("emits no whitespace-only chunk even when the text ends in blank lines", () => {
    const text = `${"a".repeat(40)}\n\n\n`;
    const chunks = splitTextForChat(text, 40);
    expectWellFormed(chunks, 40);
    expectContentPreserved(chunks, text);
  });

  it("returns whitespace-only input unchanged rather than nothing", () => {
    expect(splitTextForChat("   \n\n   ", 4)).toEqual(["   \n\n   "]);
  });

  it("holds its invariants across a realistic markdown answer", () => {
    const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(6);
    const text = [
      "## Heading",
      paragraph,
      "- bullet one",
      "- bullet two",
      "```js",
      "const x = 1;",
      "```",
      paragraph,
    ].join("\n\n");
    for (const maxChars of [32, 64, 100, 250]) {
      const chunks = splitTextForChat(text, maxChars);
      expectWellFormed(chunks, maxChars);
      expectContentPreserved(chunks, text);
    }
  });
});

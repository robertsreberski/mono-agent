import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { splitForMessenger, stripMarkdownForMessenger, verifyMessengerSignature } from "../text.js";

describe("verifyMessengerSignature", () => {
  const secret = "app-secret";
  const body = Buffer.from(JSON.stringify({ object: "page", entry: [] }), "utf8");
  const valid = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a matching sha256 signature", () => {
    expect(verifyMessengerSignature(body, valid, secret)).toBe(true);
    expect(verifyMessengerSignature(body, valid.toUpperCase().replace("SHA256=", "sha256="), secret)).toBe(true);
  });

  it("rejects missing, malformed, or mismatched signatures", () => {
    expect(verifyMessengerSignature(body, undefined, secret)).toBe(false);
    expect(verifyMessengerSignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifyMessengerSignature(body, `sha256=${"0".repeat(64)}`, secret)).toBe(false);
    expect(verifyMessengerSignature(body, "sha256=short", secret)).toBe(false);
    expect(verifyMessengerSignature(body, valid, "other-secret")).toBe(false);
    expect(verifyMessengerSignature(Buffer.alloc(0), valid, secret)).toBe(false);
    expect(verifyMessengerSignature(body, valid, "")).toBe(false);
  });
});

describe("stripMarkdownForMessenger", () => {
  it("flattens common Markdown into plain text", () => {
    const input = [
      "# Title",
      "Some **bold** and _italic_ text with `code`.",
      "- item one",
      "* item two",
      "[docs](https://example.com/docs)",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(stripMarkdownForMessenger(input)).toBe([
      "Title",
      "Some bold and italic text with code.",
      "• item one",
      "• item two",
      "docs (https://example.com/docs)",
      "const x = 1;",
    ].join("\n"));
  });

  it("leaves underscores inside words and empty input alone", () => {
    expect(stripMarkdownForMessenger("snake_case_name stays")).toBe("snake_case_name stays");
    expect(stripMarkdownForMessenger("")).toBe("");
  });
});

describe("splitForMessenger", () => {
  it("returns short text unchanged", () => {
    expect(splitForMessenger("hello", 100)).toEqual(["hello"]);
  });

  it("prefers paragraph, then line, then word boundaries", () => {
    const paragraphs = `${"a".repeat(40)}\n\n${"b".repeat(40)}\n${"c".repeat(40)} ${"d".repeat(20)}`;
    const chunks = splitForMessenger(paragraphs, 60);
    expect(chunks[0]).toBe("a".repeat(40));
    expect(chunks[1]).toBe("b".repeat(40));
    expect(chunks[2]).toBe("c".repeat(40));
    expect(chunks[3]).toBe("d".repeat(20));
    expect(chunks.every((chunk) => Array.from(chunk).length <= 60)).toBe(true);
  });

  it("hard-cuts a single long token without splitting surrogate pairs", () => {
    const text = "😀".repeat(70);
    const chunks = splitForMessenger(text, 32);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 32)).toBe(true);
  });

  it("rejects an unusable limit", () => {
    expect(() => splitForMessenger("x", 8)).toThrow(RangeError);
  });
});

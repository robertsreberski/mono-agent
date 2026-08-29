import { describe, expect, it } from "vitest";
import {
  MIN_SEARCH_QUERY,
  SEARCH_HIGHLIGHT_CLOSE,
  SEARCH_HIGHLIGHT_OPEN,
  highlightSegments,
  highlightTitle,
} from "./thread-search";

describe("search highlight contract", () => {
  // The webapp is its own workspace and cannot import `@mono-agent/web`, so the
  // sentinels and the query floor are duplicated. `packages/web/src/__tests__`
  // pins the same literals on the server side; changing one alone breaks every
  // highlight in the browser with every gate still green.
  it("pins the codepoints the service wraps matches in", () => {
    expect(SEARCH_HIGHLIGHT_OPEN).toBe("\u0002");
    expect(SEARCH_HIGHLIGHT_CLOSE).toBe("\u0003");
    expect(MIN_SEARCH_QUERY).toBe(2);
  });
});

describe("highlightSegments", () => {
  const wrap = (text: string) => `${SEARCH_HIGHLIGHT_OPEN}${text}${SEARCH_HIGHLIGHT_CLOSE}`;

  it("splits a snippet into plain and matched runs", () => {
    expect(highlightSegments(`we saw ${wrap("needle")} today`)).toEqual([
      { text: "we saw ", match: false },
      { text: "needle", match: true },
      { text: " today", match: false },
    ]);
  });

  it("handles a match at each end without emitting empty segments", () => {
    expect(highlightSegments(`${wrap("a")}${wrap("b")}`)).toEqual([
      { text: "a", match: true },
      { text: "b", match: true },
    ]);
  });

  it("returns markup-free text, so message HTML can never be injected", () => {
    const segments = highlightSegments(`<img src=x onerror=1> ${wrap("needle")}`);

    expect(segments[0]).toEqual({ text: "<img src=x onerror=1> ", match: false });
    expect(segments.every((segment) => typeof segment.text === "string")).toBe(true);
  });

  it("degrades an unbalanced marker to plain text instead of leaking a control character", () => {
    const segments = highlightSegments(`stray ${SEARCH_HIGHLIGHT_OPEN} control ${wrap("needle")}`);

    expect(segments.some((segment) => segment.text.includes(SEARCH_HIGHLIGHT_OPEN))).toBe(false);
    expect(segments.some((segment) => segment.text.includes(SEARCH_HIGHLIGHT_CLOSE))).toBe(false);
  });

  it("passes an unmarked snippet through as one plain run", () => {
    expect(highlightSegments("nothing marked here"))
      .toEqual([{ text: "nothing marked here", match: false }]);
  });
});

describe("highlightTitle", () => {
  it("marks the first case-insensitive occurrence", () => {
    expect(highlightTitle("Quarterly planning", "quarter")).toEqual([
      { text: "Quarter", match: true },
      { text: "ly planning", match: false },
    ]);
  });

  it("leaves a title alone when the term is absent or empty", () => {
    expect(highlightTitle("Quarterly planning", "budget"))
      .toEqual([{ text: "Quarterly planning", match: false }]);
    expect(highlightTitle("Quarterly planning", "   "))
      .toEqual([{ text: "Quarterly planning", match: false }]);
  });
});

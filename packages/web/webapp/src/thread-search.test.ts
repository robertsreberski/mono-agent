import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { writeDataModeSetting } from "./data-mode";
import {
  LEAN_SEARCH_DEBOUNCE_MS,
  MIN_SEARCH_QUERY,
  SEARCH_DEBOUNCE_MS,
  SEARCH_HIGHLIGHT_CLOSE,
  SEARCH_HIGHLIGHT_OPEN,
  highlightSegments,
  highlightTitle,
  searchDebounceMs,
  useThreadSearch,
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

describe("the search debounce", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("waits longer between keystrokes on a lean link", () => {
    // Every settled keystroke is a whole-conversation search on the server. On
    // a metered link the console waits a little longer for the operator to stop
    // typing rather than paying for the prefixes on the way to the word.
    expect(searchDebounceMs()).toBe(SEARCH_DEBOUNCE_MS);
    writeDataModeSetting("lean");
    expect(searchDebounceMs()).toBe(LEAN_SEARCH_DEBOUNCE_MS);
    expect(LEAN_SEARCH_DEBOUNCE_MS).toBeGreaterThan(SEARCH_DEBOUNCE_MS);
  });

  it("takes the new wait while the operator is still typing", async () => {
    // The wait is re-read inside the timer chain, so a switch made mid-search
    // extends it -- without re-running the effect, whose cleanup aborts.
    vi.useFakeTimers();
    const search = vi.spyOn(api, "searchThreads").mockResolvedValue({ hits: [], truncated: false });
    try {
      renderHook(() => useThreadSearch("alpha", "needle"));
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50); });
      expect(search).not.toHaveBeenCalled();

      await act(async () => { writeDataModeSetting("lean"); });
      // The full-mode wait would have fired at its own 200 ms. It woke there,
      // found the wait is the lean one now, and went back to sleep for the
      // difference -- so nothing goes out until the lean wait is up.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LEAN_SEARCH_DEBOUNCE_MS - (SEARCH_DEBOUNCE_MS - 50) - 1,
        );
      });
      expect(search).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      search.mockRestore();
    }
  });

  it("never abandons a search already on the wire because the link was reclassified", async () => {
    // `auto` follows the browser's own reading of the connection, which can
    // change on its own while a request is out. Re-running the effect for it
    // would abort that request -- cancelling a search the operator is waiting
    // on, to issue the identical one again.
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const search = vi.spyOn(api, "searchThreads").mockImplementation(async (_source, _query, signal) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise(() => undefined);
    });
    try {
      renderHook(() => useThreadSearch("alpha", "needle"));
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1); });
      expect(search).toHaveBeenCalledTimes(1);

      await act(async () => { writeDataModeSetting("lean"); });
      await act(async () => { await vi.advanceTimersByTimeAsync(LEAN_SEARCH_DEBOUNCE_MS * 2); });

      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      search.mockRestore();
    }
  });
});

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ThreadSearchHit } from "./types";

/**
 * Mirrors the server's `WEB_SEARCH_HIGHLIGHT_*` sentinels. The webapp is its own
 * workspace and cannot import `@mono-agent/web`, so both sides pin these exact
 * codepoints in their tests: changing one alone would break every highlight
 * with all gates green.
 */
export const SEARCH_HIGHLIGHT_OPEN = "\u0002";
export const SEARCH_HIGHLIGHT_CLOSE = "\u0003";

/** Below this a query matches almost everything; mirrors the server's floor. */
export const MIN_SEARCH_QUERY = 2;
const SEARCH_DEBOUNCE_MS = 200;

export interface HighlightSegment {
  readonly text: string;
  readonly match: boolean;
}

/** Belt and braces: the service already strips these from the indexed body. */
const withoutSentinels = (text: string): string =>
  text.split(SEARCH_HIGHLIGHT_OPEN).join("").split(SEARCH_HIGHLIGHT_CLOSE).join("");

const plain = (text: string): readonly HighlightSegment[] =>
  text.length === 0 ? [] : [{ text: withoutSentinels(text), match: false }];

/**
 * Split a server snippet into plain and matched runs so the caller can render
 * `<mark>` as React text nodes. Never returns markup, so a conversation that
 * happens to contain HTML cannot inject any, and an unbalanced marker degrades
 * to unhighlighted text rather than putting a control character in the DOM.
 */
export function highlightSegments(snippet: string): readonly HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (;;) {
    const open = snippet.indexOf(SEARCH_HIGHLIGHT_OPEN, cursor);
    if (open < 0) break;
    const close = snippet.indexOf(SEARCH_HIGHLIGHT_CLOSE, open + 1);
    if (close < 0) break;
    segments.push(...plain(snippet.slice(cursor, open)));
    segments.push({ text: withoutSentinels(snippet.slice(open + 1, close)), match: true });
    cursor = close + 1;
  }
  segments.push(...plain(snippet.slice(cursor)));
  return segments;
}

/**
 * Highlight a title the server did not snippet, so a title-only hit reads the
 * same as a message hit. Case-insensitive on the first occurrence only, which
 * is all a one-line title needs.
 */
export function highlightTitle(title: string, query: string): readonly HighlightSegment[] {
  const term = query.trim();
  if (term.length === 0) return [{ text: title, match: false }];
  const at = title.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (at < 0) return [{ text: title, match: false }];
  return [
    ...(at > 0 ? [{ text: title.slice(0, at), match: false }] : []),
    { text: title.slice(at, at + term.length), match: true },
    ...(at + term.length < title.length
      ? [{ text: title.slice(at + term.length), match: false }]
      : []),
  ];
}

export type ThreadSearchStatus = "idle" | "loading" | "ready" | "error";

export interface ThreadSearchState {
  readonly hits: readonly ThreadSearchHit[];
  readonly status: ThreadSearchStatus;
  readonly truncated: boolean;
}

const IDLE: ThreadSearchState = { hits: [], status: "idle", truncated: false };

/**
 * Debounced server-side conversation search.
 *
 * Results are kept while the next request is in flight so the list does not
 * blank out between keystrokes, and each new query aborts the previous request
 * so a slow early response cannot overwrite a newer one.
 */
export function useThreadSearch(
  sourceId: string | null,
  query: string,
): ThreadSearchState {
  const [state, setState] = useState<ThreadSearchState>(IDLE);
  // Read inside the effect only, so a re-render caused by the result cannot
  // retrigger the request.
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const trimmed = query.trim();
    if (sourceId === null || trimmed.length < MIN_SEARCH_QUERY) {
      setState(IDLE);
      return;
    }
    setState({ ...latest.current, status: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.searchThreads(sourceId, trimmed, controller.signal)
        .then((page) => {
          setState({ hits: page.hits, status: "ready", truncated: page.truncated });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          setState({ hits: [], status: "error", truncated: false });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, sourceId]);

  return state;
}

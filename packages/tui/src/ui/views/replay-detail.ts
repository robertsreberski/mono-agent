import { deriveRunSource } from "@mono-agent/observability";

import type { ReplayRunDetail, ReplayTimelineItem } from "../../data/replay.js";
import { categoryStyle } from "../components/event-list.js";
import { extractUsage, formatClock, formatDurationMs, formatTokens, formatUsd } from "../format.js";
import { styles } from "../theme.js";

/** Canonical (not alphabetical) filter-category order matching the t/o/m/y/e keymap. */
export const CATEGORY_ORDER: readonly string[] = ["thinking", "tool", "message", "runtime", "error"];

/** Single-key toggles for the detail-mode category filter (see task brief's keybinding map). */
export const CATEGORY_KEYS: Readonly<Record<string, string>> = {
  t: "thinking",
  o: "tool",
  m: "message",
  y: "runtime",
  e: "error",
};

export const KEY_HINT =
  "↑↓/pgup/pgdn/g/G step · [ ] turn · t/o/m/y/e/a filter · / search · n/N match · enter expand · esc back";

const PAYLOAD_MAX_LINES_COLLAPSED = 12;
const PAYLOAD_MAX_LINES_EXPANDED = 40;

/** Headline text (multi-line): run id/source, conversation/status, clock/model/effort, usage, errors, turn stats. */
export function buildHeadline(replay: ReplayRunDetail): string {
  const summary = replay.detail.summary;
  const resolvedSource = summary.source ?? deriveRunSource(summary.conversationId);
  const badge = `[${resolvedSource}]${summary.sourceDetail === undefined ? "" : ` · ${summary.sourceDetail}`}`;
  const lines = [
    `${styles.bold(styles.accent(`run ${summary.runId}`))} ${styles.muted(badge)}`,
    styles.muted(`${summary.conversationId} · ${summary.status}`),
  ];

  const model = summary.model ?? replay.runConfig?.model;
  const effort = replay.effort;
  // Gate the "(override)" marker on the run_config's own `overridden` flag
  // alone -- NOT on whether the displayed model/effort happened to come from
  // the run_config fallback. A newer artifact carries model/effort directly
  // on `summary` (no fallback needed) but can still be an overridden run, and
  // should still show the marker.
  const overridden = replay.runConfig?.overridden === true;

  const line3: string[] = [];
  const clock = formatClock(summary.startedAt);
  if (clock.length > 0) {
    line3.push(clock);
  }
  line3.push(formatDurationMs(summary.durationMs), `${summary.eventCount} events`);
  if (model !== undefined) {
    line3.push(`${model}${overridden ? " (override)" : ""}`);
  }
  if (effort !== undefined) {
    line3.push(`effort:${effort}${overridden ? " (override)" : ""}`);
  }
  lines.push(styles.muted(line3.join(" · ")));

  const usage = usageLine(summary.usage, summary.cost);
  if (usage !== undefined) {
    lines.push(styles.muted(usage));
  }
  if (summary.error !== undefined) {
    lines.push(styles.error(`error: ${summary.error}`));
  }
  for (const attempt of summary.failoverHistory ?? []) {
    lines.push(styles.warning(`failover: ${attempt.model} → ${attempt.failureKind ?? "?"}`));
  }
  if (replay.turns.length > 0) {
    const totalThinkingChars = replay.turns.reduce((sum, turn) => sum + turn.thinkingChars, 0);
    lines.push(styles.muted(`turns: ${replay.turns.length} · thinking: ${formatTokens(totalThinkingChars)}`));
  }
  return lines.join("\n");
}

export interface StatusLineState {
  /** 1-based rank among VISIBLE (post-filter) items; undefined when nothing is visible/selected. */
  readonly ordinal: number | undefined;
  readonly visibleCount: number;
  readonly turnIndex: number | undefined;
  readonly turnCount: number;
  readonly categoryFilter: ReadonlySet<string>;
  readonly searchInputOpen: boolean;
  readonly searchInputBuffer: string;
  readonly committedSearch: string | undefined;
  readonly matchCount: number;
}

/** Filter/status line + a dim key-hint line underneath it. */
export function buildStatusLine(state: StatusLineState): string {
  const segments: string[] = [];
  if (state.ordinal !== undefined) {
    segments.push(`event ${state.ordinal}/${state.visibleCount}`);
  }
  if (state.turnIndex !== undefined && state.turnCount > 0) {
    segments.push(`turn ${state.turnIndex + 1}/${state.turnCount}`);
  }
  if (state.categoryFilter.size > 0) {
    const active = CATEGORY_ORDER.filter((category) => state.categoryFilter.has(category));
    const colored = active.map((category) => categoryStyle(category)(category));
    segments.push(`filters: ${colored.join(",")}`);
  }
  if (state.searchInputOpen) {
    segments.push(`search: "${state.searchInputBuffer}█"`);
  } else if (state.committedSearch !== undefined) {
    segments.push(`search: "${state.committedSearch}" (${state.matchCount} matches)`);
  }
  return `${styles.muted(segments.join(" · "))}\n${styles.dim(KEY_HINT)}`;
}

/** Selected-event payload pane: header (index/label/timing/group span) + pretty-printed payload body. Empty string hides the pane. */
export function buildPayloadPane(item: ReplayTimelineItem | undefined, expanded: boolean): string {
  if (item === undefined) {
    return "";
  }
  let header = `#${item.index} ${item.label}`;
  const timing: string[] = [];
  if (item.timestamp !== undefined) {
    timing.push(item.timestamp);
  }
  if (item.deltaMs !== undefined) {
    timing.push(`+${formatDurationMs(item.deltaMs)}`);
  }
  if (timing.length > 0) {
    header += ` · ${timing.join(" · ")}`;
  }
  if (item.sourceEventCount > 1) {
    header += ` · events #${item.sourceEventStartIndex}–#${item.sourceEventEndIndex}`;
  }
  if (item.category === "thinking" && item.contentChars !== undefined) {
    header += ` ${thinkingStatsSuffix(item.contentChars, item.timestamp, item.endTimestamp)}`;
  }

  const maxLines = expanded ? PAYLOAD_MAX_LINES_EXPANDED : PAYLOAD_MAX_LINES_COLLAPSED;
  const allLines = formatPayloadRaw(item.payload).split("\n");
  const shown = allLines.slice(0, maxLines);
  const remaining = allLines.length - shown.length;
  const body = remaining > 0 ? [...shown, styles.dim(`… (+${remaining} more lines)`)] : shown;
  return [header, "", ...body].join("\n");
}

function thinkingStatsSuffix(contentChars: number, timestamp: string | undefined, endTimestamp: string | undefined): string {
  const chars = formatTokens(contentChars);
  if (timestamp === undefined || endTimestamp === undefined) {
    return `(${chars})`;
  }
  const start = Date.parse(timestamp);
  const end = Date.parse(endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return `(${chars})`;
  }
  return `(${chars} · ${formatDurationMs(Math.max(0, end - start))})`;
}

function formatPayloadRaw(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    const json = JSON.stringify(payload, null, 2);
    return json ?? String(payload);
  } catch {
    return String(payload);
  }
}

function usageLine(usage: unknown, cost: unknown): string | undefined {
  const extracted = extractUsage(usage, cost);
  if (extracted === undefined) {
    return undefined;
  }
  return `tokens ↑${formatTokens(extracted.input ?? 0)} ↓${formatTokens(extracted.output ?? 0)}${
    extracted.usd === undefined ? "" : ` · ${formatUsd(extracted.usd)}`
  }`;
}

import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SessionToolHistoryEventMetadata } from "@mono-agent/agent-contracts";

import { formatDurationMs, lastLines, previewValue } from "../format.js";
import { styles } from "../theme.js";

export type ToolPanelState = "pending" | "success" | "error";

export interface ToolPanelOptions {
  /**
   * Render as a subagent's own call: indented under its parent panel and
   * without the leading blank line, so one delegation reads as one block
   * instead of a run of visually equal top-level calls.
   */
  readonly nested?: boolean;
}

/** Columns a nested panel is indented past its parent. */
const NEST_INDENT = 2;

/**
 * One tool call's lifecycle: pending (with live progress tail) → success/error
 * (with result preview + execution time). Border color tracks state.
 *
 * A panel can own nested panels: the `Agent` tool's panel holds the tool calls
 * its subagent made. Nesting is what keeps concurrent subagents readable —
 * their events interleave arbitrarily, so appending every child at the
 * transcript tail would shuffle five agents' work into one flat list.
 */
export class ToolPanel implements Component {
  readonly id: string;
  private readonly name: string;
  private readonly argsPreview: string;
  private readonly nested: boolean;
  private readonly children: ToolPanel[] = [];
  private state: ToolPanelState = "pending";
  private progressTail = "";
  private resultPreview = "";
  private executionMs: number | undefined;
  private truncated = false;
  private history: SessionToolHistoryEventMetadata | undefined;
  private expandedValue = false;

  constructor(
    id: string,
    name: string,
    args?: unknown,
    options?: ToolPanelOptions & { readonly history?: SessionToolHistoryEventMetadata },
  ) {
    this.id = id;
    this.name = name;
    this.argsPreview = previewValue(args, 240).replace(/\s+/gu, " ").trim();
    this.nested = options?.nested === true;
    this.history = options?.history;
  }

  /** Adopt one subagent tool call so it renders inside this panel. */
  addChild(panel: ToolPanel): void {
    this.children.push(panel);
  }

  setProgress(partialResult: unknown): void {
    this.progressTail = lastLines(previewValue(partialResult, 4_000), 10);
  }

  complete(input: {
    isError?: boolean;
    content?: unknown;
    executionMs?: number;
    truncated?: boolean;
    history?: SessionToolHistoryEventMetadata;
  }): void {
    this.history = input.history ?? this.history;
    this.state = input.isError === true || (
      this.history?.terminalState !== undefined && this.history.terminalState !== "success"
    ) ? "error" : "success";
    this.progressTail = "";
    this.resultPreview = previewValue(input.content, this.expandedValue ? 20_000 : 600);
    this.executionMs = input.executionMs;
    this.truncated = input.truncated === true;
  }

  getState(): ToolPanelState {
    return this.state;
  }

  setExpanded(expanded: boolean): void {
    this.expandedValue = expanded;
  }

  render(width: number): string[] {
    const stateStyle =
      this.state === "pending" ? styles.warning : this.state === "error" ? styles.error : styles.success;
    const bullet = this.state === "pending" ? "◐" : this.state === "error" ? "✗" : "✓";
    const timing = this.executionMs === undefined ? "" : styles.dim(` ${formatDurationMs(this.executionMs)}`);
    const indent = this.nested ? NEST_INDENT : 0;
    const header = new Text(
      `${stateStyle(`${bullet} ${styles.bold(this.name)}`)}${timing}${
        this.argsPreview.length > 0 ? ` ${styles.dim(this.argsPreview)}` : ""
      }`,
      1 + indent,
      0,
    );
    // A nested call belongs to the delegation above it; a blank line before each
    // one would break that block apart.
    const lines = this.nested ? [...header.render(width)] : ["", ...header.render(width)];
    const body = this.state === "pending" ? this.progressTail : this.resultPreview;
    if (body.length > 0) {
      const bodyText = new Text(styles.muted(body), 3 + indent, 0);
      lines.push(...bodyText.render(width));
    }
    if (this.truncated) {
      lines.push(
        ...new Text(
          styles.dim("(payload truncated for streaming; replay may also be bounded)"),
          3 + indent,
          0,
        ).render(width),
      );
    }
    const history = historySummary(this.history);
    if (history !== undefined) {
      lines.push(...new Text(styles.dim(history), 3 + indent, 0).render(width));
    }
    for (const child of this.children) {
      lines.push(...child.render(width));
    }
    return lines;
  }

  invalidate(): void {
    // Renders from plain state each frame; nothing cached.
  }
}

function historySummary(history: SessionToolHistoryEventMetadata | undefined): string | undefined {
  if (history === undefined) return undefined;
  if (history.persistence === "failed") {
    return `history not persisted${history.errorCode === undefined ? "" : ` (${history.errorCode})`}`;
  }
  const artifacts = history.artifactReferences ?? [];
  const unavailable = artifacts.filter((artifact) => !artifact.available).length;
  return [
    "history persisted",
    history.terminalState,
    history.sequence === undefined ? undefined : `seq ${String(history.sequence)}`,
    history.truncated === true ? "bounded" : undefined,
    artifacts.length === 0 ? undefined : `${String(artifacts.length)} artifact${artifacts.length === 1 ? "" : "s"}`,
    unavailable === 0 ? undefined : `${String(unavailable)} unavailable`,
  ].filter((part): part is string => part !== undefined).join(" · ");
}

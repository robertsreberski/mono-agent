import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { SelectItem, TUI } from "@earendil-works/pi-tui";
import type { RecordedRunListItem } from "@mono-agent/observability";

import { listReplayRuns, readReplayRun, type ReplayRunDetail } from "../../data/replay.js";
import { formatClock, formatDurationMs, formatTokens, formatUsd, previewValue } from "../format.js";
import { selectListTheme, styles } from "../theme.js";

export interface ReplayViewOptions {
  readonly tui: TUI;
}

/**
 * Recorded-run replay straight from the agent's artifact dir: run list →
 * full event timeline (thinking, tools, telemetry, failover) of any past turn
 * from ANY channel — richer than the live stream since nothing is dropped.
 */
export class ReplayView extends Container {
  readonly list: SelectList;
  private readonly options: ReplayViewOptions;
  private readonly header = new Text("", 1, 0);
  private readonly detail = new Container();
  private mode: "list" | "detail" = "list";
  private artifactDir: string | undefined;
  private runs: readonly RecordedRunListItem[] = [];

  constructor(options: ReplayViewOptions) {
    super();
    this.options = options;
    this.list = new SelectList([], 14, selectListTheme, { maxPrimaryColumnWidth: 46 });
    this.list.onSelect = (item: SelectItem) => {
      void this.openRun(item.value);
    };
    this.showList();
    // Self-initialize the empty-state header (no artifact dir until an
    // instance is selected).
    void this.refresh();
  }

  isInDetail(): boolean {
    return this.mode === "detail";
  }

  /** Esc in detail mode returns to the list; returns false when already listing. */
  back(): boolean {
    if (this.mode !== "detail") {
      return false;
    }
    this.showList();
    this.options.tui.requestRender();
    return true;
  }

  handleInput(data: string): void {
    if (this.mode === "list") {
      if (data === "r" || data === "R") {
        void this.refresh();
        return;
      }
      this.list.handleInput(data);
    }
  }

  setArtifactDir(artifactDir: string | undefined): void {
    this.artifactDir = artifactDir;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.artifactDir === undefined) {
      this.runs = [];
      this.header.setText(
        `${styles.bold("Run replay unavailable")}\n${styles.muted("The selected agent's manifest has no artifact dir.")}`,
      );
      this.syncListItems();
      this.showList();
      this.options.tui.requestRender();
      return;
    }
    try {
      const { runs, warnings } = await listReplayRuns(this.artifactDir);
      this.runs = runs;
      const warningText = warnings.length > 0 ? `\n${styles.warning(warnings[0] ?? "")}` : "";
      this.header.setText(
        `${styles.bold(`Recorded runs (${runs.length})`)} ${styles.dim("enter open · r refresh · esc back")}${warningText}`,
      );
    } catch (error) {
      this.runs = [];
      this.header.setText(styles.error(`Failed to read runs: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.syncListItems();
    if (this.mode === "list") {
      this.showList();
    }
    this.options.tui.requestRender();
  }

  private syncListItems(): void {
    const items = this.runs.map((run): SelectItem => {
      const status =
        run.status === "succeeded"
          ? styles.success("✓")
          : run.status === "cancelled" || run.status === "running"
            ? styles.warning("◌")
            : styles.error("✗");
      return {
        value: run.runId,
        label: `${status} ${formatClock(run.startedAt)} ${run.conversationId}`,
        description: `${formatDurationMs(run.durationMs)} · ${run.eventCount} events${
          run.failureKind === undefined ? "" : ` · ${run.failureKind}`
        }`,
      };
    });
    (this.list as unknown as { items: SelectItem[] }).items = items;
    this.list.setFilter("");
    this.list.setSelectedIndex(0);
    this.list.invalidate();
  }

  private showList(): void {
    this.mode = "list";
    this.clear();
    this.addChild(this.header);
    this.addChild(this.list);
  }

  private async openRun(runId: string): Promise<void> {
    if (this.artifactDir === undefined) {
      return;
    }
    const replay = await readReplayRun(this.artifactDir, runId);
    if (replay === undefined) {
      this.header.setText(styles.error(`Run ${runId} not found.`));
      this.options.tui.requestRender();
      return;
    }
    this.mode = "detail";
    this.clear();
    this.detail.clear();
    this.renderDetail(replay);
    this.addChild(this.detail);
    this.options.tui.requestRender();
  }

  private renderDetail(replay: ReplayRunDetail): void {
    const summary = replay.detail.summary;
    const headline = [
      styles.bold(styles.accent(`run ${summary.runId}`)),
      styles.muted(`${summary.conversationId} · ${summary.status}`),
      styles.muted(
        `${formatClock(summary.startedAt)} · ${formatDurationMs(summary.durationMs)} · ${summary.eventCount} events${
          summary.model === undefined ? "" : ` · ${summary.model}`
        }`,
      ),
    ];
    const usage = usageLine(summary.usage, summary.cost);
    if (usage !== undefined) {
      headline.push(styles.muted(usage));
    }
    if (summary.error !== undefined) {
      headline.push(styles.error(`error: ${summary.error}`));
    }
    for (const attempt of summary.failoverHistory ?? []) {
      headline.push(styles.warning(`failover: ${attempt.model} → ${attempt.failureKind ?? "?"}`));
    }
    headline.push(styles.dim("esc back"));
    this.detail.addChild(new Text(headline.join("\n"), 1, 0));

    for (const item of replay.timeline) {
      const style =
        item.category === "thinking"
          ? styles.thinking
          : item.category === "tool"
            ? styles.accent
            : item.category === "error"
              ? styles.error
              : item.category === "runtime"
                ? styles.dim
                : (text: string): string => text;
      const label = `${styles.dim(`#${String(item.index).padStart(3, " ")}`)} ${style(item.label)}`;
      const summaryText = item.summary.length > 0 ? ` ${styles.muted(previewValue(item.summary, 500))}` : "";
      this.detail.addChild(new Text(`${label}${summaryText}`, 1, 0));
    }
  }
}

function usageLine(usage: unknown, cost: unknown): string | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const input = numberOrUndefined(record.input ?? record.inputTokens ?? record.input_tokens);
  const output = numberOrUndefined(record.output ?? record.outputTokens ?? record.output_tokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  const usd = numberOrUndefined(
    typeof cost === "object" && cost !== null ? (cost as Record<string, unknown>).totalUsd ?? (cost as Record<string, unknown>).usd : cost,
  );
  return `tokens ↑${formatTokens(input ?? 0)} ↓${formatTokens(output ?? 0)}${usd === undefined ? "" : ` · ${formatUsd(usd)}`}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

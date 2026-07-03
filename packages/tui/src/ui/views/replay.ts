import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { SelectItem, TUI } from "@earendil-works/pi-tui";
import type { RecordedRunListItem } from "@mono-agent/observability";

import { listReplayRuns, readReplayRun, type ReplayRunDetail, type ReplayTimelineItem } from "../../data/replay.js";
import { formatClock, formatDurationMs } from "../format.js";
import { selectListTheme, styles } from "../theme.js";
import { EventTimelineList } from "../components/event-list.js";
import { buildHeadline, buildPayloadPane, buildStatusLine, CATEGORY_KEYS } from "./replay-detail.js";

export interface ReplayViewOptions {
  readonly tui: TUI;
}

/**
 * Recorded-run replay straight from the agent's artifact dir: run list →
 * debugger-style step-through of any past turn's full event timeline
 * (thinking, tools, telemetry, failover) from ANY channel — richer than the
 * live stream since nothing is dropped.
 */
export class ReplayView extends Container {
  readonly list: SelectList;
  private readonly options: ReplayViewOptions;
  private readonly header = new Text("", 1, 0);
  private readonly detail = new Container();
  private readonly detailHeadline = new Text("", 1, 0);
  private readonly detailStatus = new Text("", 1, 0);
  private readonly eventList = new EventTimelineList({ maxVisible: 16 });
  private readonly detailPayload = new Text("", 1, 0);
  private mode: "list" | "detail" = "list";
  private artifactDir: string | undefined;
  private runs: readonly RecordedRunListItem[] = [];

  // Detail-mode state. `categoryFilter` empty means "no filter" (all visible)
  // -- see setCategoryFilter/toggleCategory below for how that maps onto the
  // component's undefined-means-unfiltered convention.
  private currentReplay: ReplayRunDetail | undefined;
  private readonly categoryFilter = new Set<string>();
  private committedSearch: string | undefined;
  private searchInputOpen = false;
  private searchInputBuffer = "";
  private payloadExpanded = false;
  private selectedItem: ReplayTimelineItem | undefined;

  constructor(options: ReplayViewOptions) {
    super();
    this.options = options;
    this.list = new SelectList([], 14, selectListTheme, { maxPrimaryColumnWidth: 46 });
    this.list.onSelect = (item: SelectItem) => {
      void this.openRun(item.value);
    };
    this.detail.addChild(this.detailHeadline);
    this.detail.addChild(this.detailStatus);
    this.detail.addChild(this.eventList);
    this.detail.addChild(this.detailPayload);
    this.eventList.onSelectionChange = (item) => {
      this.selectedItem = item;
      this.refreshPanes();
    };
    this.showList();
    // Self-initialize the empty-state header (no artifact dir until an
    // instance is selected).
    void this.refresh();
  }

  isInDetail(): boolean {
    return this.mode === "detail";
  }

  /**
   * Esc layering in detail mode: an open search input closes+clears first;
   * else a committed search clears; else an expanded payload pane collapses;
   * else return to the run list. Returns false only when already at the list
   * (so app-level esc fallthrough, e.g. switching views, still works).
   */
  back(): boolean {
    if (this.mode !== "detail") {
      return false;
    }
    if (this.searchInputOpen) {
      this.searchInputOpen = false;
      this.searchInputBuffer = "";
    } else if (this.committedSearch !== undefined) {
      this.committedSearch = undefined;
      this.eventList.setSearch(undefined);
    } else if (this.payloadExpanded) {
      this.payloadExpanded = false;
    } else {
      this.showList();
      this.options.tui.requestRender();
      return true;
    }
    this.refreshPanes();
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
      return;
    }
    this.handleDetailInput(data);
  }

  setArtifactDir(artifactDir: string | undefined): void {
    this.artifactDir = artifactDir;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    // Snapshot: a rapid agent switch mid-read must not paint the previous
    // agent's runs into the new agent's list.
    const requestedDir = this.artifactDir;
    if (requestedDir === undefined) {
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
      const { runs, warnings } = await listReplayRuns(requestedDir);
      if (this.artifactDir !== requestedDir) {
        return; // Superseded by a newer agent selection.
      }
      this.runs = runs;
      const warningText = warnings.length > 0 ? `\n${styles.warning(warnings[0] ?? "")}` : "";
      this.header.setText(
        `${styles.bold(`Recorded runs (${runs.length})`)} ${styles.dim("enter open · r refresh · esc back")}${warningText}`,
      );
    } catch (error) {
      if (this.artifactDir !== requestedDir) {
        return;
      }
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
    const requestedDir = this.artifactDir;
    if (requestedDir === undefined) {
      return;
    }
    const replay = await readReplayRun(requestedDir, runId);
    if (this.artifactDir !== requestedDir) {
      return; // Superseded by a newer agent selection.
    }
    if (replay === undefined) {
      this.header.setText(styles.error(`Run ${runId} not found.`));
      this.options.tui.requestRender();
      return;
    }
    this.mode = "detail";
    this.clear();
    this.openDetail(replay);
    this.addChild(this.detail);
    this.options.tui.requestRender();
  }

  /** Reset all detail-mode state for a freshly opened run and populate the panes. */
  private openDetail(replay: ReplayRunDetail): void {
    this.currentReplay = replay;
    this.categoryFilter.clear();
    this.committedSearch = undefined;
    this.searchInputOpen = false;
    this.searchInputBuffer = "";
    this.payloadExpanded = false;
    this.detailHeadline.setText(buildHeadline(replay));
    this.eventList.setCategoryFilter(undefined);
    this.eventList.setSearch(undefined);
    // Triggers onSelectionChange synchronously, which calls refreshPanes().
    this.eventList.setItems(replay.timeline, replay.turns);
  }

  private handleDetailInput(data: string): void {
    if (this.searchInputOpen) {
      this.handleSearchInputKey(data);
      this.refreshPanes();
      this.options.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.eventList.handleInput(data);
    } else if (data === "g") {
      this.eventList.moveToFirst();
    } else if (data === "G") {
      this.eventList.moveToLast();
    } else if (data === "[") {
      this.eventList.moveToTurn(-1);
    } else if (data === "]") {
      this.eventList.moveToTurn(1);
    } else if (data === "a") {
      this.categoryFilter.clear();
      this.eventList.setCategoryFilter(undefined);
    } else if (CATEGORY_KEYS[data] !== undefined) {
      this.toggleCategory(CATEGORY_KEYS[data]!);
    } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.payloadExpanded = !this.payloadExpanded;
    } else if (data === "/") {
      this.searchInputOpen = true;
      this.searchInputBuffer = "";
    } else if (data === "n") {
      this.eventList.moveToMatch(1);
    } else if (data === "N") {
      this.eventList.moveToMatch(-1);
    } else {
      return;
    }
    this.refreshPanes();
    this.options.tui.requestRender();
  }

  private toggleCategory(category: string): void {
    if (this.categoryFilter.has(category)) {
      this.categoryFilter.delete(category);
    } else {
      this.categoryFilter.add(category);
    }
    this.eventList.setCategoryFilter(this.categoryFilter.size === 0 ? undefined : new Set(this.categoryFilter));
  }

  private handleSearchInputKey(data: string): void {
    if (matchesKey(data, "enter")) {
      this.commitSearch(this.searchInputBuffer);
    } else if (matchesKey(data, "backspace")) {
      this.searchInputBuffer = this.searchInputBuffer.slice(0, -1);
    } else if (matchesKey(data, "escape")) {
      this.searchInputOpen = false;
      this.searchInputBuffer = "";
    } else {
      const printable = data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined;
      if (printable !== undefined) {
        this.searchInputBuffer += printable;
      }
    }
  }

  private commitSearch(query: string): void {
    this.searchInputOpen = false;
    const trimmed = query.trim();
    this.committedSearch = trimmed.length > 0 ? trimmed : undefined;
    this.eventList.setSearch(this.committedSearch);
    if (this.committedSearch !== undefined) {
      this.eventList.moveToMatch(1);
    }
  }

  /** Recompute the status line + selected-event payload pane from current state. */
  private refreshPanes(): void {
    const turns = this.currentReplay?.turns ?? [];
    this.detailStatus.setText(
      buildStatusLine({
        ordinal: this.eventList.selectedVisibleOrdinal(),
        visibleCount: this.eventList.visibleCount(),
        turnIndex: this.eventList.turnOfSelection(),
        turnCount: turns.length,
        categoryFilter: this.categoryFilter,
        searchInputOpen: this.searchInputOpen,
        searchInputBuffer: this.searchInputBuffer,
        committedSearch: this.committedSearch,
        matchCount: this.eventList.matchCount(),
      }),
    );
    this.detailPayload.setText(buildPayloadPane(this.selectedItem, this.payloadExpanded));
  }
}

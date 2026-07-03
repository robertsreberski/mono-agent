import { CombinedAutocompleteProvider, Container, Editor, Loader, Text } from "@earendil-works/pi-tui";
import type { Component, SlashCommand, TUI } from "@earendil-works/pi-tui";
import {
  isAgentResponseCancelledError,
  type AgentResponder,
  type AgentResponseMetadata,
} from "@mono-agent/agent-contracts";

import type { TuiHistoryStore } from "../../agent/history.js";
import { editorTheme, styles } from "../theme.js";
import { NoticeCell, ThinkingCell, UserCell } from "../components/transcript-cells.js";
import type { StatusBar } from "../components/status-bar.js";
import { TurnPresenter } from "../turn-presenter.js";

export interface ChatViewOptions {
  readonly tui: TUI;
  readonly statusBar: StatusBar;
  readonly conversationId: string;
  readonly history?: TuiHistoryStore;
  readonly slashCommands: readonly SlashCommand[];
  /** Handle a submitted /command; return true when consumed. */
  readonly onSlashCommand: (command: string, args: string) => boolean;
  readonly logger?: { error?(message: string, metadata?: Record<string, unknown>): void };
  readonly flushIntervalMs?: number;
}

/**
 * The live chat surface: transcript, in-flight loader, editor, and the turn
 * lifecycle (submit → TurnPresenter → settle). Esc aborts the in-flight turn.
 */
export class ChatView extends Container {
  readonly editor: Editor;
  private readonly transcript = new Container();
  private readonly loader: Loader;
  private readonly options: ChatViewOptions;
  private responder: AgentResponder | undefined;
  /**
   * Every not-yet-settled turn's controller — the in-flight one AND queued
   * follow-ups (the harness queues per conversation). Esc aborts them all;
   * tracking only the latest would orphan the turn that is actually running.
   */
  private readonly activeControllers = new Set<AbortController>();
  private turnCounter = 0;
  private thinkingExpandedFlag = false;

  constructor(options: ChatViewOptions) {
    super();
    this.options = options;
    this.loader = new Loader(options.tui, styles.accent, styles.muted, "working…");
    this.editor = new Editor(options.tui, editorTheme);
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([...options.slashCommands], process.cwd()),
    );
    this.editor.onSubmit = (text) => {
      this.handleSubmit(text);
    };
    this.addChild(this.transcript);
    this.addChild(this.editor);
  }

  setResponder(responder: AgentResponder | undefined): void {
    this.responder = responder;
  }

  /**
   * Whether the editor's buffer is empty. Drives app.ts's chat exception to
   * global tab/`?`: with nothing to lose, both act as global shortcuts (view
   * cycling, help); with unsubmitted text, they pass through to the editor
   * (autocomplete completion / literal `?`) unchanged.
   */
  isEditorEmpty(): boolean {
    return this.editor.getText().length === 0;
  }

  hasActiveTurn(): boolean {
    return this.activeControllers.size > 0;
  }

  /** Esc: abort every unsettled turn (in-flight + queued). Returns true when there was one. */
  cancelActiveTurn(): boolean {
    if (this.activeControllers.size === 0) {
      return false;
    }
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    // Belt and braces for remote responders: socket teardown cancels the turn
    // server-side too, but an explicit cancel also clears queued follow-ups.
    this.responder?.cancel?.(this.options.conversationId, "tui_cancel");
    return true;
  }

  toggleThinkingExpanded(): void {
    this.thinkingExpandedFlag = !this.thinkingExpandedFlag;
    for (const child of this.transcript.children) {
      if (child instanceof ThinkingCell) {
        child.setExpanded(this.thinkingExpandedFlag);
      }
    }
    this.options.statusBar.setEphemeral(
      this.thinkingExpandedFlag ? "thinking expanded" : "thinking collapsed",
    );
    this.options.tui.requestRender();
  }

  addNotice(message: string, kind: "warning" | "error" = "warning"): void {
    this.transcript.addChild(new NoticeCell(message, kind));
    this.options.tui.requestRender();
  }

  addInfo(text: string): void {
    this.transcript.addChild(new Text(styles.muted(text), 1, 0));
    this.options.tui.requestRender();
  }

  private handleSubmit(raw: string): void {
    const text = raw.trim();
    if (text.length === 0) {
      return;
    }
    this.editor.setText("");
    this.editor.addToHistory(text);
    if (text.startsWith("/")) {
      const [command = "", ...rest] = text.slice(1).split(/\s+/u);
      if (this.options.onSlashCommand(command.toLowerCase(), rest.join(" "))) {
        return;
      }
    }
    void this.runTurn(text);
  }

  private async runTurn(text: string): Promise<void> {
    if (this.responder === undefined) {
      this.addNotice("Not connected to an agent — /agents to pick one.", "error");
      return;
    }
    if (this.activeControllers.size > 0) {
      // LiveSessionManager queues per conversation; let the user know.
      this.options.statusBar.setEphemeral("turn in flight — message queued after it");
    }
    this.turnCounter += 1;
    const turnId = `tui-${Date.now()}-${this.turnCounter}`;
    this.transcript.addChild(new UserCell(text));
    this.options.history?.append({
      id: `${turnId}-user`,
      role: "user",
      text,
      timestamp: Date.now(),
      conversationId: this.options.conversationId,
    });

    const controller = new AbortController();
    const presenter = new TurnPresenter({
      transcript: this.transcript,
      statusBar: this.options.statusBar,
      requestRender: () => this.options.tui.requestRender(),
      thinkingExpanded: () => this.thinkingExpandedFlag,
      ...(this.options.flushIntervalMs === undefined ? {} : { flushIntervalMs: this.options.flushIntervalMs }),
    });
    this.activeControllers.add(controller);
    this.setLoading(true);

    let status: "ok" | "cancelled" | "error" = "ok";
    try {
      const response = await this.responder.respond(
        {
          conversationId: this.options.conversationId,
          text,
          abortSignal: controller.signal,
          metadata: { source: "tui" },
        },
        presenter,
      );
      if (response.text !== undefined) {
        await presenter.finish(response.text);
      }
      this.applyFinishMetadata(response.metadata);
    } catch (error) {
      if (isAgentResponseCancelledError(error) || controller.signal.aborted) {
        status = "cancelled";
        this.addNotice("Turn cancelled.", "warning");
      } else {
        status = "error";
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.error?.("tui.turn.failed", { message });
        this.addNotice(message, "error");
      }
    } finally {
      this.activeControllers.delete(controller);
      if (this.activeControllers.size === 0) {
        this.setLoading(false);
      }
      presenter.settle();
      this.options.statusBar.setEphemeral("");
      const answer = presenter.assistantText();
      if (answer.length > 0 || status !== "ok") {
        this.options.history?.append({
          id: `${turnId}-assistant`,
          role: "assistant",
          text: answer,
          timestamp: Date.now(),
          conversationId: this.options.conversationId,
          status,
        });
      }
      this.options.tui.requestRender();
    }
  }

  /**
   * The authoritative post-turn correction: `metadata.runtime` is set by the
   * harness from the actual run (not the requested config), so it wins over
   * whatever the mid-stream `run_config` event (or nothing, for agents that
   * predate it) already showed. Guarded defensively — `metadata` is
   * `unknown`-shaped wire data. Absence of either field is NOT a signal to
   * clear; only a present string value ever updates the status bar.
   */
  private applyFinishMetadata(metadata: AgentResponseMetadata | undefined): void {
    if (typeof metadata !== "object" || metadata === null) {
      return;
    }
    const runtime = (metadata as Record<string, unknown>).runtime;
    if (typeof runtime !== "object" || runtime === null) {
      return;
    }
    const record = runtime as Record<string, unknown>;
    if (typeof record.effort === "string") {
      this.options.statusBar.setEffort(record.effort);
    }
    if (typeof record.model === "string") {
      this.options.statusBar.setModel(record.model);
    }
  }

  private setLoading(loading: boolean): void {
    if (loading) {
      if (!this.children.includes(this.loader as unknown as Component)) {
        // Loader sits between the transcript and the editor.
        this.children.splice(this.children.indexOf(this.editor), 0, this.loader);
      }
      this.loader.start();
    } else {
      this.loader.stop();
      const index = this.children.indexOf(this.loader);
      if (index >= 0) {
        this.children.splice(index, 1);
      }
    }
    this.options.tui.requestRender();
  }
}

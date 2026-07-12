import { CombinedAutocompleteProvider, Container, Editor, Loader, Text } from "@earendil-works/pi-tui";
import type { Component, SlashCommand, TUI } from "@earendil-works/pi-tui";
import {
  createChannelUserCancelReason,
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
  /** Marks requests as coming from the OS-owner-local in-process TUI. */
  readonly localMode?: boolean;
  /** Runs only after the response/presenter has fully settled. */
  readonly onTurnSettled?: (event: ChatTurnSettledEvent) => void | Promise<void>;
}

export interface ChatTurnSettledEvent {
  readonly configuration: boolean;
  readonly status: "ok" | "cancelled" | "error";
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
  /**
   * TUI turns are serialized through their full settled hook. This keeps a
   * fast follow-up from entering a responder that the configuration hook is
   * about to rotate and dispose.
   */
  private turnBoundary: Promise<void> = Promise.resolve();
  private turnCounter = 0;
  private thinkingExpandedFlag = false;
  /**
   * Session-scoped model override set via `/model`. When present, each turn's
   * request carries `metadata.tui.model` so the harness runs that turn against
   * the chosen model (a fresh provider session) instead of the agent default.
   */
  private modelOverride: string | undefined;
  /**
   * The connected agent's own default model (from `/v1/info`), tracked so
   * clearing the override has something correct to repaint the status bar
   * to -- otherwise it would fall back to whatever string was last painted,
   * which is the just-cleared override itself. Set via {@link setDefaultModel}.
   */
  private defaultModel: string | undefined;
  /**
   * Session-scoped effort override set via `/effort`. When present, each turn's
   * request carries `metadata.tui.effort` so the harness runs that turn at the
   * chosen reasoning effort instead of the agent default. Mirrors
   * {@link modelOverride}; the two are independent and can be set together.
   */
  private effortOverride: string | undefined;
  /**
   * The connected agent's own default effort (from `/v1/info`), tracked so
   * clearing the override repaints the status bar to it (not the just-cleared
   * override string). Mirror of {@link defaultModel}; set via {@link setDefaultEffort}.
   */
  private defaultEffort: string | undefined;
  /** The next operator-submitted turn is the single response to a configuration invitation. */
  private nextUserTurnConfiguration = false;

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
   * Set (model string) or clear (`undefined`) the session model override, and
   * reflect it on the status bar immediately: the model segment shows the
   * chosen model with an `(override)` tag, cleared back to the connected
   * agent's own default (via {@link setDefaultModel}, not the last override
   * string) on `undefined`. The override applies from the next turn onward.
   */
  setModelOverride(model: string | undefined): void {
    this.modelOverride = model;
    this.options.statusBar.setModel(model ?? this.defaultModel);
    this.options.statusBar.setModelOverridden(model !== undefined);
    this.options.tui.requestRender();
  }

  /** The active session override, or `undefined` — drives the picker's `(current)` marker. */
  getModelOverride(): string | undefined {
    return this.modelOverride;
  }

  /**
   * Set (effort string) or clear (`undefined`) the session effort override, and
   * reflect it on the status bar immediately: the effort segment shows the
   * chosen level with an `(override)` tag, cleared back to the connected agent's
   * own default (via {@link setDefaultEffort}, not the last override string) on
   * `undefined`. The override applies from the next turn onward. Independent of
   * {@link setModelOverride} — both can be active at once.
   */
  setEffortOverride(effort: string | undefined): void {
    this.effortOverride = effort;
    this.options.statusBar.setEffort(effort ?? this.defaultEffort);
    this.options.statusBar.setEffortOverridden(effort !== undefined);
    this.options.tui.requestRender();
  }

  /** The active session effort override, or `undefined` — drives the picker's `(current)` marker. */
  getEffortOverride(): string | undefined {
    return this.effortOverride;
  }

  /**
   * Record the connected agent's own default model (from `/v1/info`), so a
   * later `setModelOverride(undefined)` knows what to repaint the status bar
   * to. When no override is currently active, also repaints immediately --
   * this is how a fresh `/v1/info` snapshot (e.g. after switching agents)
   * reaches the status bar's model segment.
   */
  setDefaultModel(model: string | undefined): void {
    this.defaultModel = model;
    if (this.modelOverride === undefined) {
      this.options.statusBar.setModel(model);
      this.options.tui.requestRender();
    }
  }

  /**
   * Record the connected agent's own default effort (from `/v1/info`), so a
   * later `setEffortOverride(undefined)` knows what to repaint the status bar
   * to. When no override is currently active, repaints immediately — this is
   * how a fresh `/v1/info` snapshot (e.g. after switching agents) reaches the
   * status bar's effort segment. Mirror of {@link setDefaultModel}.
   */
  setDefaultEffort(effort: string | undefined): void {
    this.defaultEffort = effort;
    if (this.effortOverride === undefined) {
      this.options.statusBar.setEffort(effort);
      this.options.tui.requestRender();
    }
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
    const reason = createChannelUserCancelReason("TUI");
    for (const controller of this.activeControllers) {
      controller.abort(reason);
    }
    // Belt and braces for remote responders: socket teardown cancels the turn
    // server-side too, but an explicit cancel also clears queued follow-ups.
    this.responder?.cancel?.(this.options.conversationId, reason);
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

  /** Start a real, recorded agent turn without rendering the host prompt as an operator message. */
  beginConfiguration(prompt: string): void {
    if (this.hasActiveTurn()) {
      this.addNotice("Wait for the active turn to settle, then run /configure again.", "warning");
      return;
    }
    this.nextUserTurnConfiguration = true;
    void this.runTurn(prompt, { configuration: true, displayUser: false });
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
    const configuration = this.nextUserTurnConfiguration;
    this.nextUserTurnConfiguration = false;
    void this.runTurn(text, { configuration });
  }

  private async runTurn(
    text: string,
    options: { readonly configuration?: boolean; readonly displayUser?: boolean } = {},
  ): Promise<void> {
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
    if (options.displayUser !== false) {
      this.transcript.addChild(new UserCell(text));
      this.options.history?.append({
        id: `${turnId}-user`,
        role: "user",
        text,
        timestamp: Date.now(),
        conversationId: this.options.conversationId,
      });
    }

    const controller = new AbortController();
    const serializeThroughSettledHook = this.options.onTurnSettled !== undefined;
    const previousTurnBoundary = serializeThroughSettledHook ? this.turnBoundary : Promise.resolve();
    let releaseTurnBoundary: (() => void) | undefined;
    if (serializeThroughSettledHook) {
      this.turnBoundary = new Promise<void>((resolve) => {
        releaseTurnBoundary = resolve;
      });
    }
    const presenter = new TurnPresenter({
      transcript: this.transcript,
      statusBar: this.options.statusBar,
      requestRender: () => this.options.tui.requestRender(),
      thinkingExpanded: () => this.thinkingExpandedFlag,
      ...(this.options.flushIntervalMs === undefined ? {} : { flushIntervalMs: this.options.flushIntervalMs }),
      ...(this.modelOverride === undefined ? {} : { requestedModelOverride: this.modelOverride }),
    });
    this.activeControllers.add(controller);
    this.setLoading(true);

    // metadata.tui carries whichever session overrides are active; when both are
    // clear it is omitted entirely so the turn runs the agent's own defaults.
    const tuiMetadata = {
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
      ...(this.options.localMode === true ? { local: true } : {}),
      ...(options.configuration === true ? { configuration: true } : {}),
    };
    let status: "ok" | "cancelled" | "error" = "ok";
    try {
      await previousTurnBoundary;
      if (serializeThroughSettledHook && controller.signal.aborted) {
        throw new Error("Turn cancelled before it started.");
      }
      const response = await this.responder.respond(
        {
          conversationId: this.options.conversationId,
          text,
          abortSignal: controller.signal,
          metadata: {
            source: "tui",
            ...(Object.keys(tuiMetadata).length === 0 ? {} : { tui: tuiMetadata }),
          },
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
      try {
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
        try {
          await this.options.onTurnSettled?.({
            configuration: options.configuration === true,
            status,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logger?.error?.("tui.turn.settled_hook_failed", { message });
          this.addNotice(message, "error");
        }
      } finally {
        this.activeControllers.delete(controller);
        if (this.activeControllers.size === 0) {
          this.setLoading(false);
        }
        releaseTurnBoundary?.();
      }
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

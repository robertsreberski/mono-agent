import { Container, matchesKey, SelectList, Text, TUI } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, SelectItem, SlashCommand, Terminal } from "@earendil-works/pi-tui";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { EFFORT_LEVELS } from "@mono-agent/config";

import type { TuiHistoryStore } from "../agent/history.js";
import { discoverInstances, resolveInstanceApiKey, toInstance } from "../data/instances.js";
import type { DiscoveredInstance } from "../data/instances.js";
import { RemoteAgentResponder } from "../remote/client.js";
import { selectListTheme, styles } from "./theme.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatView } from "./views/chat.js";
import { ConfigView } from "./views/config.js";
import { PickerView } from "./views/picker.js";
import { ReplayView } from "./views/replay.js";

export type TuiViewId = "chat" | "picker" | "replay" | "config";

export interface TuiAppLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface MonoAgentTuiAppOptions {
  readonly terminal: Terminal;
  /** In-process responder (embedded mode); mutually exclusive with connection/discovery. */
  readonly responder?: AgentResponder;
  /** Direct remote connection (from `mono-agent tui` after resolution). */
  readonly connection?: { readonly baseUrl: string; readonly apiKey?: string };
  /** Discovery mode: open on the instance picker over these registries (`registryDirs` union beats the single `registryDir`). */
  readonly discovery?: {
    readonly registryDir?: string;
    readonly registryDirs?: readonly string[];
    readonly staleAfterMs?: number;
  };
  /** Identity + data roots of the selected instance (replay/config views). */
  readonly instance?: {
    readonly label?: string;
    readonly artifactDir?: string;
    readonly configPath?: string;
  };
  readonly conversationId?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly initialStatusText?: string;
  readonly history?: TuiHistoryStore;
  readonly config?: { readonly path: string; readonly cwd: string; readonly env: Record<string, string | undefined> };
  readonly logger?: TuiAppLogger;
  readonly env?: Record<string, string | undefined>;
  /** Test seam: coalescing window for streamed markdown; 0 = synchronous. */
  readonly flushIntervalMs?: number;
}

const VIEW_ORDER: readonly TuiViewId[] = ["chat", "replay", "config", "picker"];

/** Sentinel `SelectItem.value` for the model picker's "clear override" row (never a real model ref). */
const MODEL_PICKER_DEFAULT_VALUE = "tui-model-picker:__default__";
/** Sentinel `SelectItem.value` for the effort picker's "clear override" row (never a real level). */
const EFFORT_PICKER_DEFAULT_VALUE = "tui-effort-picker:__default__";

/**
 * Root controller: owns the pi-tui instance, the view stack, connection state,
 * and global keys (view cycling, cancel, quit, thinking toggle, help).
 */
export class MonoAgentTuiApp {
  readonly tui: TUI;
  private readonly options: MonoAgentTuiAppOptions;
  private readonly header = new Text("", 1, 0);
  private readonly viewHost = new Container();
  private readonly statusBar = new StatusBar();
  private readonly chat: ChatView;
  private readonly picker: PickerView;
  private readonly replay: ReplayView;
  private readonly config: ConfigView;
  private view: TuiViewId = "chat";
  private helpVisible = false;
  private helpHandle: { hide(): void } | undefined;
  /** Candidate models advertised by the connected agent's `/v1/info` (primary first, then fallbacks). */
  private availableModels: readonly string[] = [];
  /** Per-model effort/reasoning/label options from `/v1/info` (keyed by model ref); drives the model-aware effort picker + `/model` row annotations. */
  private modelOptions: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; label?: string }> = {};
  /** The connected agent's own default model ref (from `/v1/info`) — the effort picker's effective model when no `/model` override is active. */
  private agentModel: string | undefined;
  /** The single open picker overlay (model or effort); only one at a time. */
  private activePicker: { readonly handle: OverlayHandle; readonly list: SelectList } | undefined;
  private ctrlCArmedAt = 0;
  private exitResolve: (() => void) | undefined;
  private readonly exitPromise: Promise<void>;
  private stopped = false;

  constructor(options: MonoAgentTuiAppOptions) {
    this.options = options;
    this.tui = new TUI(options.terminal);
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });

    this.chat = new ChatView({
      tui: this.tui,
      statusBar: this.statusBar,
      conversationId: options.conversationId ?? "tui-local",
      ...(options.history === undefined ? {} : { history: options.history }),
      slashCommands: SLASH_COMMANDS,
      onSlashCommand: (command, args) => this.handleSlashCommand(command, args),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
    });
    this.picker = new PickerView({
      onSelect: (instance) => void this.connectTo(instance),
      onRefresh: () => void this.refreshInstances(),
    });
    this.replay = new ReplayView({ tui: this.tui });
    this.config = new ConfigView({ tui: this.tui, env: options.env ?? process.env });

    this.tui.addChild(this.header);
    this.tui.addChild(this.viewHost);
    this.tui.addChild(this.statusBar);
    this.tui.addInputListener((data) => this.handleGlobalInput(data));

    this.applyStaticIdentity();
    this.wireInitialMode();
  }

  start(): void {
    this.tui.start();
    this.showView(this.view);
  }

  async waitUntilExit(): Promise<void> {
    await this.exitPromise;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.chat.cancelActiveTurn();
    this.tui.stop();
    this.exitResolve?.();
  }

  showView(view: TuiViewId): void {
    this.view = view;
    this.viewHost.clear();
    const component: Component =
      view === "chat" ? this.chat : view === "picker" ? this.picker : view === "replay" ? this.replay : this.config;
    this.viewHost.addChild(component);
    this.tui.setFocus(view === "chat" ? this.chat.editor : component);
    this.updateHeader();
    this.tui.requestRender();
  }

  private wireInitialMode(): void {
    const { responder, connection, discovery, instance } = this.options;
    if (responder !== undefined) {
      this.chat.setResponder(responder);
    } else if (connection !== undefined) {
      const remote = new RemoteAgentResponder({
        baseUrl: connection.baseUrl,
        ...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
      });
      this.chat.setResponder(remote);
      void remote
        .info()
        .then((info) => {
          this.applyAgentInfo(info);
          this.tui.requestRender();
        })
        .catch((error: unknown) => {
          this.chat.addNotice(
            `Could not reach the agent: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        });
    }
    if (instance?.artifactDir !== undefined) {
      this.replay.setArtifactDir(instance.artifactDir);
    }
    const configPath = instance?.configPath ?? this.options.config?.path;
    if (configPath !== undefined) {
      this.config.setConfigPath(configPath, this.options.config?.cwd);
    }
    if (discovery !== undefined && responder === undefined && connection === undefined) {
      this.view = "picker";
      void this.refreshInstances();
    }
    if (this.options.initialStatusText !== undefined) {
      this.statusBar.setEphemeral(this.options.initialStatusText);
    }
  }

  private async refreshInstances(): Promise<void> {
    const discovery = this.options.discovery;
    const result = await discoverInstances({
      ...(discovery?.registryDir === undefined ? {} : { registryDir: discovery.registryDir }),
      ...(discovery?.registryDirs === undefined ? {} : { registryDirs: discovery.registryDirs }),
      ...(discovery?.staleAfterMs === undefined ? {} : { staleAfterMs: discovery.staleAfterMs }),
      env: this.options.env ?? process.env,
    }).catch((error: unknown) => {
      this.options.logger?.error?.("tui.discovery.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      const registryDirs = discovery?.registryDirs ?? (discovery?.registryDir === undefined ? [] : [discovery.registryDir]);
      return { instances: [], registryDir: registryDirs[0] ?? "", registryDirs, warnings: [] };
    });
    this.picker.setInstances(result.instances, result.registryDirs.join(", "));
    this.tui.requestRender();
  }

  private async connectTo(instance: DiscoveredInstance): Promise<void> {
    // A newly selected agent ends the previous agent's session-scoped /model
    // and /effort overrides right away -- synchronously, before any async info() round
    // trip. `applyAgentInfo` alone is NOT a sufficient choke point here: it
    // only runs once `info()` resolves successfully, but `setResponder` below
    // (has-endpoint branch) happens before that await, so a turn submitted
    // while info() is still in flight -- or after it fails -- would otherwise
    // still carry the old agent's override to the new one.
    this.chat.setModelOverride(undefined);
    this.chat.setEffortOverride(undefined);
    const normalized = toInstance(instance.source);
    if (normalized.tuiBaseUrl === undefined) {
      this.statusBar.setEphemeral("selected agent has no tui endpoint — replay/config only");
      this.chat.setResponder(undefined);
    } else {
      const apiKey = await resolveInstanceApiKey(normalized, this.options.env ?? process.env);
      const remote = new RemoteAgentResponder({
        baseUrl: normalized.tuiBaseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      this.chat.setResponder(remote);
      void remote
        .info()
        .then((info) => {
          this.applyAgentInfo(info);
          this.tui.requestRender();
        })
        .catch(() => undefined);
    }
    this.statusBar.setIdentity(instance.source.label);
    // artifactDir is a required manifest field and stands on its own — replay
    // must not be gated on the optional configPath (agentDir derives from it).
    this.replay.setArtifactDir(instance.source.artifactDir);
    this.config.setConfigPath(instance.source.configPath, normalized.agentDir);
    this.chat.addInfo(`connected to ${instance.source.label}`);
    this.showView("chat");
  }

  /**
   * Apply a `/v1/info` snapshot's model/effort to the status bar. Unlike the
   * per-turn finish-metadata correction in ChatView (a delta that never
   * clears), `info` is a full snapshot of the *newly selected agent* — an
   * absent `effort` here means this agent genuinely has none configured, so
   * clearing is correct: otherwise a stale effort from a previously
   * connected agent would misattribute to this one.
   */
  private applyAgentInfo(info: {
    readonly model?: string;
    readonly effort?: string;
    readonly models?: readonly string[];
    readonly modelOptions?: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; label?: string }>;
  }): void {
    // Routed through ChatView (not statusBar directly) so it can remember these
    // as the agent's defaults -- what a later /model|/effort default repaints
    // to, instead of leaving the last override string shown.
    this.chat.setDefaultEffort(info.effort);
    this.agentModel = info.model;
    if (info.model !== undefined) {
      this.chat.setDefaultModel(info.model);
    }
    // A full snapshot of the newly selected agent: an absent list/map means
    // this agent advertises none, so replace (not merge) — stale entries from a
    // previously connected agent must not leak into this one's pickers.
    this.availableModels = info.models ?? [];
    this.modelOptions = info.modelOptions ?? {};
  }

  private applyStaticIdentity(): void {
    const identity = this.options.instance?.label ?? this.options.title ?? "";
    if (identity.length > 0) {
      this.statusBar.setIdentity(identity);
    }
    this.updateHeader();
  }

  private updateHeader(): void {
    const title = this.options.title ?? "mono-agent";
    const subtitle = this.options.subtitle === undefined ? "" : ` ${styles.dim(this.options.subtitle)}`;
    const tabs = VIEW_ORDER.map((view) =>
      view === this.view ? styles.bold(styles.accent(`[${view}]`)) : styles.dim(view),
    ).join(" ");
    this.header.setText(`${styles.bold(title)}${subtitle}  ${tabs}`);
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    // Quit: double ctrl+c (single press arms + hints, mirrors pi's behavior).
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - this.ctrlCArmedAt < 1_500) {
        this.stop();
      } else {
        this.ctrlCArmedAt = now;
        this.statusBar.setEphemeral("press ctrl+c again to quit");
        this.tui.requestRender();
      }
      return { consume: true };
    }
    // The model/effort picker overlay is a modal: forward navigation/confirm to
    // its SelectList, esc cancels, and every other key is swallowed. This mirrors
    // replay.ts's key-capture pattern -- deliberately NOT the help overlay's
    // "any key closes" behaviour, which would dismiss the picker on arrows.
    if (this.activePicker !== undefined) {
      if (matchesKey(data, "escape")) {
        this.closePicker();
        return { consume: true };
      }
      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "pageUp") ||
        matchesKey(data, "pageDown") ||
        matchesKey(data, "enter")
      ) {
        this.activePicker.list.handleInput(data);
        return { consume: true };
      }
      return { consume: true };
    }
    if (this.helpVisible) {
      this.hideHelp();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.view === "chat" && this.chat.cancelActiveTurn()) {
        this.statusBar.setEphemeral("cancelling…");
        this.tui.requestRender();
        return { consume: true };
      }
      if (this.view === "replay" && this.replay.back()) {
        return { consume: true };
      }
      if (this.view !== "chat") {
        this.showView("chat");
        return { consume: true };
      }
      return undefined; // Editor may use Esc (autocomplete dismiss).
    }
    if (matchesKey(data, "tab") && this.globalShortcutsAllowedInChat()) {
      // In chat with unsubmitted text, Tab belongs to the editor
      // (autocomplete); an empty buffer has nothing to lose, so Tab cycles
      // views there too.
      this.cycleView(1);
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      this.cycleView(-1);
      return { consume: true };
    }
    if (matchesKey(data, "f2")) {
      this.showView("chat");
      return { consume: true };
    }
    if (matchesKey(data, "f3")) {
      this.showView("replay");
      return { consume: true };
    }
    if (matchesKey(data, "f4")) {
      this.showView("config");
      return { consume: true };
    }
    if (matchesKey(data, "f5")) {
      this.showView("picker");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      this.chat.toggleThinkingExpanded();
      return { consume: true };
    }
    if (data === "?" && this.globalShortcutsAllowedInChat()) {
      this.showHelp();
      return { consume: true };
    }
    return undefined;
  }

  /**
   * Tab/`?` act as global shortcuts (view cycling, help) everywhere except
   * chat with unsubmitted editor text -- there they pass through to the
   * editor instead (autocomplete completion / literal `?`). Shared by both
   * keys so the "empty editor" exception can't drift out of sync between them.
   */
  private globalShortcutsAllowedInChat(): boolean {
    return this.view !== "chat" || this.chat.isEditorEmpty();
  }

  private cycleView(direction: 1 | -1): void {
    const index = VIEW_ORDER.indexOf(this.view);
    const next = VIEW_ORDER[(index + direction + VIEW_ORDER.length) % VIEW_ORDER.length] ?? "chat";
    this.showView(next);
  }

  private handleSlashCommand(command: string, args: string): boolean {
    switch (command) {
      case "help":
        this.showHelp();
        return true;
      case "quit":
      case "exit":
        this.stop();
        return true;
      case "agents":
        this.showView("picker");
        void this.refreshInstances();
        return true;
      case "replay":
        this.showView("replay");
        return true;
      case "config":
        this.showView("config");
        return true;
      case "cancel":
        if (!this.chat.cancelActiveTurn()) {
          this.statusBar.setEphemeral("no turn in flight");
          this.tui.requestRender();
        }
        return true;
      case "thinking":
        this.chat.toggleThinkingExpanded();
        return true;
      case "model":
        this.handleModelCommand(args);
        return true;
      case "effort":
        this.handleEffortCommand(args);
        return true;
      case "new": {
        this.chat.addInfo(`conversation continues under a fresh screen${args.length > 0 ? ` (${args})` : ""}`);
        return true;
      }
      default:
        return false;
    }
  }

  private showHelp(): void {
    const help = new Text(
      [
        styles.bold("mono-agent tui"),
        "",
        `${styles.accent("f2/f3/f4/f5")}  chat / replay / config / agents`,
        `${styles.accent("tab")}         next view (chat: only when the editor is empty) · ${styles.accent("shift+tab")} previous`,
        `${styles.accent("esc")}         cancel in-flight turn · back`,
        `${styles.accent("ctrl+t")}      expand/collapse thinking`,
        `${styles.accent("ctrl+c ×2")}   quit`,
        "",
        `${styles.accent("replay list")}    s source filter · x status filter · r refresh`,
        `${styles.accent("replay detail")}  ↑↓/pgup/pgdn/g/G step · [ ] turn · t/o/m/y/e/a filter · / search · n/N match · enter raw json · esc layers back`,
        "",
        `${styles.accent("/model")}      override this session's model — ${styles.accent("/model <ref>")} or a bare ${styles.accent(
          "/model",
        )} picker; ${styles.accent("/model default")} clears it`,
        styles.dim("an override to a different model runs each turn as a fresh provider session"),
        `${styles.accent("/effort")}     override this session's effort — ${styles.accent("/effort <level>")} or a bare ${styles.accent(
          "/effort",
        )} picker; ${styles.accent("/effort default")} clears it`,
        styles.dim("effort options are model-specific"),
        "",
        `${styles.accent("/help /agents /replay /config /cancel /thinking /model /effort /quit")}`,
        "",
        styles.dim("any key closes this help"),
      ].join("\n"),
      2,
      1,
    );
    this.helpHandle = this.tui.showOverlay(help, { anchor: "center", width: 64 });
    this.helpVisible = true;
    this.tui.requestRender();
  }

  private hideHelp(): void {
    this.helpHandle?.hide();
    this.helpHandle = undefined;
    this.helpVisible = false;
    this.tui.requestRender();
  }

  /**
   * `/model` — with an argument, set (or, for `default`, clear) the session
   * model override directly; with no argument, open the picker overlay. An
   * override to a different model runs each turn as a fresh provider session.
   */
  private handleModelCommand(args: string): void {
    const arg = args.trim();
    if (arg.length > 0) {
      const override = arg === "default" ? undefined : arg;
      this.chat.setModelOverride(override);
      this.statusBar.setEphemeral(
        override === undefined ? "model override cleared" : `model override → ${override}`,
      );
      this.tui.requestRender();
      return;
    }
    this.showModelPicker();
  }

  private showModelPicker(): void {
    if (this.activePicker !== undefined) {
      return; // Already open.
    }
    if (this.availableModels.length === 0) {
      // Older agents (or embedded mode) advertise no candidate list; the direct
      // form still works. Use a persistent transcript notice (not a transient
      // ephemeral) so it doesn't read as "the picker is broken".
      this.chat.addNotice(
        "Model picker unavailable — this agent advertises no model list. Use /model <ref>, or update and restart the agent.",
        "warning",
      );
      this.tui.requestRender();
      return;
    }
    const current = this.chat.getModelOverride();
    const items: SelectItem[] = this.availableModels.map((model) => {
      const opts = this.modelOptions[model];
      // Prefer the friendly label for discovered local models; keep the ref as
      // the selection value so the override contract is unchanged. A dim
      // "· no thinking" flags models that don't support reasoning/effort.
      const base = opts?.label ?? model;
      const noThinking = opts?.reasoning === false ? styles.dim(" · no thinking") : "";
      return { value: model, label: `${withCurrentMarker(base, model === current)}${noThinking}` };
    });
    items.push({
      value: MODEL_PICKER_DEFAULT_VALUE,
      label: withCurrentMarker("— default (clear override) —", current === undefined),
    });

    this.openPickerOverlay("Session model override", items, (item) => {
      const choice = item.value === MODEL_PICKER_DEFAULT_VALUE ? undefined : item.value;
      this.chat.setModelOverride(choice);
      this.statusBar.setEphemeral(
        choice === undefined ? "model override cleared" : `model override → ${choice}`,
      );
    });
  }

  /**
   * `/effort` — with an argument, set (or, for `default`, clear) the session
   * effort override directly; with no argument, open the model-aware picker.
   */
  private handleEffortCommand(args: string): void {
    const arg = args.trim();
    if (arg.length > 0) {
      const override = arg === "default" ? undefined : arg;
      this.chat.setEffortOverride(override);
      this.statusBar.setEphemeral(
        override === undefined ? "effort override cleared" : `effort override → ${override}`,
      );
      this.tui.requestRender();
      return;
    }
    this.showEffortPicker();
  }

  /**
   * Model-aware effort picker: the effective model is the `/model` override if
   * set, else the agent's default. Its valid levels come from that model's
   * `modelOptions.effortLevels` when advertised (local models), falling back to
   * the global {@link EFFORT_LEVELS} enum (cloud models). A model that reports
   * `reasoning: false` (or an empty `effortLevels`) has no adjustable effort, so
   * we surface a persistent notice instead of opening an empty picker.
   */
  private showEffortPicker(): void {
    if (this.activePicker !== undefined) {
      return; // Already open.
    }
    const effectiveModel = this.chat.getModelOverride() ?? this.agentModel;
    const opts = effectiveModel === undefined ? undefined : this.modelOptions[effectiveModel];
    const unsupported =
      opts !== undefined &&
      (opts.reasoning === false || (opts.effortLevels !== undefined && opts.effortLevels.length === 0));
    if (unsupported) {
      const name = opts?.label ?? effectiveModel ?? "This model";
      this.chat.addNotice(`${name} does not support adjustable thinking/effort`, "warning");
      this.tui.requestRender();
      return;
    }
    const levels = opts?.effortLevels ?? EFFORT_LEVELS;
    const current = this.chat.getEffortOverride();
    const items: SelectItem[] = levels.map((level) => ({
      value: level,
      label: withCurrentMarker(level, level === current),
    }));
    items.push({
      value: EFFORT_PICKER_DEFAULT_VALUE,
      label: withCurrentMarker("— default (clear override) —", current === undefined),
    });

    this.openPickerOverlay("Session effort override", items, (item) => {
      const choice = item.value === EFFORT_PICKER_DEFAULT_VALUE ? undefined : item.value;
      this.chat.setEffortOverride(choice);
      this.statusBar.setEphemeral(
        choice === undefined ? "effort override cleared" : `effort override → ${choice}`,
      );
    });
  }

  /**
   * Open a modal select overlay (the model and effort pickers share this).
   * `onChoose` handles the picked item; the overlay always closes afterward.
   * nonCapturing keeps input routed through the global listener (which drives
   * the list explicitly and swallows the rest), so the overlay never contends
   * for focus with the chat editor underneath it.
   */
  private openPickerOverlay(title: string, items: SelectItem[], onChoose: (item: SelectItem) => void): void {
    const list = new SelectList(items, 10, selectListTheme);
    list.onSelect = (item: SelectItem) => {
      onChoose(item);
      this.closePicker();
    };
    list.onCancel = () => this.closePicker();
    // The current choice is called out by its `(current)` label; the cursor
    // opens at the top so navigation is predictable regardless of which entry
    // is current.
    list.setSelectedIndex(0);

    const overlay = new Container();
    overlay.addChild(new Text(styles.bold(title), 1, 0));
    overlay.addChild(list);
    overlay.addChild(new Text(styles.dim("↑↓ move · enter select · esc cancel"), 1, 0));

    this.activePicker = {
      handle: this.tui.showOverlay(overlay, { anchor: "center", width: 64, nonCapturing: true }),
      list,
    };
    this.tui.requestRender();
  }

  private closePicker(): void {
    this.activePicker?.handle.hide();
    this.activePicker = undefined;
    this.tui.requestRender();
  }
}

/** `<label> (current)` when this row is the active override, else `<label>`. */
function withCurrentMarker(label: string, isCurrent: boolean): string {
  return isCurrent ? `${label} (current)` : label;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show keybindings and commands" },
  { name: "agents", description: "Pick another running agent" },
  { name: "replay", description: "Browse recorded runs (full event timeline)" },
  { name: "config", description: "Read-only resolved config" },
  { name: "cancel", description: "Cancel the in-flight turn" },
  { name: "thinking", description: "Expand/collapse thinking blocks" },
  { name: "model", description: "Override this session's model (no arg opens a picker)" },
  { name: "effort", description: "Override this session's effort (no arg opens a model-aware picker)" },
  { name: "new", description: "Visual break in the transcript" },
  { name: "quit", description: "Exit the TUI" },
];

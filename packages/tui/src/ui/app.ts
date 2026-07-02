import { Container, matchesKey, Text, TUI } from "@earendil-works/pi-tui";
import type { Component, SlashCommand, Terminal } from "@earendil-works/pi-tui";
import type { AgentResponder } from "@mono-agent/agent-contracts";

import type { TuiHistoryStore } from "../agent/history.js";
import { discoverInstances, resolveInstanceApiKey, toInstance } from "../data/instances.js";
import type { DiscoveredInstance } from "../data/instances.js";
import { RemoteAgentResponder } from "../remote/client.js";
import { styles } from "./theme.js";
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
  /** Discovery mode: open on the instance picker over this registry. */
  readonly discovery?: { readonly registryDir?: string; readonly staleAfterMs?: number };
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
          if (info.model !== undefined) {
            this.statusBar.setModel(info.model);
          }
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
      ...(discovery?.staleAfterMs === undefined ? {} : { staleAfterMs: discovery.staleAfterMs }),
      env: this.options.env ?? process.env,
    }).catch((error: unknown) => {
      this.options.logger?.error?.("tui.discovery.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { instances: [], registryDir: discovery?.registryDir ?? "", warnings: [] };
    });
    this.picker.setInstances(result.instances, result.registryDir);
    this.tui.requestRender();
  }

  private async connectTo(instance: DiscoveredInstance): Promise<void> {
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
          if (info.model !== undefined) {
            this.statusBar.setModel(info.model);
          }
          this.tui.requestRender();
        })
        .catch(() => undefined);
    }
    this.statusBar.setIdentity(instance.source.label);
    this.replay.setArtifactDir(normalized.agentDir === undefined ? undefined : instance.source.artifactDir);
    this.config.setConfigPath(instance.source.configPath, normalized.agentDir);
    this.chat.addInfo(`connected to ${instance.source.label}`);
    this.showView("chat");
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
    if (matchesKey(data, "tab") && this.view !== "chat") {
      // In chat, Tab belongs to the editor (autocomplete); use F-keys there.
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
    if (data === "?" && this.view !== "chat") {
      this.showHelp();
      return { consume: true };
    }
    return undefined;
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
        `${styles.accent("tab")}         next view (outside chat) · ${styles.accent("shift+tab")} previous`,
        `${styles.accent("esc")}         cancel in-flight turn · back`,
        `${styles.accent("ctrl+t")}      expand/collapse thinking`,
        `${styles.accent("ctrl+c ×2")}   quit`,
        "",
        `${styles.accent("/help /agents /replay /config /cancel /thinking /quit")}`,
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
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show keybindings and commands" },
  { name: "agents", description: "Pick another running agent" },
  { name: "replay", description: "Browse recorded runs (full event timeline)" },
  { name: "config", description: "Read-only resolved config" },
  { name: "cancel", description: "Cancel the in-flight turn" },
  { name: "thinking", description: "Expand/collapse thinking blocks" },
  { name: "new", description: "Visual break in the transcript" },
  { name: "quit", description: "Exit the TUI" },
];

import type { AgentResponder } from "./index.js";
import type { RunEventBus } from "./live-events.js";

/**
 * Identifier of one communication channel. Open by design: hosts ship a set of
 * built-in ids and third-party drivers pick their own (e.g. `"discord"`). The
 * id keys status maps, `channel:<id>` validation sections, and notify routing.
 */
export type ChannelId = string;

/** Structural logger a host passes to channel drivers. All levels optional. */
export interface ChannelLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/** Where the host reads a channel's config from: process env + the JSON config file. */
export interface ChannelConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}

export type ChannelStatus =
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "waiting_for_config"; readonly reason: string }
  | { readonly kind: "running"; readonly summary: Record<string, unknown> }
  // Transport is temporarily down but the channel owns its own recovery (e.g. a
  // poller crashed on a network blip and is restarting). The responder/harness
  // stays alive and the channel keeps serving once the transport resumes — a
  // non-fatal state distinct from "failed".
  | { readonly kind: "degraded"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Outcome of attempting to deliver a proactive notification. `delivered` is true
 * only when the destination channel actually ran the nudge as a turn; otherwise
 * `reason` carries a short, inspectable explanation (unrecognized destination,
 * channel not running, destination not in the adapter allowlist, unsupported
 * channel, …). Surfaced back to the model and the run summary.
 */
export interface NotifyDeliveryResult {
  readonly delivered: boolean;
  readonly reason?: string;
}

/** A conversation a native cron/webhook notification can be delivered to. */
export interface NotifyDestination {
  /** Destination conversationId, e.g. `<channel>:<chat>`. */
  readonly conversationId: string;
  /** Owning channel id. */
  readonly channelId: string;
  /** ISO timestamp of the most recent turn on this conversation, if known. */
  readonly lastSeen?: string;
  /** True when this is an allowlisted destination the agent has not yet conversed with. */
  readonly fromAllowlist?: boolean;
}

/** Where a resolved channel config value came from (env > JSON > default). */
export type ChannelConfigViewFieldSource = "env" | "json" | "default";

/** One field of a channel's source-annotated config view. Secrets are never raw values. */
export interface ChannelConfigViewField {
  /** Stable dotted field id mirroring the JSON path, e.g. `<channel>.botToken`. */
  readonly id: string;
  readonly label: string;
  /** Display-ready value; secret fields render only as set/unset. */
  readonly value: string;
  readonly source: ChannelConfigViewFieldSource;
  /** True when the underlying value is a secret. */
  readonly redacted?: boolean;
  /** The `MONO_AGENT_*` env var that overrides this field. */
  readonly envKey?: string;
}

/** A channel's source-annotated config section, composed for discovery surfaces. */
export interface ChannelConfigViewSection {
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly fields: readonly ChannelConfigViewField[];
}

export interface RunningChannel {
  /** Channel-specific connection facts (invoke URL, agent card URL, job count). */
  readonly summary: Record<string, unknown>;
  stop(): Promise<void>;
  /**
   * Optional responder/harness teardown, set by the app (not the driver). Stopping
   * the transport alone leaves the per-channel harness + live-session manager alive;
   * on stop/reload the app disposes the responder so warm provider sessions and
   * queued turns against stale config are retired. Transport stops first.
   */
  dispose?(): Promise<void>;
  /**
   * Deliver a proactive notification to a destination this channel owns: run it as
   * a turn on the destination's own harness (shared session/history) and deliver
   * through the channel's normal stream. Set only by push channels; absent on
   * request-driven channels. Used by the app's proactive-notify router.
   *
   * Enforces the channel's own adapter allowlist (so a payload-supplied destination
   * cannot reach a non-allowlisted chat) and reports the outcome so the caller can
   * surface it to the model and the run summary.
   */
  notify?(input: {
    readonly conversationId: string;
    readonly text: string;
    /**
     * Deliver `text` VERBATIM — post it unchanged with no model call, then record
     * it to the destination's history (native cron/webhook notification). Without
     * it, `text` is run as a turn on the destination's harness.
     */
    readonly verbatim?: boolean;
  }): Promise<NotifyDeliveryResult>;
}

/**
 * Channel-side surface for human-in-the-loop interaction: post a free-text
 * question, or post/edit a short keyed status line. Registered by a channel
 * driver with the host's {@link ChannelInteractionHub} at start.
 */
export interface ChannelInteractionSink {
  postQuestion(conversationId: string, text: string): Promise<void>;
  postStatus(
    conversationId: string,
    text: string,
    options: { readonly key: string; readonly state: "working" | "done" | "failed" },
  ): Promise<void>;
}

/**
 * Host-owned hub connecting channels to blocking ask-the-user round-trips and
 * tool progress. A driver registers its sink and routes the user's replies /
 * cancellations back through the hub so a tool blocked on an ask can resume.
 */
export interface ChannelInteractionHub {
  registerSink(channelId: string, sink: ChannelInteractionSink): void;
  /** Resolve the conversation's pending ask with the user's reply; true when consumed. */
  tryResolveAsk(conversationId: string, answer: string): boolean | Promise<boolean>;
  /** Fail the conversation's pending ask (user cancelled). */
  cancelAsks(conversationId: string): void;
}

/**
 * Everything a driver receives to start its transport. `TCore` is the host's
 * core config type; hosts bind it (the mono-agent app uses its `MonoAgentConfig`)
 * while the neutral contract stays dependency-free.
 */
export interface ChannelStartInput<TConfig, TCore = unknown> {
  readonly config: TConfig;
  readonly coreConfig: TCore;
  readonly responder: AgentResponder;
  readonly cwd: string;
  readonly logger?: ChannelLogger;
  /**
   * Reports a transport that died after a successful start with NO self-recovery
   * (e.g. the channel's HTTP server crashed). The app disposes the responder/harness
   * and marks the channel failed. For a transport that owns its own reconnect, use
   * {@link onDegraded}/{@link onRecovered} instead so the responder is NOT disposed.
   */
  readonly onFailure: (reason: string) => void;
  /**
   * Reports a transport that is temporarily down but is self-recovering (e.g. a
   * poll crash on a network blip; the adapter restarts its own runner). The app
   * marks the channel "degraded" and KEEPS the responder/harness alive so the
   * self-restarted transport delivers into a live harness. Optional — drivers
   * that have no self-recovery only wire {@link onFailure}.
   */
  readonly onDegraded?: (reason: string) => void;
  /** Reports that a previously-degraded transport's self-recovery succeeded (back to running). */
  readonly onRecovered?: () => void;
  /** Native scheduled/webhook delivery hook owned by the app, used by proactive trigger channels. */
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  /** Candidate destinations for native delivery inference. */
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  /**
   * Path to the posted-message index (the artifact-dir JSONL linking a posted
   * message back to its producing conversation). Thread-aware push channels use
   * it to resolve in-thread replies and to record top-level proactive posts.
   */
  readonly postedMessageIndexPath?: string;
  /**
   * Host interaction hub for blocking ask-the-user round-trips and tool
   * progress. Present when the host runs an interaction bridge; a driver that
   * supports it registers a sink and wires reply interception/cancellation.
   */
  readonly interaction?: ChannelInteractionHub;
  /**
   * In-process live run-event bus, when the host runs one. A passive-observer
   * driver (the `live` SSE adapter) reads it to relay sub-run events to operator
   * surfaces; most drivers ignore it. The bus is fed by the host's broadcast
   * recorder, not by drivers.
   */
  readonly liveEventBus?: RunEventBus;
}

/**
 * One communication channel a host can run from config. Drivers stay thin:
 * they reuse an adapter package's config loader and start function and add
 * only the wiring a host previously copied by hand. Third-party drivers
 * implement this contract and are passed to the host programmatically.
 */
export interface ChannelDriver<TConfig = unknown, TCore = unknown> {
  readonly id: ChannelId;
  readonly label: string;
  loadConfig(input: ChannelConfigInput): Promise<TConfig>;
  /** True for the adapter's own typed config errors (incomplete config → waiting). */
  isConfigError(error: unknown): boolean;
  /** Reason the channel is explicitly disabled by its loaded config. */
  disabledReason?(config: TConfig): string | undefined;
  /** Reason a loaded, enabled config still cannot start (missing sub-section). */
  waitingReason?(config: TConfig): string | undefined;
  /**
   * Compose this channel's source-annotated config section (field-by-field
   * env/json/default provenance, secrets shown only as set/unset) for the
   * host's config view and secret-placement check. Read-only — never starts
   * the transport.
   */
  configView?(input: ChannelConfigInput): Promise<ChannelConfigViewSection>;
  /**
   * Structural issues in a loaded, enabled config an operator must fix (e.g.
   * an invalid per-trigger model override). Validation reports them as an
   * error; start logs them and starts anyway — the run-time path stays
   * graceful (ignore-and-fallback).
   */
  configIssues?(config: TConfig): readonly string[];
  start(input: ChannelStartInput<TConfig, TCore>): Promise<RunningChannel>;
}

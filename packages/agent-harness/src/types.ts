import type { AgentAttachment, MemoryStore } from "@mono-agent/agent-contracts";
import type { BuiltAgentContext, HistoryMessage } from "@mono-agent/context";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import type { SkillsCache } from "@mono-agent/skills";
import type { MonoRuntimeLike, RuntimeModelReference, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/runtime-adapter";
import type { ToolPolicy } from "@mono-agent/tool-policy";

export type MemoryWriteMode = "disabled" | "append-host-summary" | "capture";

export interface ConversationHistoryStore {
  load(conversationId: string): Promise<readonly HistoryMessage[]>;
  append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void>;
}

export interface InMemoryHistoryStoreOptions {
  readonly maxMessages?: number;
}

export interface AgentHarnessRequest {
  readonly conversationId: string;
  readonly userMessage: string;
  readonly abortSignal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly onEvent?: (event: RuntimeEventLike) => void;
  /**
   * Multimodal attachments. The harness saves each to `attachmentsDir` and
   * references the saved path (plus inlined text for documents) in the prompt,
   * so the agent opens them with its own file tools — no provider multimodal
   * contract required.
   */
  readonly attachments?: readonly AgentAttachment[];
}

export interface AgentHarnessFailure {
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface AgentHarnessResponse {
  readonly text?: string;
  readonly metadata: {
    readonly runId: string;
    readonly conversationId: string;
    readonly contextSources: readonly string[];
    readonly contextSectionIds: readonly string[];
    readonly runtime?: Record<string, unknown>;
    readonly summary?: RunSummary;
  };
  readonly failure?: AgentHarnessFailure;
}

export interface AgentHarness {
  run(request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
  /**
   * Queue-after-turn entry point. In continuous-session mode a same-conversation
   * request that arrives while a turn is in flight is queued and answered after
   * the current turn finishes — so it resumes the warm session rather than
   * racing fresh; different conversations still run concurrently. Falls back to
   * run() outside continuous mode.
   */
  submit?(request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
  /** Abort the in-flight turn for a conversation and clear its queued follow-ups. */
  cancel?(conversationId: string, reason?: unknown): void;
  /**
   * Record a message posted VERBATIM into `conversationId` by a channel (native
   * cron/webhook notification) without running a turn: append it to durable
   * history and retire any warm provider session so a later reply cold-loads the
   * delivered message into context. No model call.
   */
  appendVerbatimTurn?(conversationId: string, text: string): Promise<void>;
  /** Retire all live provider sessions (graceful shutdown). */
  dispose?(): Promise<void>;
}

export type AgentSessionMode = "continuous" | "per-message";

export interface AgentHarnessSessionOptions {
  readonly mode: AgentSessionMode;
  readonly idleTimeoutMs: number;
  /**
   * Overrides backend capability detection (monoRuntimeSupportsSessionResume)
   * — primarily for tests and custom runtimes.
   */
  readonly supportsResume?: boolean;
  /**
   * When true, a cron/proactive request (one carrying `metadata.cron`) is run as
   * a one-shot ephemeral turn: it does NOT acquire/resume the shared continuous
   * session and does NOT persist a warm session back into it, so its large tool
   * dumps stay out of the interactive transcript. Interactive (non-cron) turns
   * are unaffected. Default false (no behavior change).
   */
  readonly isolateProactive?: boolean;
}

export interface AgentHarnessRecorderFactoryInput {
  readonly runId: string;
  readonly conversationId: string;
  /** The user's prompt for this run, so recorders/exporters can surface it. */
  readonly userInput?: string;
  /**
   * Originating channel/trigger kind for this run, e.g. "tui" | "telegram" |
   * "slack" | "cron" | "webhook", derived from the request metadata (falling
   * back to a conversationId-prefix guess). Forwarded to the recorder so
   * summaries/exports can classify the run without re-deriving it.
   */
  readonly source?: string;
  /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
  readonly sourceDetail?: string;
}

export interface AgentHarnessOptions {
  readonly identityPath: string;
  readonly soulPath?: string;
  readonly skillsRoot?: string;
  readonly selectedSkills?: readonly string[];
  readonly skillMaxBytes?: number;
  /**
   * How skill bodies reach the agent. "full" (default) preserves the legacy
   * up-front inlining of `selectedSkills` bodies (via skillInstructions); "index"
   * injects the skill INDEX only and wires the runtime's `read_skill` tool so the
   * agent pulls a full body on demand. Unset = "full".
   */
  readonly skillDisclosure?: "index" | "full";
  /**
   * Optional shared skills cache. Skills are re-read from disk every turn
   * otherwise; pass one cache instance across turns (and across harnesses for a
   * conversation) to skip unchanged reads. Defaults to a per-harness cache.
   */
  readonly skillsCache?: SkillsCache;
  /**
   * Directory where inbound request attachments are saved before the agent
   * opens them. Should sit under a sandbox-readable root. When unset,
   * attachment bytes are not persisted (document text is still inlined).
   */
  readonly attachmentsDir?: string;
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly executionMode?: string;
  readonly cwd?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  /**
   * Durable pi-native session root directory. When set, provider sessions are
   * persisted to disk (JSONL) so a turn can resume across restarts instead of
   * falling back to a full conversation-history re-send. Unset = in-memory only.
   */
  readonly piSessionsRoot?: string;
  readonly runtimeOptions?: Omit<RuntimeRunOptions, "model" | "messages" | "abortSignal" | "executionMode" | "onEvent">;
  readonly runtimeOptionsForRequest?: (
    input: AgentHarnessRuntimeOptionsInput,
  ) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;
  /**
   * Factory for a runtime bound to a specific model, used when a per-request
   * extension overrides {@link model} (cron job / webhook per-turn model). The
   * app wires this to build a runtime whose fallback chain has the override as
   * primary followed by the configured backups, so an override keeps failover.
   * When unset, an override still sets the per-run model but cannot reshape a
   * frozen fallback chain (the router would ignore it).
   */
  readonly runtimeForModel?: (model: RuntimeModelReference, executionMode?: string) => MonoRuntimeLike;
  readonly memory?: MemoryStore;
  readonly memoryWriteMode?: MemoryWriteMode;
  readonly historyStore?: ConversationHistoryStore;
  readonly toolPolicy?: ToolPolicy;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly recorderFactory?: (input: AgentHarnessRecorderFactoryInput) => RunRecorder;
  readonly createRunId?: () => string;
  readonly now?: () => Date;
  readonly session?: AgentHarnessSessionOptions;
  /**
   * Optional concurrency bounds across all conversations served by this
   * harness. Two independent tiers, both unset = unbounded (default):
   *
   * - `maxConcurrentRuns` bounds provider EXECUTION WIDTH: how many runs may be
   *   in the model call at once (a semaphore acquired around the provider call
   *   only). Queued follow-ups wait in the per-conversation queue, holding no
   *   slot, until a slot frees.
   * - `maxPendingRuns` bounds ADMISSION: how many runs may be simultaneously
   *   past the front door — i.e. holding persisted attachments + built context
   *   in memory — before the costly pre-provider work runs. A request arriving
   *   when this counter is already at the bound fails fast (a "capacity_exceeded"
   *   failure) instead of doing the expensive work and parking in the unbounded
   *   semaphore queue. This is backpressure; it is deliberately NOT the
   *   semaphore (whose waiter queue is unbounded — that is the gap it closes).
   *
   * Bounds apply per channel harness instance, not globally across channels:
   * the app builds one harness per channel, so with N configured channels the
   * effective ceiling is N× this value.
   */
  readonly concurrency?: { readonly maxConcurrentRuns?: number; readonly maxPendingRuns?: number };
}

export interface AgentHarnessRuntimeOptionsInput {
  readonly request: AgentHarnessRequest;
  readonly runId: string;
  readonly context: BuiltAgentContext;
}

export interface AgentHarnessRuntimeOptionsExtension {
  // `model`/`effort` are allowed so a per-request extension can override them for
  // a single turn (cron/webhook per-trigger model). The harness applies them with
  // precedence over its defaults. `Partial` keeps every field optional (an
  // extension that sets only `mcpServers` stays valid). `messages`/`abortSignal`/
  // `onEvent` and `executionMode` stay harness-owned: executionMode is derived
  // from the effective model + host config in the harness, so an extension must
  // not set it.
  readonly runtimeOptions?: Partial<Omit<RuntimeRunOptions, "messages" | "abortSignal" | "onEvent" | "executionMode">>;
  readonly cleanup?: () => void | Promise<void>;
}

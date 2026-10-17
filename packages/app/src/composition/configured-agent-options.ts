import type { ConversationHarnessOptions, ConversationHarnessRuntimeOptionsExtension, ConversationHarnessRuntimeOptionsInput, ConversationHistoryStore } from "@mono-agent/conversation";
import type { MemoryStore } from "@mono-agent/contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { RunSummary } from "@mono-agent/observability";
import type { MonoRuntimeLike, RuntimeModelReference, SandboxEngine } from "@mono-agent/turn/host/types";

import type { ChannelId } from "../channels/types.js";
import type { ProcessJobsSettings } from "../process-jobs-config.js";
import type { ProcessJobsProtectionPosture } from "../process-jobs-protection.js";
import type { ProcessJobsRootRegistrySnapshot } from "../process-jobs-root-registry.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";

export type StaticRuntimeOptions = NonNullable<ConversationHarnessOptions["runtimeOptions"]>;

export interface ConfiguredAgentRuntimeOptions {
  readonly config: MonoAgentConfig;
  /** Canonical agent-root authority. A raw public runtime fails before run() when omitted. */
  readonly cwd?: string;
  readonly model?: RuntimeModelReference;
  readonly sandboxEngine?: SandboxEngine;
}

export type ConfiguredAgentSessionEventKind = "acquired" | "released" | "saved" | "evicted" | "isolated" | "cold";

export interface ConfiguredAgentSessionSnapshot {
  readonly modelKey?: string;
  readonly conversationId: string;
  readonly providerSessionId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly busy: boolean;
}

export interface ConfiguredAgentSessionEvent {
  readonly modelKey?: string;
  readonly kind: ConfiguredAgentSessionEventKind;
  readonly conversationId: string;
  readonly providerSessionId?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly snapshot?: readonly ConfiguredAgentSessionSnapshot[];
}

export type ConfiguredAgentSessionEventHandler = (event: ConfiguredAgentSessionEvent) => void | Promise<void>;
export type ConversationHarnessSessionOptionsWithEvents = NonNullable<ConversationHarnessOptions["session"]> & {
  readonly onSessionEvent?: ConfiguredAgentSessionEventHandler;
};

export interface ConfiguredConversationHarnessOptions {
  /** Managed workers resolve optional exporters only from their immutable app closure. */
  readonly config: MonoAgentConfig;
  /**
   * Canonical agent-root authority and plugin-resolution folder. Configured
   * harnesses/responders retain their historical current-folder default.
   */
  readonly cwd?: string;
  readonly runtime?: MonoRuntimeLike;
  readonly model?: RuntimeModelReference;
  readonly memory?: MemoryStore;
  /**
   * Authoritative process environment, as resolved by the host. Credential
   * checks that must recognize this agent's own configured secrets read it, so
   * a host started with an explicit `env` must pass the same map here rather
   * than let those checks fall back to `process.env`.
   */
  readonly env?: Record<string, string | undefined>;
  readonly historyStore?: ConversationHistoryStore;
  /** App-owned run-scoped interaction details to add only to replay history. */
  readonly turnHistoryEnricher?: ConversationHarnessOptions["turnHistoryEnricher"];
  /** App-owned issuer for request-scoped project-MCP progress credentials. */
  readonly progressCapabilityIssuer?: NonNullable<ConversationHarnessOptions["mcpRequestContext"]>["progressCapabilityIssuer"];
  /** App-owned issuer for destination-bound asynchronous continuation claims. */
  readonly continuationCapabilityIssuer?: NonNullable<ConversationHarnessOptions["continuationContext"]>["capabilityIssuer"];
  readonly createRunId?: ConversationHarnessOptions["createRunId"];
  readonly now?: ConversationHarnessOptions["now"];
  readonly runtimeOptions?: ConversationHarnessOptions["runtimeOptions"];
  readonly sandboxEngine?: SandboxEngine;
  readonly runtimeOptionsForRequest?: (
    input: ConversationHarnessRuntimeOptionsInput,
  ) => ConversationHarnessRuntimeOptionsExtension | Promise<ConversationHarnessRuntimeOptionsExtension>;
  readonly runtimeOptionsForManualCompaction?: ConversationHarnessOptions["runtimeOptionsForManualCompaction"];
  /** Best-effort diagnostic when the default MemoryRecall endpoint cannot start. */
  readonly onMemoryRecallUnavailable?: (error: unknown) => void;
  /** Best-effort diagnostic when the chronological MemoryJournal endpoint cannot start. */
  readonly onMemoryJournalUnavailable?: (error: unknown) => void;
  /** Best-effort diagnostic when the durable Remember endpoint cannot start. */
  readonly onMemoryRememberUnavailable?: (error: unknown) => void;
  /** Best-effort host diagnostic for post-provider memory write failures. */
  readonly onMemoryWarning?: (message: string) => void;
  /** Startup diagnostic when the optional desktop driver is unavailable. */
  readonly onComputerUseWarning?: (message: string) => void;
  /** Best-effort diagnostic for bounded lifecycle-sidecar write failures. */
  readonly onToolHistoryWarning?: (message: string) => void;
  readonly onSessionEvent?: ConfiguredAgentSessionEventHandler;
  /** Host-only provider settlement window; defaults to 1,000 ms. */
  readonly terminalRecoverySettlementMs?: number;
  /**
   * Factory for a runtime bound to a per-request override model (cron/webhook
   * per-trigger model). Wired by the app so override runtimes share the
   * configured fallback chain and participate in config-reload disposal.
   */
  readonly runtimeForModel?: ConversationHarnessOptions["runtimeForModel"];
  /**
   * App-owned trace-source identity and config-path context retained for local
   * recording callers and host correlation.
   */
  readonly observabilityContext?: {
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  };
}

export interface ConfiguredAgentResponderOptions extends ConfiguredConversationHarnessOptions {}

export interface RunArtifactCommitEvent {
  readonly phase: "started" | "finished";
  readonly runId: string;
  readonly conversationId: string;
  /** Present only for the terminal artifact commit. */
  readonly summary?: RunSummary;
}

export type RunArtifactCommitHook = (event: RunArtifactCommitEvent) => void | Promise<void>;

export interface ConfiguredAgentInternalHooks {
  /**
   * App-owned hook invoked after the local JSONL running/terminal summary is
   * committed. A returned
   * promise is not awaited and all hook failures are ignored.
   */
  readonly onRunArtifactCommitted?: RunArtifactCommitHook;
  /** App-only read decoration around the configured canonical history store. */
  readonly wrapHistoryStore?: (store: ConversationHistoryStore) => ConversationHistoryStore;
  /**
   * Overrides `runtime.session.rollover` for THIS channel's responder. The app
   * builds one responder per channel, and a channel whose conversations already
   * carry an explicit user-owned session boundary (the console's threads) must
   * not have a second one imposed by the calendar.
   */
  readonly sessionRollover?: MonoAgentConfig["runtime"]["session"]["rollover"];
  /** App-published generation and live-controller injection for this channel. */
  readonly processJobs?: {
    readonly registry: ProcessJobsRootRegistrySnapshot;
    readonly service: ProcessJobsServiceHandle | undefined;
    readonly channelId: ChannelId | undefined;
    readonly conversationScheme?: string | undefined;
    readonly protectionPosture: ProcessJobsProtectionPosture;
    readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
  };
  /**
   * App-local bootstrap seam for a configured responder that does not own the
   * ProcessJobs service (currently `tui --local`). Registration happens only
   * after this harness acquires the canonical agent-root owner.
   */
  readonly bootstrapProcessJobs?: {
    readonly settings: ProcessJobsSettings;
    readonly stateDir?: string;
  };
}

/**
 * Inputs local recording needs that are stable across a run. Shared by the
 * channel-run `recorderFactory` and the memory LLM so both produce identical
 * JSONL artifacts. The app-owned observability context remains available to
 * callers for trace-source identity and config-path correlation.
 */
export interface RecorderCompositionDeps {
  readonly artifactDir: string;
  readonly observabilityContext?: ConfiguredConversationHarnessOptions["observabilityContext"];
  readonly onRunArtifactCommitted?: RunArtifactCommitHook;
}

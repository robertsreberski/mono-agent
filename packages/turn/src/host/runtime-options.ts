import type { MonoRuntimeHostOptions, MonoRuntimeLike, RuntimeModelReference, RuntimeRunOptions } from "./runtime-contracts.js";


export interface MonoRuntimeFallbackChainEntry {
  readonly model: RuntimeModelReference;
  /** String pins this route, `null` selects the provider default, omitted inherits the run effort. */
  readonly effort?: string | null;
  /**
   * Total attempts on this route including the first, 1–10. Omitted means a
   * single shot. A retry re-runs the whole logical turn on the same model and
   * only fires for transient provider failures.
   */
  readonly attempts?: number;
}


export interface MonoRuntimeRetryPolicy {
  /** Delay before the first retry; doubles per retry. Defaults to 1000. */
  readonly backoffMs?: number;
  /** Ceiling for the doubled delay. Defaults to 15000. */
  readonly maxBackoffMs?: number;
}


export interface MonoRuntimeAttemptContext {
  readonly model: RuntimeModelReference;
  /** Index of this route in the chain. Stable across same-model retries. */
  readonly attemptIndex: number;
  /** 0 for the first try of a route, then 1, 2, … for each same-model retry. */
  readonly retryIndex: number;
}


export interface MonoRuntimeAttemptResolution {
  /**
   * Optional isolated runtime for this route. It must emit its tool events and
   * settle every live-input lease before `run()` returns: the router stops a
   * retry/backup on that evidence only until it admits the next attempt.
   */
  readonly runtime?: MonoRuntimeLike;
  /** Private per-attempt provider options. These are never copied into router telemetry. */
  readonly options?: Readonly<Record<string, unknown>> & {
    /** The sandbox implementation is owned by createMonoRuntime. */
    readonly sandbox?: never;
    /** Attempt plugins cannot replace the host's durable process-job owner. */
    readonly processJobs?: never;
    readonly ownedForegroundProcesses?: never;
    /** Attempt plugins cannot replace the host's run-bound artifact sink. */
    readonly persistArtifact?: never;
    /** Host conversation replay cannot be supplied by a private route resolver. */
    readonly detachedContext?: never;
  };
  /** Provider-specific projection of the logical tool policy for this attempt. */
  readonly policyOptions?: Readonly<Pick<
    RuntimeRunOptions,
    "allowedTools" | "disallowedTools"
  >>;
  readonly cleanup?: () => void | Promise<void>;
}


export type MonoRuntimeAttemptResolver = (
  context: MonoRuntimeAttemptContext,
) => MonoRuntimeAttemptResolution | undefined | Promise<MonoRuntimeAttemptResolution | undefined>;


export interface CreateMonoRuntimeOptions extends MonoRuntimeHostOptions {
  /** The sandbox implementation is owned and injected by host/create-runtime.ts. */
  readonly sandbox?: never;
  /**
   * Ordered model chain for provider failover. When present, runs are served by
   * the agent-runtime fallback router: the first entry is attempted first and
   * each retryable provider failure advances to the next entry, so callers
   * should put the primary model at index 0. The router overrides the per-run
   * `model` with chain entries; failover details are reported on the result as
   * `failoverHistory`.
   */
  readonly fallbackChain?: readonly MonoRuntimeFallbackChainEntry[];
  /** Backoff shape for same-model retries. Per-route counts live on each chain entry's `attempts`. */
  readonly retry?: MonoRuntimeRetryPolicy;
  /** Private host seam for actual-model provider options and route-owned runtimes. */
  readonly resolveAttempt?: MonoRuntimeAttemptResolver;
  /** Custom routers must explicitly attest that their session owner supports native matching. */
  readonly sessionTurnReconciliation?: "v1";
}

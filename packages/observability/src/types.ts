export interface RuntimeEventLike {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeResultLike {
  readonly cancelled?: boolean;
  readonly error?: string | null;
  readonly failureKind?: string | null;
  /**
   * Per-attempt provider failover detail emitted by the fallback router. Loosely
   * typed here because the router stores ModelRef objects and a `retryableSubkind`
   * field; {@link normalizeFailoverHistory} canonicalizes it into {@link FailoverAttempt}.
   */
  readonly failoverHistory?: unknown;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly durationMs?: number;
  readonly providerSessionId?: string | null;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  /** Model id this run used (e.g. the provider model string). */
  readonly model?: string;
  /** System prompt the main run was driven with (the compiled context prompt). */
  readonly systemPrompt?: string;
  readonly [key: string]: unknown;
}

export type RunSummaryStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export type KnownArtifactFailureKind =
  | "provider_unavailable"
  | "provider_unavailable_exhausted"
  | "usage_limit"
  | "process_death"
  | "runtime_error"
  | "cancelled";

export interface ArtifactAuditFileIssue {
  readonly fileName: string;
  readonly reason: string;
  readonly value?: string;
}

export interface ArtifactFailureKindRate {
  readonly failureKind: KnownArtifactFailureKind;
  readonly count: number;
  readonly rateOfParsedSummaries: number;
  readonly rateOfSummariesWithFailureKind: number;
}

export interface ArtifactAuditReport {
  readonly artifactDir: string;
  readonly totalSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly parseFailureCount: number;
  readonly parseFailures: readonly ArtifactAuditFileIssue[];
  readonly statusHistogram: Readonly<Record<RunSummaryStatus, number>>;
  readonly unrecognizedStatusCount: number;
  readonly unrecognizedStatuses: readonly ArtifactAuditFileIssue[];
  readonly failureKindHistogram: Readonly<Record<KnownArtifactFailureKind, number>>;
  readonly summariesWithFailureKind: number;
  readonly unrecognizedFailureKindCount: number;
  readonly unrecognizedFailureKinds: readonly ArtifactAuditFileIssue[];
  readonly staleRunningCount: number;
  readonly staleRunning: readonly ArtifactAuditFileIssue[];
  readonly failureKindRates: readonly ArtifactFailureKindRate[];
  readonly rateDenominators: {
    readonly parsedSummaries: number;
    readonly summariesWithFailureKind: number;
  };
  readonly warnings: readonly string[];
}

/**
 * One provider attempt recorded by the fallback router when a run fails over.
 * Canonicalized (model reference flattened to a string, `retryableSubkind` →
 * `subkind`) so the persisted shape is stable across router/runtime versions.
 */
export interface FailoverAttempt {
  /** Model reference tried, e.g. "pi:openai-codex:gpt-5.5". */
  readonly model?: string;
  /** Failure kind for this attempt, e.g. "provider_unavailable" or "skipped_capability_mismatch". */
  readonly failureKind?: string;
  /** Retryable sub-classification, e.g. "timeout", "server_error", "overloaded", "rate_limited". */
  readonly subkind?: string;
  /** Provider request id, when the underlying error text carried one. */
  readonly requestId?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
  /**
   * Underlying provider/runtime error message for a failed run (redacted + capped).
   * `failureKind` is the taxonomy label ("provider_unavailable_exhausted"); this is
   * the human-readable "why" (the actual provider message), persisted so the trace
   * shows it instead of only the collapsed kind.
   */
  readonly error?: string;
  /**
   * Per-attempt provider failover detail when the fallback router exhausted its
   * chain. Lets a trace show which models were tried and how each failed, instead
   * of only the collapsed `provider_unavailable_exhausted` kind.
   */
  readonly failoverHistory?: readonly FailoverAttempt[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt?: string;
  readonly durationMs: number;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly providerSessionId?: string | null;
  readonly eventCount: number;
  readonly artifactPaths: readonly string[];
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  /** The user's prompt for this run, persisted so backfill can show it as input. */
  readonly userInput?: string;
  /** Model id this run used; surfaced as `llm.model_name` on the exported span. */
  readonly model?: string;
  /**
   * System instructions for this run (the memory maintenance prompt for memory
   * runs, the compiled identity+skills+memory prompt for channel runs), persisted
   * redacted+truncated so the trace shows what the model was instructed to do.
   */
  readonly systemPrompt?: string;
}

export interface RunRecorder {
  start?(): Promise<RunSummary>;
  onEvent(event: RuntimeEventLike): void;
  finish(result: RuntimeResultLike): Promise<RunSummary>;
  fail(error: unknown): Promise<RunSummary>;
}

export interface RunExportContext {
  readonly runId: string;
  readonly conversationId: string;
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly configPath?: string;
  readonly artifactDir?: string;
  readonly includeSensitiveData: boolean;
  /**
   * The user's prompt for this run, used as the root span's `input.value` so the
   * trace shows what was asked. Available on the live path (threaded from the
   * request); absent for backfill (not recorded in artifacts).
   */
  readonly userInput?: string;
  /**
   * Classifies the run so memory runs are distinguishable from channel runs in
   * Phoenix: drives the root `openinference.span.kind` ("memory" vs "AGENT") and
   * the `mono.agent.run.kind` attribute. Threaded explicitly rather than sniffed
   * from the run-id prefix.
   */
  readonly runKind?: "memory" | "channel";
  /** Memory sub-operation for memory runs: distill|reconcile|entities|reflect|migrate. */
  readonly memoryOperation?: string;
}

export interface RunExportEventContext extends RunExportContext {
  readonly eventIndex: number;
}

export interface RunExporter {
  start?(context: RunExportContext): Promise<void> | void;
  onEvent?(event: RuntimeEventLike, context: RunExportEventContext): Promise<void> | void;
  finish?(summary: RunSummary, context: RunExportContext): Promise<void> | void;
  fail?(summary: RunSummary, error: unknown, context: RunExportContext): Promise<void> | void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface PhoenixExporterConfig {
  readonly type: "phoenix";
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly includeSensitiveData?: boolean;
  readonly timeoutMs?: number;
  /**
   * Phoenix project the traces land in (resource attr `openinference.project.name`).
   * Defaults to the run's trace source label/id, else "default".
   */
  readonly projectName?: string;
}

export type ObservabilityExporterConfig = PhoenixExporterConfig;

export interface JsonlRunRecorderOptions {
  readonly runId: string;
  readonly conversationId: string;
  readonly artifactDir: string;
  readonly clock?: () => number;
  readonly maxStringBytes?: number;
  /** The user's prompt; persisted (redacted) into the summary as `userInput`. */
  readonly userInput?: string;
  /**
   * System instructions for this run; persisted (redacted + capped to a dedicated
   * larger limit than `maxStringBytes`) into the summary as `systemPrompt`. Used by
   * the memory path, which supplies its constant prompt at recorder-creation time.
   */
  readonly systemPrompt?: string;
}

export type RecordedRunEventCategory = "tool" | "thinking" | "message" | "runtime" | "error";

export interface RecordedRunListItem {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
  /** Underlying provider/runtime error message for a failed run (redacted + capped). */
  readonly error?: string;
  /** Per-attempt provider failover detail when the fallback router exhausted its chain. */
  readonly failoverHistory?: readonly FailoverAttempt[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs: number;
  readonly eventCount: number;
  readonly updatedAt: string;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly model?: string;
  readonly providerSessionId?: string | null;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
}

export interface RecordedRunEvent {
  readonly index: number;
  readonly type?: string;
  readonly category: RecordedRunEventCategory;
  readonly timestamp?: string;
  readonly label: string;
  readonly summary: string;
  readonly payload: unknown;
}

export interface RecordedRunTimelineItem extends RecordedRunEvent {
  readonly sourceEventCount: number;
  readonly sourceEventStartIndex: number;
  readonly sourceEventEndIndex: number;
}

export interface RecordedRunDetail {
  readonly summary: RecordedRunListItem;
  readonly events: readonly RecordedRunEvent[];
  readonly warnings: readonly string[];
}

export interface RecordedRunListResult {
  readonly runs: readonly RecordedRunListItem[];
  readonly warnings: readonly string[];
}

export interface JsonlRunReaderOptions {
  readonly artifactDir: string;
  readonly maxRuns?: number;
  readonly maxEventsPerRun?: number;
  readonly maxStringBytes?: number;
}

export type TraceSourceStatus = "running" | "stopped" | "failed";
export type TraceSourceHealth = "running" | "stale" | "stopped" | "failed";

export interface TraceSourceManifest {
  readonly schema: "agent-runtime.trace-source.v1";
  readonly sourceId: string;
  readonly label: string;
  readonly artifactDir: string;
  readonly pid?: number;
  readonly status: TraceSourceStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TraceSourceListItem extends TraceSourceManifest {
  readonly health: TraceSourceHealth;
  readonly warnings: readonly string[];
}

export interface TraceRunListItem extends RecordedRunListItem {
  readonly source: TraceSourceListItem;
}

export interface TraceRunDetail {
  readonly source: TraceSourceListItem;
  readonly run: RecordedRunDetail;
}

export interface TraceSourceRegistryOptions {
  readonly registryDir: string;
  readonly staleAfterMs?: number;
  readonly clock?: () => number;
}

export interface RegisterTraceSourceOptions extends TraceSourceRegistryOptions {
  readonly sourceId?: string;
  readonly label: string;
  readonly artifactDir: string;
  readonly pid?: number;
  readonly status?: TraceSourceStatus;
  readonly startedAt?: string;
  readonly heartbeatMs?: number;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateTraceSourceOptions {
  readonly status?: TraceSourceStatus;
  readonly artifactDir?: string;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TraceSourceHandle {
  readonly manifest: TraceSourceManifest;
  update(patch: UpdateTraceSourceOptions): Promise<TraceSourceManifest>;
  heartbeat(): Promise<TraceSourceManifest>;
  stop(patch?: Omit<UpdateTraceSourceOptions, "status"> & { readonly status?: "stopped" | "failed" }): Promise<TraceSourceManifest>;
}

export interface TraceSourceListResult {
  readonly registryDir: string;
  readonly sources: readonly TraceSourceListItem[];
  readonly warnings: readonly string[];
}

export interface TraceRunListOptions extends TraceSourceRegistryOptions {
  readonly maxRuns?: number;
  readonly maxEventsPerRun?: number;
  readonly maxStringBytes?: number;
}

export interface TraceRunListResult {
  readonly registryDir: string;
  readonly sources: readonly TraceSourceListItem[];
  readonly runs: readonly TraceRunListItem[];
  readonly warnings: readonly string[];
}

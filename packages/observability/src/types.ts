export interface RuntimeEventLike {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeResultLike {
  readonly cancelled?: boolean;
  readonly error?: string | null;
  readonly failureKind?: string | null;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly durationMs?: number;
  readonly providerSessionId?: string | null;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  readonly [key: string]: unknown;
}

export type RunSummaryStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface RunSummary {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
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
}

export type RecordedRunEventCategory = "tool" | "thinking" | "message" | "runtime" | "error";

export interface RecordedRunListItem {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs: number;
  readonly eventCount: number;
  readonly updatedAt: string;
  readonly usage?: unknown;
  readonly cost?: unknown;
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

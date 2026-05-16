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

export type RunSummaryStatus = "succeeded" | "failed" | "cancelled";

export interface RunSummary {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
  readonly durationMs: number;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly providerSessionId?: string | null;
  readonly eventCount: number;
  readonly artifactPaths: readonly string[];
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
}

export interface RunRecorder {
  onEvent(event: RuntimeEventLike): void;
  finish(result: RuntimeResultLike): Promise<RunSummary>;
  fail(error: unknown): Promise<RunSummary>;
}

export interface JsonlRunRecorderOptions {
  readonly runId: string;
  readonly conversationId: string;
  readonly artifactDir: string;
  readonly clock?: () => number;
  readonly maxStringBytes?: number;
}

export type RecordedRunEventCategory = "tool" | "thinking" | "message" | "runtime" | "error";

export interface RecordedRunListItem {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
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

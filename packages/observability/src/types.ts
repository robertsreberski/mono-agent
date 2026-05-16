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

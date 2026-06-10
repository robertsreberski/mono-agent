import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";

export class NoopRunRecorder implements RunRecorder {
  private readonly runId: string;
  private readonly conversationId: string;
  private readonly startedAt = Date.now();
  private eventCount = 0;

  constructor(input: { readonly runId: string; readonly conversationId: string }) {
    this.runId = input.runId;
    this.conversationId = input.conversationId;
  }

  onEvent(_event: RuntimeEventLike): void {
    this.eventCount += 1;
  }

  async start(): Promise<RunSummary> {
    return this.summary("running", undefined, {});
  }

  async finish(result: RuntimeResultLike): Promise<RunSummary> {
    return this.summary(result.cancelled === true ? "cancelled" : result.failureKind !== undefined || result.error !== undefined ? "failed" : "succeeded", result.failureKind ?? undefined, result);
  }

  async fail(error: unknown): Promise<RunSummary> {
    return this.summary("failed", error instanceof Error ? error.name : "exception", {});
  }

  private summary(status: RunSummary["status"], failureKind: string | undefined, result: RuntimeResultLike): RunSummary {
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(failureKind === undefined || failureKind === null || failureKind === "" ? {} : { failureKind }),
      durationMs: Math.max(0, Date.now() - this.startedAt),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.cost === undefined ? {} : { cost: result.cost }),
      ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
      eventCount: this.eventCount,
      artifactPaths: [],
      ...(result.runtimeWarnings === undefined ? {} : { runtimeWarnings: result.runtimeWarnings }),
      ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      ...(result.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: result.capabilitiesUsed }),
    };
  }
}

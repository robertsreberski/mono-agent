import { LIVE_EVENT_SCHEMA } from "@mono-agent/agent-contracts";
import type { RunEventFrame, RunEventSink } from "@mono-agent/agent-contracts";
import { redactJsonValue } from "@mono-agent/observability";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";

/** Stable run context stamped onto every broadcast frame. */
export interface BroadcastRunContext {
  readonly runId: string;
  readonly conversationId: string;
  /** Producing instance's trace-source id (empty when the host has none). */
  readonly sourceId: string;
  readonly sourceLabel?: string;
  /** Trigger channel, e.g. "cron" | "webhook" | "chat" | "memory". */
  readonly source?: string;
  /** Trigger detail (cron job id / webhook endpoint name). */
  readonly sourceDetail?: string;
}

/**
 * Wrap a {@link RunRecorder} so every run start/event/finish is ALSO published to
 * a {@link RunEventSink} (the in-process live bus), giving operator surfaces
 * sub-run visibility the on-disk recorder can't (it flushes only at start/finish).
 *
 * Broadcast is best-effort and additive, exactly like the Phoenix exporter path:
 * the inner recorder is the source of truth for the returned summary, and a
 * publish failure never changes the run outcome (publish is wrapped and the bus's
 * own `publish` is contracted never to throw). `seq` is left 0 here — the bus
 * stamps a process-wide monotonic value on publish.
 */
export function createBroadcastRunRecorder(
  inner: RunRecorder,
  sink: RunEventSink,
  ctx: BroadcastRunContext,
): RunRecorder {
  let eventIndex = 0;
  const publish = (frame: RunEventFrame): void => {
    try {
      sink.publish(frame);
    } catch {
      // Broadcast is best-effort; a sink failure must never break the run.
    }
  };
  const finished = async (summary: RunSummary): Promise<RunSummary> => {
    const redactedSummary = redactJsonValue(summary) as RunSummary;
    publish({
      t: "run_finished",
      schema: LIVE_EVENT_SCHEMA,
      sourceId: ctx.sourceId,
      runId: ctx.runId,
      status: redactedSummary.status,
      summary: redactedSummary,
      seq: 0,
    });
    return summary;
  };
  const recorder: RunRecorder = {
    onEvent(event: RuntimeEventLike): void {
      inner.onEvent(event);
      const redactedEvent = redactJsonValue(event) as RuntimeEventLike;
      publish({
        t: "event",
        schema: LIVE_EVENT_SCHEMA,
        sourceId: ctx.sourceId,
        runId: ctx.runId,
        eventIndex: eventIndex++,
        event: redactedEvent,
        seq: 0,
      });
    },
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      return await finished(await inner.finish(result));
    },
    async fail(error: unknown): Promise<RunSummary> {
      return await finished(await inner.fail(error));
    },
  };
  // `start` is optional on RunRecorder — only expose (and emit run_started) when
  // the inner recorder has one, so callers that probe `recorder.start?.()` behave
  // identically to the unwrapped recorder.
  if (inner.start !== undefined) {
    const innerStart = inner.start.bind(inner);
    recorder.start = async (): Promise<RunSummary> => {
      const summary = await innerStart();
      publish({
        t: "run_started",
        schema: LIVE_EVENT_SCHEMA,
        sourceId: ctx.sourceId,
        ...(ctx.sourceLabel === undefined ? {} : { sourceLabel: ctx.sourceLabel }),
        runId: ctx.runId,
        conversationId: ctx.conversationId,
        ...(ctx.source === undefined ? {} : { source: ctx.source }),
        ...(ctx.sourceDetail === undefined ? {} : { sourceDetail: ctx.sourceDetail }),
        startedAt: summary.startedAt ?? new Date().toISOString(),
        seq: 0,
      });
      return summary;
    };
  }
  return recorder;
}

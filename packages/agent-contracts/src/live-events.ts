/**
 * Live run-event broadcast contract.
 *
 * A running agent taps every run's events off the recorder and publishes them to
 * an in-process {@link RunEventBus}. A loopback SSE channel (the `live` adapter)
 * then fans the bus out to read-only operator surfaces (the `mono-agent web`
 * PWA) so they can visualise a run *mid-flight* — the on-disk recorder only
 * flushes at run start/finish, so this in-process tap is the only source of
 * sub-run granularity.
 *
 * This module is deliberately dependency-free and adapter-neutral: the frame's
 * `event`/`summary` payloads are carried as opaque JSON (`unknown`). The producer
 * side (the agent) stamps them from its runtime/observability types; the consumer
 * side (the web operator surface, which may depend on `@mono-agent/observability`)
 * re-interprets them. Neither the neutral pipe (`live-adapter`, a `communication`
 * package) nor this core contract may depend on observability.
 */

/** Wire/schema version for {@link RunEventFrame}. Bump on a breaking shape change. */
export const LIVE_EVENT_SCHEMA = "live.v1";

/**
 * One frame of the live run-event stream. A single run produces exactly one
 * `run_started`, zero or more `event` frames (in `eventIndex` order), and exactly
 * one `run_finished`. `seq` is a process-wide monotonic counter across *all* runs
 * on the bus, letting a consumer detect a dropped frame (a gap in `seq`).
 */
export type RunEventFrame =
  | {
      readonly t: "run_started";
      readonly schema: typeof LIVE_EVENT_SCHEMA;
      /** Stable id of the producing agent instance (the trace-source `sourceId`). */
      readonly sourceId: string;
      /** Human label of the producing instance, when known. */
      readonly sourceLabel?: string;
      readonly runId: string;
      readonly conversationId: string;
      /** Trigger channel, e.g. "cron" | "webhook" | "chat" | "memory", when known. */
      readonly source?: string;
      /** Trigger detail for `source`, e.g. a cron job id or webhook endpoint name. */
      readonly sourceDetail?: string;
      /** ISO-8601 run start timestamp. */
      readonly startedAt: string;
      readonly seq: number;
    }
  | {
      readonly t: "event";
      readonly schema: typeof LIVE_EVENT_SCHEMA;
      readonly sourceId: string;
      readonly runId: string;
      /** 0-based index of this event within the run (recorder emission order). */
      readonly eventIndex: number;
      /** The raw, already-redacted runtime event. Opaque here; a `RuntimeEventLike`. */
      readonly event: unknown;
      readonly seq: number;
    }
  | {
      readonly t: "run_finished";
      readonly schema: typeof LIVE_EVENT_SCHEMA;
      readonly sourceId: string;
      readonly runId: string;
      /** Terminal run status, e.g. "succeeded" | "failed" | "cancelled" | "interrupted". */
      readonly status: string;
      /** The authoritative final run summary. Opaque here; a `RunSummary`. */
      readonly summary: unknown;
      readonly seq: number;
    };

/** The write end of the bus: where a broadcast recorder publishes frames. */
export interface RunEventSink {
  /** Publish one frame. Must never throw — broadcast is best-effort and additive. */
  publish(frame: RunEventFrame): void;
}

/**
 * In-process pub/sub for {@link RunEventFrame}s. Owned by the app, written by the
 * broadcast recorder (via {@link RunEventSink}), read by the `live` channel driver
 * which relays to loopback SSE subscribers.
 */
export interface RunEventBus extends RunEventSink {
  /**
   * Subscribe to all future frames. Returns an unsubscribe function. A subscriber
   * that throws must not break other subscribers or the publisher.
   */
  subscribe(listener: (frame: RunEventFrame) => void): () => void;
  /**
   * Recent frames retained in a bounded ring buffer, oldest-first — replayed to a
   * late-joining SSE subscriber so it can reconstruct in-flight runs on connect.
   */
  recentFrames(): readonly RunEventFrame[];
}

/** Default bounded ring-buffer size for {@link createLiveEventBus}. */
export const DEFAULT_RUN_EVENT_BUFFER_SIZE = 500;

export interface CreateLiveEventBusOptions {
  /**
   * Size of the bounded ring buffer of recent frames replayed to late-joining
   * subscribers. Must be a positive integer. Defaults to
   * {@link DEFAULT_RUN_EVENT_BUFFER_SIZE}.
   */
  readonly ringBufferSize?: number;
}

/**
 * Create an in-process {@link RunEventBus} — the write/read hub between a broadcast
 * recorder (producer) and the loopback SSE relay (consumer). A zero-dependency core
 * primitive so the host can create the bus without loading any transport adapter.
 *
 * The bus is the single source of monotonicity: producers publish frames with a
 * placeholder `seq` (conventionally `0`), and `publish` stamps a process-wide
 * monotonic `seq` before storing and fanning out — a consumer detects a dropped
 * frame as a gap in `seq` regardless of which run produced it.
 *
 * `publish` never throws: a throwing subscriber is isolated so it can neither break
 * other subscribers nor the publisher.
 */
export function createLiveEventBus(options: CreateLiveEventBusOptions = {}): RunEventBus {
  const ringBufferSize = normalizeRingBufferSize(options.ringBufferSize);
  const ring: RunEventFrame[] = [];
  const listeners = new Set<(frame: RunEventFrame) => void>();
  let nextSeq = 0;

  return {
    publish(frame: RunEventFrame): void {
      const stamped: RunEventFrame = { ...frame, seq: nextSeq++ };
      ring.push(stamped);
      if (ring.length > ringBufferSize) {
        ring.shift();
      }
      // Snapshot listeners so an unsubscribe during fan-out cannot skip a peer,
      // and isolate each subscriber so a throw cannot break the publisher.
      for (const listener of [...listeners]) {
        try {
          listener(stamped);
        } catch {
          // Best-effort broadcast: a faulty subscriber must not affect others.
        }
      }
    },
    subscribe(listener: (frame: RunEventFrame) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recentFrames(): readonly RunEventFrame[] {
      return [...ring];
    },
  };
}

function normalizeRingBufferSize(size: number | undefined): number {
  if (size === undefined) {
    return DEFAULT_RUN_EVENT_BUFFER_SIZE;
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("ringBufferSize must be a positive integer.");
  }
  return size;
}

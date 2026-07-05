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
 * re-interprets them. Neither the neutral operator-adapter live pipe (a
 * `communication` package) nor this core contract may depend on observability.
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
/** Default max serialized frame size retained/broadcast by the live bus. */
export const DEFAULT_RUN_EVENT_MAX_FRAME_BYTES = 1_000_000;

export interface CreateLiveEventBusOptions {
  /**
   * Size of the bounded ring buffer of recent frames replayed to late-joining
   * subscribers. Must be a positive integer. Defaults to
   * {@link DEFAULT_RUN_EVENT_BUFFER_SIZE}.
   */
  readonly ringBufferSize?: number;
  /**
   * Max UTF-8 bytes for one serialized live frame. Oversized opaque event/summary
   * payloads are replaced with a compact sentinel before retention and delivery.
   */
  readonly maxFrameBytes?: number;
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
  const maxFrameBytes = normalizeMaxFrameBytes(options.maxFrameBytes);
  const ring: RunEventFrame[] = [];
  const listeners = new Set<(frame: RunEventFrame) => void>();
  let nextSeq = 0;

  return {
    publish(frame: RunEventFrame): void {
      const stamped = fitFrameWithinBudget({ ...frame, seq: nextSeq++ } as RunEventFrame, maxFrameBytes);
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

function normalizeMaxFrameBytes(size: number | undefined): number {
  if (size === undefined) {
    return DEFAULT_RUN_EVENT_MAX_FRAME_BYTES;
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("maxFrameBytes must be a positive integer.");
  }
  return size;
}

const FRAME_ENCODER = new TextEncoder();

function fitFrameWithinBudget(frame: RunEventFrame, maxFrameBytes: number): RunEventFrame {
  const size = serializedBytes(frame);
  if (size === undefined) {
    return replaceUnserializableFrame(frame, maxFrameBytes);
  }
  if (size <= maxFrameBytes) {
    return frame;
  }
  if (frame.t === "event") {
    return compactFrame(
      {
        ...frame,
        event: {
          type: "live_frame_oversized",
          originalType: eventType(frame.event),
          omittedBytes: size,
        },
      } as RunEventFrame,
      maxFrameBytes,
    );
  }
  if (frame.t === "run_finished") {
    return compactFrame(
      {
        ...frame,
        summary: {
          type: "live_frame_oversized",
          omittedBytes: size,
        },
      } as RunEventFrame,
      maxFrameBytes,
    );
  }
  return compactFrame(
    {
      t: "event",
      schema: frame.schema,
      sourceId: frame.sourceId,
      runId: frame.runId,
      eventIndex: 0,
      event: { type: "live_frame_oversized", originalType: frame.t, omittedBytes: size },
      seq: frame.seq,
    },
    maxFrameBytes,
  );
}

function compactFrame(frame: RunEventFrame, maxFrameBytes: number): RunEventFrame {
  const size = serializedBytes(frame);
  if (size !== undefined && size <= maxFrameBytes) {
    return frame;
  }
  if (frame.t === "event") {
    return {
      t: "event",
      schema: frame.schema,
      sourceId: frame.sourceId,
      runId: frame.runId,
      eventIndex: frame.eventIndex,
      event: { type: "live_frame_oversized" },
      seq: frame.seq,
    };
  }
  if (frame.t === "run_finished") {
    return {
      t: "run_finished",
      schema: frame.schema,
      sourceId: frame.sourceId,
      runId: frame.runId,
      status: frame.status,
      summary: { type: "live_frame_oversized" },
      seq: frame.seq,
    };
  }
  return frame;
}

function replaceUnserializableFrame(frame: RunEventFrame, maxFrameBytes: number): RunEventFrame {
  if (frame.t === "event") {
    return compactFrame(
      {
        ...frame,
        event: {
          type: "live_frame_unserializable",
          originalType: eventType(frame.event),
        },
      } as RunEventFrame,
      maxFrameBytes,
    );
  }
  if (frame.t === "run_finished") {
    return compactFrame(
      {
        ...frame,
        summary: { type: "live_frame_unserializable" },
      } as RunEventFrame,
      maxFrameBytes,
    );
  }
  return frame;
}

function serializedBytes(value: unknown): number | undefined {
  try {
    return FRAME_ENCODER.encode(JSON.stringify(value)).length;
  } catch {
    return undefined;
  }
}

function eventType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

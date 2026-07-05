/**
 * A read-only client for a running agent's `live-adapter` SSE endpoint
 * (`GET <baseUrl>/v1/events`). Modeled on the TUI's `RemoteAgentResponder` reader
 * loop (`packages/tui/src/remote/client.ts`): `fetch` with a streaming body,
 * consumed via `res.body.getReader()` + `TextDecoder`, split into SSE frames on
 * the blank-line separator. `data:` payloads are parsed as {@link RunEventFrame};
 * `: ping` heartbeat comments are ignored. A dropped connection triggers bounded
 * exponential-backoff reconnection until `close()`.
 *
 * HTTP only — this is how the `operator-surface` package reaches a `communication`
 * adapter without importing it.
 */
import { DEFAULT_RUN_EVENT_MAX_FRAME_BYTES, type RunEventFrame } from "@mono-agent/agent-contracts";

export type LiveStreamStatus = "connected" | "disconnected";

export interface LiveStreamLogger {
  warn?(message: string, metadata?: unknown): void;
  error?(message: string, metadata?: unknown): void;
}

export interface ConnectLiveStreamOptions {
  /** The agent's `live` SSE base URL, e.g. `http://127.0.0.1:52789/live`. `/v1/events` hangs off it. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Called for each parsed frame, in arrival order. */
  readonly onFrame: (frame: RunEventFrame) => void;
  /** Called on every connect ("connected") and drop ("disconnected"). */
  readonly onStatus: (status: LiveStreamStatus) => void;
  readonly logger?: LiveStreamLogger;
  readonly fetchImpl?: typeof fetch;
  /** Reconnect backoff floor (ms). Default 500. */
  readonly baseDelayMs?: number;
  /** Reconnect backoff ceiling (ms). Default 10_000. */
  readonly maxDelayMs?: number;
  /**
   * Max consecutive failed reconnect attempts before giving up. Default: unbounded
   * — a live viewer should reconnect for as long as the instance is discovered;
   * the aggregator closes this connection when the instance vanishes. Tests set a
   * small value to bound the loop.
   */
  readonly maxRetries?: number;
}

export interface LiveStreamConnection {
  /** Idempotent: abort the in-flight request and stop reconnecting. */
  close(): void;
}

const SSE_FRAME_SEPARATOR = "\n\n";
const SSE_ENCODER = new TextEncoder();

/**
 * Open a live SSE stream and keep it open (reconnecting on drop) until `close()`.
 * Returns synchronously; the connection is driven by a detached async loop.
 */
export function connectLiveStream(options: ConnectLiveStreamOptions): LiveStreamConnection {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const url = `${baseUrl}/v1/events`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const maxRetries = options.maxRetries;
  const headers: Record<string, string> =
    options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` };

  let closed = false;
  let controller: AbortController | undefined;
  let wakeDelay: (() => void) | undefined;

  const stop = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    controller?.abort();
    wakeDelay?.();
  };

  const loop = async (): Promise<void> => {
    let attempt = 0;
    while (!closed) {
      controller = new AbortController();
      let connected = false;
      try {
        const response = await fetchImpl(url, { headers, signal: controller.signal });
        if (!response.ok || response.body === null) {
          throw new Error(`live endpoint returned ${response.status}${response.body === null ? " (empty body)" : ""}.`);
        }
        connected = true;
        attempt = 0;
        options.onStatus("connected");
        await readFrames(response.body, options.onFrame, options.logger);
        // A clean end means the server closed the stream — fall through to reconnect.
      } catch (error) {
        if (!closed) {
          options.logger?.warn?.("Live stream connection dropped.", {
            baseUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (connected) {
        options.onStatus("disconnected");
      }
      if (closed) {
        break;
      }
      attempt += 1;
      if (maxRetries !== undefined && attempt > maxRetries) {
        options.logger?.error?.("Live stream giving up after exhausting reconnect attempts.", { baseUrl, attempt });
        break;
      }
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs), (wake) => {
        wakeDelay = wake;
      });
      wakeDelay = undefined;
    }
  };

  void loop();
  return { close: stop };
}

/**
 * Drain a streaming SSE body, invoking `onFrame` for each `data:` frame. Splits on
 * the SSE blank-line separator; within a frame, concatenates `data:` lines (per
 * the SSE spec) and ignores comment lines (`:` — the heartbeat). A `data:` payload
 * that fails to parse as JSON is logged and skipped rather than tearing the stream.
 */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: RunEventFrame) => void,
  logger: LiveStreamLogger | undefined,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator = buffered.indexOf(SSE_FRAME_SEPARATOR);
      while (separator !== -1) {
        const block = buffered.slice(0, separator);
        buffered = buffered.slice(separator + SSE_FRAME_SEPARATOR.length);
        emitBlock(block, onFrame, logger);
        separator = buffered.indexOf(SSE_FRAME_SEPARATOR);
      }
      if (!done && SSE_ENCODER.encode(buffered).length > DEFAULT_RUN_EVENT_MAX_FRAME_BYTES) {
        logger?.warn?.("Discarding oversized live SSE buffer.", { maxFrameBytes: DEFAULT_RUN_EVENT_MAX_FRAME_BYTES });
        buffered = "";
      }
      if (done) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function emitBlock(
  block: string,
  onFrame: (frame: RunEventFrame) => void,
  logger: LiveStreamLogger | undefined,
): void {
  const dataParts: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.startsWith("data:")) {
      dataParts.push(line.slice("data:".length).replace(/^ /u, ""));
    }
    // Comment lines (": ping") and field lines we don't consume are ignored.
  }
  if (dataParts.length === 0) {
    return;
  }
  const payload = dataParts.join("\n");
  if (SSE_ENCODER.encode(payload).length > DEFAULT_RUN_EVENT_MAX_FRAME_BYTES) {
    logger?.warn?.("Discarding oversized live SSE frame.", { maxFrameBytes: DEFAULT_RUN_EVENT_MAX_FRAME_BYTES });
    return;
  }
  try {
    onFrame(JSON.parse(payload) as RunEventFrame);
  } catch (error) {
    logger?.warn?.("Discarding unparseable live SSE frame.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(Math.random() * exponential);
}

/** A cancelable delay: resolves after `ms`, or immediately once `register`ed waker fires. */
function sleep(ms: number, register: (wake: () => void) => void): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(), ms);
    timer.unref?.();
    register(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

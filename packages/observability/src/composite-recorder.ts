/**
 * Pure orchestration composite RunRecorder. Wraps a primary recorder (the JSONL
 * run recorder) and an injected best-effort {@link RunExporter}. The JSONL
 * recorder always runs FIRST and its summary is the value returned to the
 * caller, byte-for-byte unchanged. The exporter runs after, bounded by a
 * timeout, and its failures NEVER change the run outcome — they surface only as
 * warnings via the optional `onWarning` callback.
 *
 * Node-free: imports only ./types.js + ./guards.js. The concrete network
 * exporter is injected by agent-host; this module never reaches the transport.
 */

import { errorMessage } from "./guards.js";
import type {
  RunExportContext,
  RunExporter,
  RunRecorder,
  RunSummary,
  RuntimeEventLike,
  RuntimeResultLike,
} from "./types.js";

/** Injectable timer so tests can drive the timeout deterministically. */
export type SetTimer = (fn: () => void, ms: number) => void;

export interface CompositeRunRecorderOptions {
  readonly recorder: RunRecorder;
  readonly exporter: RunExporter;
  readonly context: RunExportContext;
  readonly timeoutMs: number;
  readonly onWarning?: (warning: { readonly phase: string; readonly message: string }) => void;
  readonly setTimer?: SetTimer;
}

const TIMEOUT_SENTINEL = Symbol("composite-export-timeout");

export function createCompositeRunRecorder(options: CompositeRunRecorderOptions): RunRecorder {
  const { recorder, exporter, context, timeoutMs, onWarning } = options;
  const setTimer: SetTimer =
    options.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // Do not keep the event loop alive solely for the export timeout.
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        (handle as { unref: () => void }).unref();
      }
    });

  const events: RuntimeEventLike[] = [];

  function warn(phase: string, message: string): void {
    onWarning?.({ phase, message });
  }

  async function withTimeout(fn: () => Promise<void> | void): Promise<void> {
    if (!(timeoutMs > 0)) {
      await fn();
      return;
    }
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      setTimer(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });
    const result = await Promise.race([Promise.resolve(fn()).then(() => undefined), timeout]);
    if (result === TIMEOUT_SENTINEL) {
      throw new Error(`export timed out after ${timeoutMs}ms`);
    }
  }

  async function bestEffort(phase: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await withTimeout(fn);
    } catch (error) {
      warn(phase, errorMessage(error));
    }
  }

  async function replayEvents(): Promise<void> {
    if (exporter.onEvent === undefined) {
      return;
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) {
        continue;
      }
      await exporter.onEvent(event, { ...context, eventIndex: index });
    }
  }

  const composite: RunRecorder = {
    onEvent(event: RuntimeEventLike): void {
      // JSONL recorder FIRST (synchronous), then buffer for batch export.
      recorder.onEvent(event);
      events.push(event);
    },
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      const summary = await recorder.finish(result);
      await bestEffort("finish", async () => {
        await replayEvents();
        await exporter.finish?.(summary, context);
        await exporter.flush?.();
      });
      return summary;
    },
    async fail(error: unknown): Promise<RunSummary> {
      const summary = await recorder.fail(error);
      await bestEffort("fail", async () => {
        await replayEvents();
        await exporter.fail?.(summary, error, context);
        await exporter.flush?.();
      });
      return summary;
    },
  };

  if (recorder.start !== undefined) {
    composite.start = async (): Promise<RunSummary> => {
      const summary = await recorder.start!();
      await bestEffort("start", () => exporter.start?.(context));
      return summary;
    };
  }

  return composite;
}

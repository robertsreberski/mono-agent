import { randomFillSync } from "node:crypto";

import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExportEventContext,
  RunExporter,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";

import { buildOtlpTraceRequest } from "./otlp-json.js";
import type { OtlpIdFactory } from "./otlp-json.js";
import { postOtlpJson } from "./transport.js";

export const DEFAULT_PHOENIX_ENDPOINT = "http://127.0.0.1:6006/v1/traces";

/**
 * Defense-in-depth transport timeout. The composite recorder owns the primary
 * bounded timeout around the whole export; this is a backstop so a direct caller
 * (or a composite with a very large timeout) still cannot hang forever.
 */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 60_000;

export interface PhoenixRunExporterDeps {
  readonly fetch?: typeof fetch;
  /** Wall clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable id source for hermetic tests; defaults to crypto-random bytes. */
  readonly idFactory?: OtlpIdFactory;
}

function defaultIdFactory(): OtlpIdFactory {
  return {
    traceId: () => randomFillSync(new Uint8Array(16)),
    spanId: () => randomFillSync(new Uint8Array(8)),
  };
}

/**
 * Phoenix preset exporter implementing the {@link RunExporter} contract with
 * batch-on-finish semantics: events are buffered as the composite replays them
 * through `onEvent`, and the entire run is mapped to an OTLP/HTTP+JSON request
 * and POSTed exactly once in `finish`/`fail`.
 *
 * This exporter does NOT swallow errors: a rejected `fetch` or a non-2xx status
 * propagates so the composite recorder's best-effort wrapper records it as a
 * warning without ever failing the run.
 */
export function createPhoenixRunExporter(
  config: PhoenixExporterConfig,
  deps: PhoenixRunExporterDeps = {},
): RunExporter {
  const endpoint = config.endpoint ?? DEFAULT_PHOENIX_ENDPOINT;
  const headers = config.headers;
  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? defaultIdFactory();
  const fetchImpl = deps.fetch;
  // The composite enforces the configured timeout; transport timeout is a backstop.
  const transportTimeoutMs =
    config.timeoutMs !== undefined && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TRANSPORT_TIMEOUT_MS;

  const events: RuntimeEventLike[] = [];
  let startMs: number | undefined;

  async function exportRun(summary: RunSummary, context: RunExportContext): Promise<void> {
    const endMs = now();
    const startedMs = startMs ?? endMs;
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context,
      startTimeUnixNanos: BigInt(Math.trunc(startedMs)) * 1_000_000n,
      endTimeUnixNanos: BigInt(Math.trunc(endMs)) * 1_000_000n,
      idFactory,
    });
    await postOtlpJson({
      endpoint,
      ...(headers === undefined ? {} : { headers }),
      body: request,
      timeoutMs: transportTimeoutMs,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }

  return {
    start(_context: RunExportContext): void {
      startMs = now();
      events.length = 0;
    },
    onEvent(event: RuntimeEventLike, _context: RunExportEventContext): void {
      events.push(event);
    },
    async finish(summary: RunSummary, context: RunExportContext): Promise<void> {
      await exportRun(summary, context);
    },
    async fail(summary: RunSummary, _error: unknown, context: RunExportContext): Promise<void> {
      await exportRun(summary, context);
    },
  };
}

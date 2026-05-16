import { resolve } from "node:path";

import {
  listRecordedRuns,
  readRecordedRun,
  listTraceRuns,
  listTraceSources,
  readTraceRun,
  ObservabilityReadError,
  TraceSourceRegistryError,
} from "@worklab-ai/observability";
import type {
  JsonlRunReaderOptions,
  TraceRunDetail,
  TraceRunListItem,
  TraceSourceListItem,
  TraceRunListOptions,
} from "@worklab-ai/observability";

import type {
  OperatorConsoleObservabilityOptions,
  OperatorConsoleTraceabilityOptions,
} from "./types.js";

const RUN_DETAIL_PREFIX = "/api/traceability/runs/";

export interface TraceabilityRunsApiResponse {
  readonly enabled: boolean;
  readonly registryDir?: string;
  readonly sources: readonly TraceSourceListItem[];
  readonly runs: readonly TraceRunListItem[];
  readonly warnings?: readonly string[];
}

export interface TraceabilityRunApiResponse {
  readonly enabled: boolean;
  readonly registryDir?: string;
  readonly detail?: TraceRunDetail;
  readonly warnings?: readonly string[];
}

interface ResolvedTraceability {
  readonly enabled: boolean;
  readonly registryDir?: string;
  readonly options?: TraceRunListOptions;
  readonly fallback?: FallbackSource;
  readonly warnings: readonly string[];
}

interface FallbackSource {
  readonly source: TraceSourceListItem;
  readonly readerOptions: JsonlRunReaderOptions;
}

export async function traceabilitySourcesResponse(
  options: OperatorConsoleTraceabilityOptions | undefined,
  fallbackObservability: OperatorConsoleObservabilityOptions | undefined,
): Promise<{ readonly status: number; readonly body: TraceabilityRunsApiResponse | { readonly error: string; readonly message: string } }> {
  const resolved = await resolveTraceability(options, fallbackObservability);
  if (!resolved.enabled) {
    return {
      status: 200,
      body: { enabled: false, sources: [], runs: [], warnings: resolved.warnings },
    };
  }
  if (resolved.fallback !== undefined) {
    return {
      status: 200,
      body: {
        enabled: true,
        sources: [resolved.fallback.source],
        runs: [],
        ...(resolved.warnings.length === 0 ? {} : { warnings: resolved.warnings }),
      },
    };
  }
  if (resolved.options === undefined) {
    return { status: 200, body: { enabled: false, sources: [], runs: [], warnings: resolved.warnings } };
  }
  try {
    const result = await listTraceSources(resolved.options);
    const warnings = combineWarnings(resolved.warnings, result.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        registryDir: result.registryDir,
        sources: result.sources,
        runs: [],
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  } catch (error) {
    return traceabilityErrorResponse(error);
  }
}

export async function traceabilityRunsResponse(
  options: OperatorConsoleTraceabilityOptions | undefined,
  fallbackObservability: OperatorConsoleObservabilityOptions | undefined,
): Promise<{ readonly status: number; readonly body: TraceabilityRunsApiResponse | { readonly error: string; readonly message: string } }> {
  const resolved = await resolveTraceability(options, fallbackObservability);
  if (!resolved.enabled) {
    return {
      status: 200,
      body: { enabled: false, sources: [], runs: [], warnings: resolved.warnings },
    };
  }
  if (resolved.fallback !== undefined) {
    const fallback = resolved.fallback;
    const result = await listRecordedRuns(fallback.readerOptions);
    const warnings = combineWarnings(resolved.warnings, result.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        sources: [fallback.source],
        runs: result.runs.map((run) => ({ ...run, source: fallback.source })),
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  }
  if (resolved.options === undefined) {
    return { status: 200, body: { enabled: false, sources: [], runs: [], warnings: resolved.warnings } };
  }
  try {
    const result = await listTraceRuns(resolved.options);
    const warnings = combineWarnings(resolved.warnings, result.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        registryDir: result.registryDir,
        sources: result.sources,
        runs: result.runs,
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  } catch (error) {
    return traceabilityErrorResponse(error);
  }
}

export async function traceabilityRunResponse(
  options: OperatorConsoleTraceabilityOptions | undefined,
  fallbackObservability: OperatorConsoleObservabilityOptions | undefined,
  path: string,
): Promise<{ readonly status: number; readonly body: TraceabilityRunApiResponse | { readonly error: string; readonly message: string } }> {
  const decoded = decodeTraceRunPath(path);
  if (!decoded.ok) {
    return { status: 400, body: { error: "invalid_traceability_id", message: decoded.message } };
  }
  const resolved = await resolveTraceability(options, fallbackObservability);
  if (!resolved.enabled) {
    return { status: 200, body: { enabled: false, warnings: resolved.warnings } };
  }
  if (resolved.fallback !== undefined) {
    if (decoded.sourceId !== resolved.fallback.source.sourceId) {
      return { status: 404, body: { error: "not_found", message: "Trace source was not found." } };
    }
    const run = await readRecordedRun(resolved.fallback.readerOptions, decoded.runId);
    if (run === undefined) {
      return { status: 404, body: { error: "not_found", message: "Recorded run was not found." } };
    }
    const warnings = combineWarnings(resolved.warnings, run.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        detail: { source: resolved.fallback.source, run },
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  }
  if (resolved.options === undefined) {
    return { status: 200, body: { enabled: false, warnings: resolved.warnings } };
  }
  try {
    const detail = await readTraceRun(resolved.options, decoded.sourceId, decoded.runId);
    if (detail === undefined) {
      return { status: 404, body: { error: "not_found", message: "Trace run was not found." } };
    }
    const warnings = combineWarnings(resolved.warnings, detail.run.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        registryDir: resolved.options.registryDir,
        detail,
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  } catch (error) {
    return traceabilityErrorResponse(error);
  }
}

async function resolveTraceability(
  options: OperatorConsoleTraceabilityOptions | undefined,
  fallbackObservability: OperatorConsoleObservabilityOptions | undefined,
): Promise<ResolvedTraceability> {
  if (options !== undefined) {
    let registryDirValue: string | undefined;
    try {
      registryDirValue = typeof options.registryDir === "function" ? await options.registryDir() : options.registryDir;
    } catch (error) {
      return {
        enabled: false,
        warnings: [`Traceability registry directory could not be resolved: ${errorMessage(error)}.`],
      };
    }
    if (registryDirValue === undefined || registryDirValue.trim().length === 0) {
      return { enabled: false, warnings: ["Traceability registry directory is not configured."] };
    }
    const registryDir = resolve(registryDirValue);
    return {
      enabled: true,
      registryDir,
      options: {
        registryDir,
        ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }),
        ...(options.maxEventsPerRun === undefined ? {} : { maxEventsPerRun: options.maxEventsPerRun }),
        ...(options.maxStringBytes === undefined ? {} : { maxStringBytes: options.maxStringBytes }),
        ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      },
      warnings: [],
    };
  }

  const fallback = await resolveFallbackSource(fallbackObservability);
  if (fallback !== undefined) {
    return { enabled: true, fallback, warnings: ["Traceability registry is not configured; showing the local artifact directory only."] };
  }
  return { enabled: false, warnings: ["Traceability is not configured for this console."] };
}

async function resolveFallbackSource(
  options: OperatorConsoleObservabilityOptions | undefined,
): Promise<FallbackSource | undefined> {
  if (options === undefined) {
    return undefined;
  }
  let artifactDirValue: string | undefined;
  try {
    artifactDirValue = typeof options.artifactDir === "function" ? await options.artifactDir() : options.artifactDir;
  } catch {
    return undefined;
  }
  if (artifactDirValue === undefined || artifactDirValue.trim().length === 0) {
    return undefined;
  }
  const artifactDir = resolve(artifactDirValue);
  const now = new Date().toISOString();
  return {
    source: {
      schema: "worklab.trace-source.v1",
      sourceId: "local",
      label: "Local artifacts",
      artifactDir,
      status: "running",
      startedAt: now,
      updatedAt: now,
      health: "running",
      warnings: ["Fallback source from the console's local artifact directory."],
    },
    readerOptions: {
      artifactDir,
      ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }),
      ...(options.maxEventsPerRun === undefined ? {} : { maxEventsPerRun: options.maxEventsPerRun }),
      ...(options.maxStringBytes === undefined ? {} : { maxStringBytes: options.maxStringBytes }),
    },
  };
}

function decodeTraceRunPath(path: string):
  | { readonly ok: true; readonly sourceId: string; readonly runId: string }
  | { readonly ok: false; readonly message: string } {
  if (!path.startsWith(RUN_DETAIL_PREFIX)) {
    return { ok: false, message: "Trace run route is malformed." };
  }
  const parts = path.slice(RUN_DETAIL_PREFIX.length).split("/");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return { ok: false, message: "Source id and run id are required." };
  }
  const sourceId = decodePathPart(parts[0]);
  const runId = decodePathPart(parts[1]);
  if (sourceId === undefined || runId === undefined) {
    return { ok: false, message: "Source id or run id is not valid URL encoding." };
  }
  if (!isSafeId(sourceId) || !isSafeId(runId)) {
    return { ok: false, message: "Source id and run id cannot be empty or contain path separators or '..'." };
  }
  return { ok: true, sourceId, runId };
}

function decodePathPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return undefined;
  }
}

function isSafeId(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function combineWarnings(...groups: readonly (readonly string[] | undefined)[]): readonly string[] | undefined {
  const warnings = groups.flatMap((group) => group ?? []);
  return warnings.length > 0 ? warnings : undefined;
}

function traceabilityErrorResponse(error: unknown): {
  readonly status: number;
  readonly body: { readonly error: string; readonly message: string };
} {
  if (error instanceof TraceSourceRegistryError) {
    return {
      status: error.code === "invalid_source_id" || error.code === "invalid_run_id" ? 400 : 500,
      body: { error: error.code, message: error.message },
    };
  }
  if (error instanceof ObservabilityReadError) {
    return { status: error.code === "invalid_run_id" ? 400 : 500, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: "traceability_failed", message: errorMessage(error) } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { resolve } from "node:path";

import {
  listRecordedRuns,
  ObservabilityReadError,
  readRecordedRun,
} from "@mono-agent/observability";
import type {
  JsonlRunReaderOptions,
  RecordedRunDetail,
  RecordedRunListItem,
} from "@mono-agent/observability";

import type { OperatorConsoleObservabilityOptions } from "./types.js";

const RUN_DETAIL_PREFIX = "/api/observability/runs/";

export interface ObservabilityRunsApiResponse {
  readonly enabled: boolean;
  readonly artifactDir?: string;
  readonly runs: readonly RecordedRunListItem[];
  readonly warnings?: readonly string[];
}

export interface ObservabilityRunApiResponse {
  readonly enabled: boolean;
  readonly artifactDir?: string;
  readonly run?: RecordedRunDetail;
  readonly warnings?: readonly string[];
}

interface ResolvedObservability {
  readonly enabled: boolean;
  readonly artifactDir?: string;
  readonly options?: JsonlRunReaderOptions;
  readonly warnings: readonly string[];
}

export async function observabilityRunsResponse(
  options: OperatorConsoleObservabilityOptions | undefined,
): Promise<{ readonly status: number; readonly body: ObservabilityRunsApiResponse | { readonly error: string; readonly message: string } }> {
  const resolved = await resolveObservability(options);
  if (!resolved.enabled || resolved.options === undefined) {
    return {
      status: 200,
      body: { enabled: false, runs: [], warnings: resolved.warnings },
    };
  }

  try {
    const result = await listRecordedRuns(resolved.options);
    const warnings = combineWarnings(resolved.warnings, result.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        artifactDir: resolved.options.artifactDir,
        runs: result.runs,
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  } catch (error) {
    return observabilityErrorResponse(error);
  }
}

export async function observabilityRunResponse(
  options: OperatorConsoleObservabilityOptions | undefined,
  path: string,
): Promise<{ readonly status: number; readonly body: ObservabilityRunApiResponse | { readonly error: string; readonly message: string } }> {
  const decoded = decodeRunIdFromPath(path);
  if (!decoded.ok) {
    return { status: 400, body: { error: "invalid_run_id", message: decoded.message } };
  }

  const resolved = await resolveObservability(options);
  if (!resolved.enabled || resolved.options === undefined) {
    return {
      status: 200,
      body: { enabled: false, warnings: resolved.warnings },
    };
  }

  try {
    const detail = await readRecordedRun(resolved.options, decoded.runId);
    if (detail === undefined) {
      return { status: 404, body: { error: "not_found", message: "Recorded run was not found." } };
    }
    const warnings = combineWarnings(resolved.warnings, detail.warnings);
    return {
      status: 200,
      body: {
        enabled: true,
        artifactDir: resolved.options.artifactDir,
        run: detail,
        ...(warnings === undefined ? {} : { warnings }),
      },
    };
  } catch (error) {
    return observabilityErrorResponse(error);
  }
}

async function resolveObservability(options: OperatorConsoleObservabilityOptions | undefined): Promise<ResolvedObservability> {
  if (options === undefined) {
    return { enabled: false, warnings: ["Observability is not configured for this console."] };
  }

  let artifactDirValue: string | undefined;
  try {
    artifactDirValue = typeof options.artifactDir === "function" ? await options.artifactDir() : options.artifactDir;
  } catch (error) {
    return {
      enabled: false,
      warnings: [`Observability artifact directory could not be resolved: ${errorMessage(error)}.`],
    };
  }

  if (artifactDirValue === undefined || artifactDirValue.trim().length === 0) {
    return { enabled: false, warnings: ["Observability artifact directory is not configured."] };
  }

  const artifactDir = resolve(artifactDirValue);
  return {
    enabled: true,
    artifactDir,
    options: {
      artifactDir,
      ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }),
      ...(options.maxEventsPerRun === undefined ? {} : { maxEventsPerRun: options.maxEventsPerRun }),
      ...(options.maxStringBytes === undefined ? {} : { maxStringBytes: options.maxStringBytes }),
    },
    warnings: [],
  };
}

function decodeRunIdFromPath(path: string):
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly message: string } {
  if (!path.startsWith(RUN_DETAIL_PREFIX)) {
    return { ok: false, message: "Run id route is malformed." };
  }
  const raw = path.slice(RUN_DETAIL_PREFIX.length);
  if (raw.length === 0) {
    return { ok: false, message: "Run id is required." };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, message: "Run id is not valid URL encoding." };
  }
  if (decoded.trim().length === 0 || decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) {
    return { ok: false, message: "Run id cannot be empty or contain path separators or '..'." };
  }
  return { ok: true, runId: decoded.trim() };
}

function combineWarnings(...groups: readonly (readonly string[])[]): readonly string[] | undefined {
  const warnings = groups.flat();
  return warnings.length > 0 ? warnings : undefined;
}

function observabilityErrorResponse(error: unknown): {
  readonly status: number;
  readonly body: { readonly error: string; readonly message: string };
} {
  if (error instanceof ObservabilityReadError) {
    return { status: error.code === "invalid_run_id" ? 400 : 500, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: "observability_failed", message: errorMessage(error) } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

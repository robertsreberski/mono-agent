// @ts-check

import { existsSync } from "node:fs";
import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_BASH_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import {
  isPathAllowed,
  isWorkdirAllowed,
  workspaceRoot,
} from "./shared/path-resolver.js";
import {
  combinedProcessOutput,
  DEFAULT_PROCESS_BUFFER_BYTES,
  runPreparedProcess,
} from "./shared/process-runner.js";
import { cleanBashEnvironment } from "./shared/bash-environment.js";
import { handOffProcessJob } from "./shared/process-jobs.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { requestToolProcessEnvironment, resolveSandboxPolicy } from "./shared/tool-context.js";

const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/**
 * Legacy Bash timeout normalization. Values up to 600 are seconds; larger
 * values are milliseconds. New callers should use `timeout_ms`.
 */
export function normalizeBashTimeoutMs(value, fallback = DEFAULT_BASH_TIMEOUT_MS) {
  const cap = finitePositiveInteger(fallback, DEFAULT_BASH_TIMEOUT_MS);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return cap;
  const floored = Math.floor(n);
  const milliseconds = floored <= 600 ? floored * 1_000 : floored;
  return Math.max(1_000, Math.min(milliseconds, cap));
}

/**
 * Exact millisecond timeout used by Bash.timeout_ms and Exec.timeout_ms.
 */
export function normalizeProcessTimeoutMs(value, fallback = DEFAULT_BASH_TIMEOUT_MS) {
  const cap = finitePositiveInteger(fallback, DEFAULT_BASH_TIMEOUT_MS);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return cap;
  return Math.max(1, Math.min(Math.floor(n), cap));
}

/**
 * Background process-job timeout: positive-integer milliseconds with no
 * foreground ceiling. A background budget belongs to the host's `processJobs`
 * settings (`maxRuntimeMs`), which clamp it on their own side; reusing the
 * foreground default as a cap here silently discarded the long runtime a caller
 * deliberately asked for. `undefined` means "no explicit request", leaving the
 * host default in force.
 */
export function normalizeBackgroundTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1, Math.floor(n));
}

/**
 * Legacy Bash `timeout` for a background job: the same seconds-vs-milliseconds
 * heuristic as {@link normalizeBashTimeoutMs}, minus the foreground ceiling.
 */
export function normalizeBackgroundBashTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const floored = Math.floor(n);
  return Math.max(1_000, floored <= 600 ? floored * 1_000 : floored);
}

/**
 * Compatibility wrapper retained for direct callers and tests.
 *
 * @param {{command: string, description?: string, timeout?: number, timeout_ms?: number, max_output_chars?: number, workdir?: string, background?: boolean}} params
 * @param {{signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, processJobsController?: import("./shared/process-jobs.js").ProcessJobsController}} [options]
 */
export async function bashToolImpl(params, options = {}) {
  return (await bashToolRun(params, options)).text;
}

/**
 * Structured Bash execution used by the Pi bridge.
 *
 * @param {{command: string, description?: string, timeout?: number, timeout_ms?: number, max_output_chars?: number, workdir?: string, background?: boolean}} params
 * @param {{signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, processJobsController?: import("./shared/process-jobs.js").ProcessJobsController}} [options]
 */
export async function bashToolRun(
  {
    command,
    description,
    timeout,
    timeout_ms,
    max_output_chars,
    workdir,
    background,
  },
  {
    signal,
    sandboxPolicy,
    sandboxEngine,
    ctx,
    processJobsController,
  } = {},
) {
  const startedAt = Date.now();
  if (typeof command !== "string") {
    return failed("Error: Bash command must be a string.", "invalid_command", startedAt);
  }
  if (command.includes("\0")) {
    return failed("Error: Bash command must not contain NUL characters.", "invalid_command", startedAt);
  }
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const pathOptions = { sandboxPolicy: policy, ctx: resolvedCtx };
  if (workdir && !isWorkdirAllowed(workdir, pathOptions)) {
    return failed(`Error: Working directory not allowed: ${workdir}`, "workdir_denied", startedAt);
  }
  const cwd = workspaceRoot(workdir, resolvedCtx);
  if (!isPathAllowed(cwd, workdir, pathOptions)) {
    return failed(`Error: Working directory not allowed: ${cwd}`, "workdir_denied", startedAt);
  }
  if (!existsSync(cwd)) {
    return failed(`Error: Working directory not found: ${cwd}`, "workdir_not_found", startedAt);
  }

  const maxChars = finitePositiveInteger(max_output_chars, DEFAULT_MAX_BASH_OUTPUT_CHARS);
  const legacyTimeoutUsed = timeout_ms === undefined && timeout !== undefined;
  const timeoutMs = timeout_ms === undefined
    ? normalizeBashTimeoutMs(timeout, DEFAULT_BASH_TIMEOUT_MS)
    : normalizeProcessTimeoutMs(timeout_ms, DEFAULT_BASH_TIMEOUT_MS);
  let prepared;
  try {
    prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command: {
        command: "/bin/bash",
        args: ["--noprofile", "--norc", "-c", command],
        cwd,
        env: requestToolProcessEnvironment(resolvedCtx, cleanBashEnvironment()),
      },
    });
  } catch (error) {
    return failed(`Error: ${error?.message || String(error)}`, "sandbox_prepare_failed", startedAt);
  }

  if (background === true && processJobsController) {
    // Deliberately re-derived from the raw params: `timeoutMs` above carries the
    // foreground ceiling, which is not this job's budget.
    const requestedTimeoutMs = timeout_ms !== undefined
      ? normalizeBackgroundTimeoutMs(timeout_ms)
      : normalizeBackgroundBashTimeoutMs(timeout);
    const handedOff = await handOffProcessJob({
      controller: processJobsController,
      tool: "Bash",
      prepared,
      summary: `Bash command (${command.length} characters; content redacted)`,
      description,
      timeoutMs: requestedTimeoutMs,
      maxOutputChars: max_output_chars === undefined ? undefined : maxChars,
      startedAt,
      failed,
    });
    return handedOff.error || !legacyTimeoutUsed
      ? handedOff
      : { ...handedOff, outcome: { ...handedOff.outcome, legacyTimeoutUsed: true } };
  }

  let result;
  let cleanupError;
  try {
    result = await runPreparedProcess(prepared, {
      timeoutMs,
      signal,
      maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
    });
  } finally {
    try {
      await prepared.cleanup?.();
    } catch (error) {
      cleanupError = error;
    }
  }

  const baseOutcome = processOutcome(result, {
    status: "ok",
    code: "ok",
    legacyTimeoutUsed,
  });
  const partial = combinedProcessOutput(result);
  if (result.timedOut) {
    return failedWithOutcome(
      withPartial(`Error: Command timed out after ${timeoutMs}ms`, partial),
      { ...baseOutcome, status: "error", code: "timeout", retryable: false, timedOut: true },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.aborted) {
    return failedWithOutcome(
      withPartial("Error: Command aborted", partial),
      { ...baseOutcome, status: "error", code: "aborted", retryable: false },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.bufferExceeded) {
    return failedWithOutcome(
      withPartial(`Error: Command output exceeded ${DEFAULT_PROCESS_BUFFER_BYTES} bytes`, partial),
      { ...baseOutcome, status: "error", code: "output_limit", retryable: false, truncated: true },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.spawnError) {
    return failedWithOutcome(
      withPartial(`Exit code 1:\n${result.spawnError.message}`, partial),
      { ...baseOutcome, status: "error", code: "spawn_error", retryable: false, exitCode: 1 },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.code !== null && result.code !== 0) {
    return failedWithOutcome(
      withPartial(`Exit code ${result.code}`, partial),
      { ...baseOutcome, status: "error", code: "nonzero_exit", retryable: false },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.signal) {
    return failedWithOutcome(
      withPartial(`Exit code 1:\nCommand terminated by ${result.signal}`, partial),
      { ...baseOutcome, status: "error", code: "signal", retryable: false, exitCode: 1 },
      maxChars,
      resolvedCtx,
    );
  }
  if (cleanupError) {
    return failedWithOutcome(
      withPartial(`Error: Sandbox cleanup failed: ${cleanupError?.message || String(cleanupError)}`, partial),
      { ...baseOutcome, status: "error", code: "cleanup_failed", retryable: false },
      maxChars,
      resolvedCtx,
    );
  }

  return completed(partial, baseOutcome, maxChars, "Bash", resolvedCtx);
}

function finitePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function processOutcome(result, extra = {}) {
  return {
    status: "ok",
    code: "ok",
    retryable: false,
    attempts: 1,
    durationMs: Number(result.durationMs) || 0,
    bytes: Number(result.bytes) || 0,
    truncated: !!result.truncated,
    exitCode: result.code,
    signal: result.signal,
    timedOut: !!result.timedOut,
    ...extra,
  };
}

function withPartial(message, output) {
  return output && output !== "(no output)" ? `${message}\n\nPartial output:\n${output}` : message;
}

function completed(text, outcome, maxChars, label, ctx) {
  const raw = String(text || "(no output)");
  const truncated = raw.length > maxChars || outcome.truncated;
  return {
    text: capChars(raw, { label, maxChars, strategy: "head_tail", ctx }),
    outcome: { ...outcome, truncated },
    error: false,
  };
}

function failed(text, code, startedAt) {
  return {
    text,
    outcome: {
      status: "error",
      code,
      retryable: false,
      attempts: 1,
      durationMs: Date.now() - startedAt,
      bytes: 0,
      truncated: false,
      exitCode: null,
      signal: null,
      timedOut: false,
    },
    error: true,
  };
}

function failedWithOutcome(text, outcome, maxChars, ctx) {
  const completedResult = completed(text, outcome, maxChars, "Bash", ctx);
  return { ...completedResult, error: true };
}

// @ts-check

import { existsSync } from "node:fs";
import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_BASH_OUTPUT_CHARS } from "./shared/constants.js";
import { normalizeProcessTimeoutMs } from "./bash.js";
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
import { handOffProcessJob } from "./shared/process-jobs.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { requestToolProcessEnvironment, resolveSandboxPolicy } from "./shared/tool-context.js";

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_ARGS = 256;

/** @typedef {import("./shared/process-jobs.js").ProcessJobsController} ProcessJobsController */

/**
 * @param {{executable: string, args?: string[], workdir?: string, timeout_ms?: number, max_output_chars?: number, background?: boolean}} params
 * @param {{signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, processJobsController?: ProcessJobsController}} [options]
 */
export async function execToolImpl(params, options = {}) {
  return (await execToolRun(params, options)).text;
}

/**
 * Execute an argv vector directly, without shell parsing.
 *
 * @param {{executable: string, args?: string[], workdir?: string, timeout_ms?: number, max_output_chars?: number, background?: boolean}} params
 * @param {{signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, processJobsController?: ProcessJobsController}} [options]
 */
export async function execToolRun(
  {
    executable,
    args = [],
    workdir,
    timeout_ms,
    max_output_chars,
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
  const executableProblem = validateExecutable(executable);
  if (executableProblem) return failed(executableProblem, "invalid_executable", startedAt);
  const argsProblem = validateArgs(args);
  if (argsProblem) return failed(argsProblem, "invalid_args", startedAt);

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

  const timeoutMs = normalizeProcessTimeoutMs(timeout_ms, DEFAULT_EXEC_TIMEOUT_MS);
  const maxChars = positiveInteger(max_output_chars, DEFAULT_MAX_BASH_OUTPUT_CHARS);
  let prepared;
  try {
    const requestEnvironment = requestToolProcessEnvironment(resolvedCtx);
    prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command: {
        command: executable,
        args: [...args],
        cwd,
        ...(requestEnvironment === undefined ? {} : { env: requestEnvironment }),
      },
    });
  } catch (error) {
    return failed(`Error: ${error?.message || String(error)}`, "sandbox_prepare_failed", startedAt);
  }

  if (background === true && processJobsController) {
    return handOffProcessJob({
      controller: processJobsController,
      tool: "Exec",
      prepared,
      summary: `Exec command (${args.length} argument${args.length === 1 ? "" : "s"}; values redacted)`,
      timeoutMs: timeout_ms === undefined ? undefined : timeoutMs,
      maxOutputChars: max_output_chars === undefined ? undefined : maxChars,
      startedAt,
      failed,
    });
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

  const outcome = {
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
  };
  const partial = combinedProcessOutput(result);
  if (result.timedOut) {
    return finishError(
      withPartial(`Error: Process timed out after ${timeoutMs}ms`, partial),
      { ...outcome, status: "error", code: "timeout", timedOut: true },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.aborted) {
    return finishError(
      withPartial("Error: Process aborted", partial),
      { ...outcome, status: "error", code: "aborted" },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.bufferExceeded) {
    return finishError(
      withPartial(`Error: Process output exceeded ${DEFAULT_PROCESS_BUFFER_BYTES} bytes`, partial),
      { ...outcome, status: "error", code: "output_limit", truncated: true },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.spawnError) {
    return finishError(
      withPartial(`Exit code 1:\n${result.spawnError.message}`, partial),
      { ...outcome, status: "error", code: "spawn_error", exitCode: 1 },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.code !== null && result.code !== 0) {
    return finishError(
      withPartial(`Exit code ${result.code}`, partial),
      { ...outcome, status: "error", code: "nonzero_exit" },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.signal) {
    return finishError(
      withPartial(`Exit code 1:\nProcess terminated by ${result.signal}`, partial),
      { ...outcome, status: "error", code: "signal", exitCode: 1 },
      maxChars,
      resolvedCtx,
    );
  }
  if (cleanupError) {
    return finishError(
      withPartial(`Error: Sandbox cleanup failed: ${cleanupError?.message || String(cleanupError)}`, partial),
      { ...outcome, status: "error", code: "cleanup_failed" },
      maxChars,
      resolvedCtx,
    );
  }
  return finish(partial, outcome, maxChars, resolvedCtx, false);
}

function validateExecutable(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Error: Exec executable must be a non-empty string.";
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    return "Error: Exec executable contains an invalid character.";
  }
  return null;
}

function validateArgs(value) {
  if (!Array.isArray(value)) return "Error: Exec args must be an array of strings.";
  if (value.length > MAX_EXEC_ARGS) return `Error: Exec accepts at most ${MAX_EXEC_ARGS} arguments.`;
  if (value.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
    return "Error: Exec args must contain only strings without NUL characters.";
  }
  return null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function withPartial(message, output) {
  return output && output !== "(no output)" ? `${message}\n\nPartial output:\n${output}` : message;
}

function finish(text, outcome, maxChars, ctx, error) {
  const raw = String(text || "(no output)");
  const truncated = raw.length > maxChars || outcome.truncated;
  return {
    text: capChars(raw, { label: "Exec", maxChars, strategy: "head_tail", ctx }),
    outcome: { ...outcome, truncated },
    error,
  };
}

function finishError(text, outcome, maxChars, ctx) {
  return finish(text, outcome, maxChars, ctx, true);
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

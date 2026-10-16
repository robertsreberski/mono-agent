// @ts-check

import { commandAdmission, commandWorkdir } from "./shared/command-admission.js";
import { runForegroundCommand } from "./shared/foreground-command.js";
import { normalizeBackgroundTimeoutMs, normalizeProcessTimeoutMs } from "./shared/command-timeouts.js";
import { sandboxFailureDiagnostic } from "./shared/sandbox-diagnostics.js";

import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_BASH_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import {
  combinedProcessOutput,
  DEFAULT_PROCESS_BUFFER_BYTES,
} from "./shared/process-runner.js";
import { handOffProcessJob } from "./shared/process-jobs.js";
import { requestToolProcessEnvironment, requireToolContext, resolveSandboxPolicy } from "./shared/tool-context.js";

const MAX_EXEC_ARGS = 256;

/** @typedef {import("./shared/process-jobs.js").ProcessJobsController} ProcessJobsController */

/**
 * @param {{executable: string, args?: string[], workdir?: string, description?: string, timeout_ms?: number, max_output_chars?: number, background?: boolean, wake_on_completion?: boolean}} params
 * @param {{ctx: import("./shared/tool-context.js").ToolContext, signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, toolLimits?: import("../../contracts/policy.js").RuntimeToolLimits, toolCallId?: string, ownedForegroundProcessController?: import("./shared/owned-foreground-process.js").OwnedForegroundProcessController, processJobsController?: ProcessJobsController}} options
 */
export async function execToolImpl(params, options) {
  return (await execToolRun(params, options)).text;
}

/**
 * Execute an argv vector directly, without shell parsing.
 *
 * @param {{executable: string, args?: string[], workdir?: string, description?: string, timeout_ms?: number, max_output_chars?: number, background?: boolean, wake_on_completion?: boolean}} params
 * @param {{ctx: import("./shared/tool-context.js").ToolContext, signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, toolLimits?: import("../../contracts/policy.js").RuntimeToolLimits, toolCallId?: string, ownedForegroundProcessController?: import("./shared/owned-foreground-process.js").OwnedForegroundProcessController, processJobsController?: ProcessJobsController}} options
 */
export async function execToolRun(
  {
    executable,
    args = [],
    workdir,
    description,
    timeout_ms,
    max_output_chars,
    background,
    wake_on_completion,
  },
  options,
) {
  const {
    signal,
    sandboxPolicy,
    sandboxEngine,
    toolLimits,
    ctx,
    processJobsController,
    ownedForegroundProcessController,
    toolCallId,
  } = options ?? {};
  const startedAt = Date.now();
  const admissionFailure = commandAdmission({ background, wakeOnCompletion: wake_on_completion, processJobsController });
  if (admissionFailure) return failed(admissionFailure.text, admissionFailure.code, startedAt);
  const executableProblem = validateExecutable(executable);
  if (executableProblem) return failed(executableProblem, "invalid_executable", startedAt);
  const argsProblem = validateArgs(args);
  if (argsProblem) return failed(argsProblem, "invalid_args", startedAt);

  const resolvedCtx = requireToolContext(ctx);
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const workingDirectory = commandWorkdir(workdir, { sandboxPolicy: policy, ctx: resolvedCtx });
  if (workingDirectory.failure) return failed(workingDirectory.failure.text, workingDirectory.failure.code, startedAt);
  const cwd = workingDirectory.cwd;

  const timeoutMs = normalizeProcessTimeoutMs(timeout_ms, toolLimits?.bashTimeoutMs);
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
      description,
      wakeOnCompletion: wake_on_completion,
      // Re-derived from the raw param: `timeoutMs` carries the foreground
      // ceiling, and a background job is bounded by processJobs instead.
      timeoutMs: timeout_ms === undefined ? undefined : normalizeBackgroundTimeoutMs(timeout_ms),
      maxOutputChars: max_output_chars === undefined ? undefined : maxChars,
      startedAt,
      failed,
    });
  }

  const foreground = await runForegroundCommand({ prepared, controller: ownedForegroundProcessController, tool: "Exec", callId: toolCallId, timeoutMs, signal });
  if (foreground.failure) return failed(foreground.failure.text, foreground.failure.code, startedAt);
  const { result, cleanupError } = foreground;

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
  const sandboxDiagnostic = sandboxFailureDiagnostic(prepared.sandboxed,
    `${result.stderr ?? ""}\n${result.spawnError?.message ?? ""}`);
  if (result.spawnError) {
    return finishError(
      withPartial(`${sandboxDiagnostic?.prefix ?? ""}Exit code 1:\n${result.spawnError.message}`, partial),
      { ...outcome, status: "error", code: sandboxDiagnostic?.code ?? "spawn_error", exitCode: 1 },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.code !== null && result.code !== 0) {
    return finishError(
      withPartial(`${sandboxDiagnostic?.prefix ?? ""}Exit code ${result.code}`, partial),
      { ...outcome, status: "error", code: sandboxDiagnostic?.code ?? "nonzero_exit" },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.signal) {
    return finishError(
      withPartial(`${sandboxDiagnostic?.prefix ?? ""}Exit code 1:\nProcess terminated by ${result.signal}`, partial),
      { ...outcome, status: "error", code: sandboxDiagnostic?.code ?? "signal", exitCode: 1 },
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

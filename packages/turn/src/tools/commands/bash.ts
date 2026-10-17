// @ts-check

import { commandAdmission, commandWorkdir } from "./command-admission.js";
import { runForegroundCommand } from "./foreground-command.js";
import { normalizeBashTimeoutMs, normalizeProcessTimeoutMs, normalizeBackgroundTimeoutMs, normalizeBackgroundBashTimeoutMs } from "./command-timeouts.js";
import { sandboxFailureDiagnostic } from "../shared/sandbox-diagnostics.js";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { DEFAULT_MAX_BASH_OUTPUT_CHARS } from "../shared/constants.js";
import { capChars } from "../shared/output-truncation.js";
import {
  combinedProcessOutput,
  DEFAULT_PROCESS_BUFFER_BYTES,
} from "./process-runner.js";
import { cleanBashEnvironment } from "./bash-environment.js";
import { handOffProcessJob } from "./process-jobs.js";
import { requestToolProcessEnvironment, requireToolContext, resolveSandboxPolicy } from "../shared/tool-context.js";

/**
 * Compatibility wrapper retained for direct callers and tests.
 *
 * @param {{command: string, description?: string, timeout?: number, timeout_ms?: number, max_output_chars?: number, workdir?: string, background?: boolean, wake_on_completion?: boolean}} params
 * @param {{ctx: import("../shared/tool-context.js").ToolContext, signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, toolLimits?: import("../../contracts/policy.js").RuntimeToolLimits, toolCallId?: string, ownedForegroundProcessController?: import("./owned-foreground-process.js").OwnedForegroundProcessController, processJobsController?: import("./process-jobs.js").ProcessJobsController}} options
 */
export async function bashToolImpl(params: { command: string; description?: string; timeout?: number; timeout_ms?: number; max_output_chars?: number; workdir?: string; background?: boolean; wake_on_completion?: boolean }, options: { ctx: import("../shared/tool-context.js").ToolContext; signal?: AbortSignal; sandboxPolicy?: any; sandboxEngine?: any; toolLimits?: import("../../contracts/policy.js").RuntimeToolLimits; toolCallId?: string; ownedForegroundProcessController?: import("./owned-foreground-process.js").OwnedForegroundProcessController; processJobsController?: import("./process-jobs.js").ProcessJobsController }): Promise<any> {
  return (await bashToolRun(params, options)).text;
}

/**
 * Structured Bash execution used by the Pi bridge.
 *
 * @param {{command: string, description?: string, timeout?: number, timeout_ms?: number, max_output_chars?: number, workdir?: string, background?: boolean, wake_on_completion?: boolean}} params
 * @param {{ctx: import("../shared/tool-context.js").ToolContext, signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, toolLimits?: import("../../contracts/policy.js").RuntimeToolLimits, toolCallId?: string, ownedForegroundProcessController?: import("./owned-foreground-process.js").OwnedForegroundProcessController, processJobsController?: import("./process-jobs.js").ProcessJobsController}} options
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
    wake_on_completion,
  }: { command: string; description?: string; timeout?: number; timeout_ms?: number; max_output_chars?: number; workdir?: string; background?: boolean; wake_on_completion?: boolean },
  options: { ctx: import("../shared/tool-context.js").ToolContext; signal?: AbortSignal; sandboxPolicy?: any; sandboxEngine?: any; toolLimits?: import("../../contracts/policy.js").RuntimeToolLimits; toolCallId?: string; ownedForegroundProcessController?: import("./owned-foreground-process.js").OwnedForegroundProcessController; processJobsController?: import("./process-jobs.js").ProcessJobsController },
): Promise<any> {
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
  if (typeof command !== "string") {
    return failed("Error: Bash command must be a string.", "invalid_command", startedAt);
  }
  if (command.includes("\0")) {
    return failed("Error: Bash command must not contain NUL characters.", "invalid_command", startedAt);
  }
  const resolvedCtx = requireToolContext(ctx);
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const workingDirectory = commandWorkdir(workdir, { sandboxPolicy: policy, ctx: resolvedCtx });
  if (workingDirectory.failure) return failed(workingDirectory.failure.text, workingDirectory.failure.code, startedAt);
  const cwd = workingDirectory.cwd;

  const maxChars = finitePositiveInteger(max_output_chars, DEFAULT_MAX_BASH_OUTPUT_CHARS);
  const legacyTimeoutUsed = timeout_ms === undefined && timeout !== undefined;
  const timeoutMs = timeout_ms === undefined
    ? normalizeBashTimeoutMs(timeout, toolLimits?.bashTimeoutMs)
    : normalizeProcessTimeoutMs(timeout_ms, toolLimits?.bashTimeoutMs);
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
      } as import("../../agent/sandbox-seam.js").SandboxCommandSpec,
    });
  } catch (error: any) {
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
      wakeOnCompletion: wake_on_completion,
      timeoutMs: requestedTimeoutMs,
      maxOutputChars: max_output_chars === undefined ? undefined : maxChars,
      startedAt,
      failed,
    } as Parameters<typeof handOffProcessJob>[0]);
    return handedOff.error || !legacyTimeoutUsed
      ? handedOff
      : { ...handedOff, outcome: { ...handedOff.outcome, legacyTimeoutUsed: true } };
  }

  const foreground = await runForegroundCommand({ prepared, controller: ownedForegroundProcessController, tool: "Bash", callId: toolCallId, timeoutMs, signal } as Parameters<typeof runForegroundCommand>[0]);
  if (foreground.failure) return failed(foreground.failure.text, foreground.failure.code, startedAt);
  const { result, cleanupError } = foreground;

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
  const sandboxDiagnostic = sandboxFailureDiagnostic(prepared.sandboxed,
    `${result.stderr ?? ""}\n${result.spawnError?.message ?? ""}`);
  if (result.spawnError) {
    return failedWithOutcome(
      withPartial(`${sandboxDiagnostic?.prefix ?? ""}Exit code 1:\n${result.spawnError.message}`, partial),
      { ...baseOutcome, status: "error", code: sandboxDiagnostic?.code ?? "spawn_error", retryable: false, exitCode: 1 },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.code !== null && result.code !== 0) {
    return failedWithOutcome(
      withPartial(`${sandboxDiagnostic?.prefix ?? ""}Exit code ${result.code}`, partial),
      { ...baseOutcome, status: "error", code: sandboxDiagnostic?.code ?? "nonzero_exit", retryable: false },
      maxChars,
      resolvedCtx,
    );
  }
  if (result.signal) {
    return failedWithOutcome(
      withPartial(`${sandboxDiagnostic?.prefix ?? ""}Exit code 1:\nCommand terminated by ${result.signal}`, partial),
      { ...baseOutcome, status: "error", code: sandboxDiagnostic?.code ?? "signal", retryable: false, exitCode: 1 },
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

function finitePositiveInteger(value: any, fallback: any) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function processOutcome(result: any, extra: any = {}) {
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

function withPartial(message: any, output: any) {
  return output && output !== "(no output)" ? `${message}\n\nPartial output:\n${output}` : message;
}

function completed(text: any, outcome: any, maxChars: any, label: any, ctx: any) {
  const raw = String(text || "(no output)");
  const truncated = raw.length > maxChars || outcome.truncated;
  return {
    text: capChars(raw, { label, maxChars, strategy: "head_tail", ctx }),
    outcome: { ...outcome, truncated },
    error: false,
  };
}

function failed(text: any, code: any, startedAt: any) {
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

function failedWithOutcome(text: any, outcome: any, maxChars: any, ctx: any) {
  const completedResult = completed(text, outcome, maxChars, "Bash", ctx);
  return { ...completedResult, error: true };
}

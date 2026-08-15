// @ts-check

import { types as nodeUtilTypes } from "node:util";

import { startPreparedProcess } from "./process-runner.js";

/**
 * Kernel-local structural controller seam. The typed public interface lives in
 * runtime-adapter; this package deliberately has no workspace dependencies.
 *
 * @typedef {Object} ProcessJobsController
 * @property {(request: {
 *   tool: "Exec"|"Bash",
 *   prepared: import("../../sandbox-seam.js").PreparedSandboxCommand,
 *   summary: string,
 *   timeoutMs?: number,
 *   maxOutputChars?: number,
 *   launch: (options?: {timeoutMs?: number, signal?: AbortSignal, maxBufferBytes?: number, onStdout?: (chunk: Buffer) => void, onStderr?: (chunk: Buffer) => void}) => ReturnType<typeof startPreparedProcess>,
 * }) => Promise<{jobId: string, state: "queued"|"starting"|"running", startedAt: string|null}>} start
 */

/**
 * Transfer one prepared command to the injected host controller. From the
 * instant `start()` is invoked, the controller owns cleanup on every path.
 *
 * @param {{
 *   controller: ProcessJobsController,
 *   tool: "Exec"|"Bash",
 *   prepared: import("../../sandbox-seam.js").PreparedSandboxCommand,
 *   summary: string,
 *   timeoutMs?: number,
 *   maxOutputChars?: number,
 *   startedAt: number,
 *   failed: (text: string, code: string, startedAt: number) => any,
 * }} input
 */
export async function handOffProcessJob({
  controller,
  tool,
  prepared,
  summary,
  timeoutMs,
  maxOutputChars,
  startedAt,
  failed,
}) {
  const ownedPrepared = withCleanupOnce(prepared);
  const boundEnvironment = mergedProcessEnvironment(ownedPrepared.env);
  let launched = false;
  try {
    const result = await controller.start({
      tool,
      prepared: ownedPrepared,
      summary,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
      launch(options = {}) {
        if (launched) throw new Error("Process-job prepared command was already launched.");
        launched = true;
        return startPreparedProcess({ ...ownedPrepared, env: boundEnvironment }, {
          ...options,
          waitForProcessGroup: true,
          exactEnvironment: true,
        });
      },
    });
    if (!validProcessJobStartResult(result)) {
      if (!launched) {
        try {
          await ownedPrepared.cleanup?.();
        } catch {
          return failed(
            `Error: ${PUBLIC_BACKGROUND_START_FAILURES.process_job_cleanup_incomplete}`,
            "process_job_cleanup_incomplete",
            startedAt,
          );
        }
      }
      return failed("Error: Process-job controller returned an invalid start result.", "process_job_controller_invalid", startedAt);
    }
    const payload = {
      job_id: result.jobId,
      state: result.state,
      started_at: result.startedAt,
    };
    return {
      text: JSON.stringify(payload),
      outcome: {
        status: "ok",
        code: "background_started",
        retryable: false,
        attempts: 1,
        durationMs: Date.now() - startedAt,
        bytes: 0,
        truncated: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        background: true,
        ...payload,
      },
      error: false,
    };
  } catch (error) {
    const failure = publicBackgroundStartFailure(error);
    return failed(
      `Error: ${failure.message}`,
      failure.code,
      startedAt,
    );
  }
}

const PUBLIC_BACKGROUND_START_FAILURES = Object.freeze({
  background_unsupported: "Background process jobs are unsupported for this tool call.",
  background_unsupported_channel: "Background process jobs are unsupported for this channel.",
  process_job_disabled: "Process jobs are disabled.",
  process_job_controller_unavailable: "The process-job controller is unavailable.",
  process_job_platform_unsupported: "Process jobs are unsupported on this platform.",
  process_job_not_found: "The process job was not found.",
  process_job_conflict: "The process job is no longer in the required state.",
  process_job_capacity: "Process-job capacity is full.",
  process_job_conversation_capacity: "This conversation reached its process-job capacity.",
  process_job_queue_full: "The process-job queue is full.",
  process_job_queue_expired: "The process job expired before launch.",
  process_job_chain_depth_exceeded: "The process-job chain-depth limit was reached.",
  process_job_spawn_failed: "The process job could not be launched.",
  process_job_failed: "The process job failed.",
  process_job_timeout: "The process job exceeded its runtime limit.",
  process_job_cancelled: "The process job was cancelled.",
  process_job_agent_restarted: "The process job was interrupted by an agent restart.",
  process_job_cleanup_incomplete: "Process-job cleanup could not be confirmed.",
  process_job_store_error: "Process-job storage failed.",
  process_job_wake_failed: "Process-job wake delivery failed.",
  process_job_response_too_large: "The process-job response exceeded its size limit.",
  process_job_invalid: "The process-job request is invalid.",
});

function publicBackgroundStartFailure(error) {
  let code = "process_job_controller_unavailable";
  try {
    if (typeof error === "object" && error !== null && !nodeUtilTypes.isProxy(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor !== undefined
        && Object.prototype.hasOwnProperty.call(descriptor, "value")
        && typeof descriptor.value === "string"
        && Object.prototype.hasOwnProperty.call(PUBLIC_BACKGROUND_START_FAILURES, descriptor.value)) {
        code = descriptor.value;
      }
    }
  } catch {
    // Proxies and revoked proxies are hostile input at this boundary.
  }
  return { code, message: PUBLIC_BACKGROUND_START_FAILURES[code] };
}

function mergedProcessEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

function withCleanupOnce(prepared) {
  if (typeof prepared.cleanup !== "function") return prepared;
  /** @type {Promise<void>|undefined} */
  let cleanup;
  const original = prepared.cleanup;
  return {
    ...prepared,
    cleanup: async () => {
      if (!cleanup) cleanup = Promise.resolve().then(() => original());
      await cleanup;
    },
  };
}

function validProcessJobStartResult(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.jobId !== "string" || value.jobId.trim().length === 0 || value.jobId.length > 256) return false;
  if (value.state !== "queued" && value.state !== "starting" && value.state !== "running") return false;
  if (value.startedAt === null) return true;
  if (typeof value.startedAt !== "string") return false;
  const timestamp = Date.parse(value.startedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value.startedAt;
}

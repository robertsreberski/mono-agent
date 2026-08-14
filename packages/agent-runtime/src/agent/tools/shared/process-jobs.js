// @ts-check

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
        return startPreparedProcess(ownedPrepared, {
          ...options,
          waitForProcessGroup: true,
        });
      },
    });
    if (!validProcessJobStartResult(result)) {
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
    return failed(
      `Error: ${error?.message || String(error)}`,
      typeof error?.code === "string" ? error.code : "process_job_start_failed",
      startedAt,
    );
  }
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

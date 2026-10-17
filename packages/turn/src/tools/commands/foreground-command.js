// One execution/cleanup unit; frontends retain their outcome and text policies.
import { DEFAULT_PROCESS_BUFFER_BYTES, runPreparedProcess } from "./process-runner.js";
import { runOwnedForegroundProcess } from "./owned-foreground-process.js";

/**
 * @param {{prepared: import("../../agent/sandbox-seam.js").PreparedSandboxCommand,
 * controller?: import("./owned-foreground-process.js").OwnedForegroundProcessController,
 * tool: "Bash"|"Exec", callId?: string, timeoutMs: number, signal?: AbortSignal}} options
 */
export async function runForegroundCommand({ prepared, controller, tool, callId, timeoutMs, signal }) {
  let result;
  let cleanupError;
  try {
    result = controller
      ? await runOwnedForegroundProcess({ controller, tool, callId, prepared, timeoutMs, signal })
      : await runPreparedProcess(prepared, { timeoutMs, signal, maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES });
  } catch (error) {
    if (!controller) throw error;
    return { failure: { text: "Error: Owned foreground command could not be completed safely.", code: "owned_process_unavailable" } };
  } finally {
    try {
      // The owned lane keeps cleanup authority, including after rejection or an
      // unresolved process-group exit. Never clean its sandbox from the tool.
      if (!controller) await prepared.cleanup?.();
    } catch (error) {
      cleanupError = error;
    }
  }
  return { result, cleanupError };
}

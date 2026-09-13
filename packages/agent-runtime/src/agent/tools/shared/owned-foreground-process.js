// @ts-check

import { startPreparedProcess } from "./process-runner.js";

/**
 * @typedef {{code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string,
 * aborted: boolean, timedOut: boolean, bufferExceeded: boolean, truncated: boolean,
 * bytes: number, storedBytes: number, spawnError: Error|null, durationMs: number,
 * groupExitConfirmed?: boolean}} OwnedForegroundProcessResult
 */

/**
 * Host-owned awaited command lane; deliberately not a background-job capability.
 * An attempt controller captures its turn/attempt owner out of band.
 * @typedef {Object} OwnedForegroundProcessController
 * @property {(request: {
 *   tool: "Exec"|"Bash", callId: string,
 *   prepared: import("../../sandbox-seam.js").PreparedSandboxCommand,
 *   timeoutMs: number, signal?: AbortSignal,
 *   launch: (options?: {timeoutMs?: number, signal?: AbortSignal, maxBufferBytes?: number}) => ReturnType<typeof startPreparedProcess>
 * }) => Promise<OwnedForegroundProcessResult>} run
 */

/**
 * Each provider invocation obtains a fresh host-bound attempt. Neither the model
 * nor a provider tool-call id may select the owning persistent turn.
 * @typedef {{forAttempt(): OwnedForegroundProcessController}} OwnedForegroundProcesses
 */

/**
 * Transfer cleanup and launch authority before awaiting a foreground result.
 * The target remains gated until the host records process-incarnation evidence.
 * No error in this lane may fall back to an untracked foreground process.
 * @param {{controller: OwnedForegroundProcessController, tool: "Exec"|"Bash", callId?: string,
 * prepared: import("../../sandbox-seam.js").PreparedSandboxCommand,
 * timeoutMs: number, signal?: AbortSignal}} input
 */
export async function runOwnedForegroundProcess({ controller, tool, callId, prepared, timeoutMs, signal }) {
  if (typeof callId !== "string" || !callId.trim() || Buffer.byteLength(callId, "utf8") > 256
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    await prepared.cleanup?.();
    throw new Error("Owned foreground command identity or deadline is invalid.");
  }
  let cleanup;
  const ownedPrepared = {
    ...prepared,
    cleanup: () => (cleanup ??= Promise.resolve().then(() => prepared.cleanup?.())),
  };
  // Bind environment once, just as the background lane does; do not pick up
  // ambient environment changes between sandbox preparation and gated release.
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(prepared.env ?? {})) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  let launched = false;
  const result = await controller.run({
    tool, callId, prepared: ownedPrepared, timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    launch(options = {}) {
      if (launched) throw new Error("Owned foreground command was already launched.");
      launched = true;
      return startPreparedProcess({ ...ownedPrepared, args: [...ownedPrepared.args], env: environment }, {
        ...options,
        timeoutMs: Math.min(timeoutMs, options.timeoutMs ?? timeoutMs),
        signal: options.signal ?? signal,
        waitForProcessGroup: true,
        exactEnvironment: true,
      });
    },
  });
  if (result.groupExitConfirmed === false) throw new Error("Owned foreground command cleanup remains unresolved.");
  return result;
}

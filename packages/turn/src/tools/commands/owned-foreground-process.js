// @ts-check

import { startPreparedProcess } from "./process-runner.js";

/** @typedef {import("../../contracts/process.js").OwnedForegroundProcessController} OwnedForegroundProcessController */
/** @typedef {import("../../contracts/process.js").OwnedForegroundProcesses} OwnedForegroundProcesses */

/**
 * Transfer cleanup and launch authority before awaiting a foreground result.
 * The target remains gated until the host records process-incarnation evidence.
 * No error in this lane may fall back to an untracked foreground process.
 * @param {{controller: OwnedForegroundProcessController, tool: "Exec"|"Bash", callId?: string,
 * prepared: import("../../agent/sandbox-seam.js").PreparedSandboxCommand,
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

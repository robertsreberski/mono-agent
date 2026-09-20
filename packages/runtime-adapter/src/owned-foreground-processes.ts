import type { PreparedSandboxCommand } from "./sandbox.js";
import type { ProcessJobProcessHandle, ProcessJobProcessResult } from "./process-jobs.js";

/** Exact prepared command; the host owns cleanup from run() invocation onward. */
export interface OwnedForegroundProcessRequest {
  readonly tool: "Exec" | "Bash";
  /** Provider call identity within the host-bound attempt, never a model argument. */
  readonly callId: string;
  readonly prepared: PreparedSandboxCommand;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** One-shot gated launch. The host must persist incarnation before release(). */
  readonly launch: (options?: { timeoutMs?: number; signal?: AbortSignal; maxBufferBytes?: number }) => ProcessJobProcessHandle;
}

export interface OwnedForegroundProcessController {
  run(request: OwnedForegroundProcessRequest): Promise<ProcessJobProcessResult>;
}

/** A turn-scoped owner mints an isolated attempt capability for each Pi invocation. */
export interface OwnedForegroundProcesses {
  forAttempt(): OwnedForegroundProcessController;
}

/** Structural bridge, without granting background starts or exposing owner identities. */
export function bridgeOwnedForegroundProcesses(owner: OwnedForegroundProcesses): OwnedForegroundProcesses {
  if (!owner || typeof owner.forAttempt !== "function") throw new TypeError("Owned foreground process owner is invalid.");
  return Object.freeze({
    forAttempt() {
      const attempt = owner.forAttempt();
      if (!attempt || typeof attempt.run !== "function") throw new TypeError("Owned foreground process attempt is invalid.");
      return Object.freeze({
        async run(request: OwnedForegroundProcessRequest) {
          if (!request || !["Exec", "Bash"].includes(request.tool)
            || typeof request.callId !== "string" || !request.callId.trim() || Buffer.byteLength(request.callId, "utf8") > 256
            || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || typeof request.launch !== "function"
            || !request.prepared || typeof request.prepared.command !== "string"
            || !Array.isArray(request.prepared.args) || request.prepared.args.some((arg) => typeof arg !== "string")
            || typeof request.prepared.cwd !== "string" || typeof request.prepared.sandboxed !== "boolean") {
            // No launcher was invoked: rejected prepared state is ours to clean.
            if (typeof request?.prepared?.cleanup === "function") await request.prepared.cleanup();
            throw new TypeError("Owned foreground process request is invalid.");
          }
          return await attempt.run(request);
        },
      });
    },
  });
}

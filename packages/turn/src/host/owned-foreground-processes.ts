import type { ProcessJobProcessResult } from "#turn/contracts/process";
import type { ProcessJobProcessHandle } from "#turn/contracts/process";
import type { OwnedForegroundProcessRequest } from "#turn/contracts/process";
import type { OwnedForegroundProcessController } from "#turn/contracts/process";
import type { OwnedForegroundProcesses } from "#turn/contracts/process";
export type { OwnedForegroundProcessRequest } from "#turn/contracts/process";

export type { OwnedForegroundProcessController } from "#turn/contracts/process";

export type { OwnedForegroundProcesses } from "#turn/contracts/process";


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

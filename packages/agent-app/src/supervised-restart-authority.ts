import type { TuiRestartAuthority, TuiRestartSupport } from "@mono-agent/operator-adapter";
import { createSupervisedRestartLatch, type SupervisedRestartLatch } from "./supervised-restart-latch.js";
import { verifySupervisedRestart, type SupervisedRestartDeps } from "./supervised-restart.js";

/** Installed only in a supervised CLI worker; verification is fresh on each info read and POST. */
export function createSupervisedRestartAuthority(deps: SupervisedRestartDeps, latch: SupervisedRestartLatch = createSupervisedRestartLatch()): TuiRestartAuthority {
  let current: TuiRestartSupport | undefined;
  return {
    async verify() {
      const verdict = await verifySupervisedRestart(deps);
      current = verdict;
      return verdict;
    },
    accept(verified) {
      // Only the exact latest verification object produced by this authority
      // can be committed; another in-flight check cannot replace its token.
      // An already-accepted operation always returns its immutable id, even
      // when a later supervisor probe fails or races another info read.
      if (verified !== current || verified.supported !== true) {
        const existing = latch.accept({ supported: false });
        if (existing.kind === "conflict") return existing;
        return { kind: "refused", reason: verified === current
          ? verified.reason ?? "Supervisor verification failed."
          : "Supervisor verification is no longer current." };
      }
      current = undefined;
      return latch.accept(verified);
    },
    processIdentity: () => ({ pid: deps.pid ?? process.pid, startedAt: deps.startedAt }),
    beginStop: (operationId) => latch.beginStop(operationId),
  };
}

import { randomUUID } from "node:crypto";
import type { TuiRestartAcceptance, TuiRestartSupport } from "@mono-agent/operator-adapter";

/** A single host-owned lifecycle disposition; no promise or response callback participates in acceptance. */
export interface SupervisedRestartLatch {
  accept(verified: TuiRestartSupport): TuiRestartAcceptance;
  signal(): void;
  beginStop(operationId: string): void;
  onStop(callback: () => void): void;
  readonly exitCode: number;
}

export const AGENT_RESTART_EXIT_CODE = 42;
export const AGENT_RESTART_EXIT_FALLBACK_MS = 10_000;

/** Graceful exit wins normally; only a leaked referenced handle needs forced relaunch. */
export function armAcceptedRestartExitFallback(options: {
  readonly exit?: (code: number) => void;
  readonly schedule?: (handler: () => void, ms: number) => NodeJS.Timeout;
} = {}): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timer = (options.schedule ?? setTimeout)(() => exit(AGENT_RESTART_EXIT_CODE), AGENT_RESTART_EXIT_FALLBACK_MS);
  timer.unref();
}

export function createSupervisedRestartLatch(): SupervisedRestartLatch {
  let phase: "available" | "accepted" | "stopping" | "stopping-without-restart" = "available";
  let operationId: string | undefined;
  let disposition = 0;
  let stopRequested = false;
  let stopStarted = false;
  let stopCallback: (() => void) | undefined;
  const dispatch = (): void => {
    if (!stopRequested || stopStarted || stopCallback === undefined) return;
    stopStarted = true;
    stopCallback();
  };
  return {
    accept(verified) {
      if (operationId !== undefined) return { kind: "conflict", operationId };
      if (phase !== "available") return { kind: "refused", reason: "The agent is already stopping." };
      if (verified.supported !== true) return { kind: "refused", reason: verified.reason ?? "Supervisor verification failed." };
      // Atomic host-owned acceptance: both immutable identity and nonzero exit
      // disposition commit before the adapter may send 202.
      operationId = randomUUID();
      disposition = AGENT_RESTART_EXIT_CODE;
      phase = "accepted";
      return { kind: "accepted", operationId };
    },
    signal() {
      if (phase === "available") phase = "stopping-without-restart";
      if (phase === "accepted") phase = "stopping";
      stopRequested = true;
      dispatch();
    },
    beginStop(id) {
      if (operationId !== id) return;
      phase = "stopping";
      stopRequested = true;
      dispatch();
    },
    onStop(callback) {
      stopCallback = callback;
      dispatch();
    },
    get exitCode() { return disposition; },
  };
}

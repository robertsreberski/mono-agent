import type { AdvisorStopReason } from "./run.js";

export class AdvisorCancellationError extends Error {
  readonly reason: AdvisorStopReason;

  constructor(reason: AdvisorStopReason) {
    super(`Advisor run cancelled: ${reason}.`);
    this.name = "AdvisorCancellationError";
    this.reason = reason;
  }
}

export function abortAdvisorRun(controller: AbortController, reason: AdvisorStopReason): void {
  if (!controller.signal.aborted) {
    controller.abort(new AdvisorCancellationError(reason));
  }
}

export function advisorStopReason(
  value: unknown,
  fallback: AdvisorStopReason = "client_cancelled",
): AdvisorStopReason {
  return value instanceof AdvisorCancellationError ? value.reason : fallback;
}

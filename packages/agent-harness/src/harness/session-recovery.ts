import type { RuntimeResult } from "@mono-agent/runtime-adapter";

/** First gate that declined a terminal turn's native recovery. */
export type TerminalRecoverySkipReason =
  | "history_not_coordinated" | "history_ownership_transferred" | "store_capability"
  | "attempt_not_coordinated" | "runtime_unsupported" | "tool_history_finalize_failed"
  | "failure_budget_spent" | "settlement_timeout" | "failure_kind_not_recoverable"
  | "post_seal_contradiction" | "receipt_missing" | "receipt_mismatch"
  | "recover_returned_false" | "recover_threw";

/** Only a first primary attempt can prove ownership of a recoverable tail. */
export function terminalFailureCanRecover(result: RuntimeResult, outcome: "cancelled" | "failed"): boolean {
  const history = result.failoverHistory;
  if (history != null && !Array.isArray(history)) return false;
  if (Array.isArray(history)) {
    if (history.length > 1) return false;
    if (history.some((attempt) => !attempt || typeof attempt !== "object" || (attempt.retryIndex !== undefined && attempt.retryIndex !== 0)
      || attempt.failureKind !== "provider_unavailable" && !["cancelled", "cancelled_user"].includes(attempt.failureKind))) return false;
  }
  if (outcome === "cancelled") {
    return !result.failureKind || ["cancelled", "cancelled_user", "provider_unavailable", "provider_unavailable_exhausted"].includes(result.failureKind);
  }
  return result.failureKind === "provider_unavailable"
    || (result.failureKind === "provider_unavailable_exhausted" && Array.isArray(history) && history.length === 1);
}

export async function waitForTerminalSettlement(settlement: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

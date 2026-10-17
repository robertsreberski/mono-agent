import type { NativeSessionState } from "./session-lifecycle.js";
// @ts-check
import { repairInterruptedSession } from "./interruption.js";
/** @param {import("./session-lifecycle.js").NativeSessionState} state
 * @param {{action:"sync"|"repair-interrupted"|"fail-suspended"}} options
 * @returns {Promise<{status:"synced"|"repaired"|"sealed"}>} */
export async function settleNativeSession(state: NativeSessionState, { action }: { action: "sync" | "repair-interrupted" | "fail-suspended"; }): Promise<{
    status: "synced" | "repaired" | "sealed";
}> {
  const raw = state.session.rawSession;
  if (action === "sync") { await raw.sync(); return { status: "synced" }; }
  if (action === "repair-interrupted") { await repairInterruptedSession(raw); return { status: "repaired" }; }
  if (action !== "fail-suspended") throw new TypeError("Invalid native settlement action");
  state.retainRecoveryTail = false;
  state.sessionEntry.recoveryPending = false; delete state.sessionEntry.recovery;
  for (const operation of (await raw.getOpenOperations()).reverse()) await raw.closeOperation(operation.operationId, "failed");
  for (const turn of await raw.getOpenTurns()) await raw.endTurn(turn.turnId, "failed");
  await raw.sync();
  return { status: "sealed" };
}

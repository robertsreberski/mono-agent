// @ts-check
// One pure selection plan for durable stores and frozen evidence views. Outcome
// materialization stays with the caller (queued I/O versus already-read bytes).
/** @param {{tip:string|null, visible:Set<string>, interruptions:Iterable<any>, validator:any, timestamp:(id:string)=>number}} input */
export function planRepairEntries({ tip, visible, interruptions, validator, timestamp }) {
  const repairs = [...interruptions].filter((repair) => repair.tipId === null ? tip === null : visible.has(repair.tipId))
    .map((repair) => ({ ...structuredClone(repair), calls: (repair.calls ?? []).filter((call) =>
      !["error", "aborted", "deferred"].includes(validator.contextInfo.get(call.messageId)?.stopReason))
      .map((call) => ({ ...structuredClone(call), timestamp: repair.timestamp })) }));
  const covered = new Set(repairs.flatMap((repair) => repair.calls.map((call) => `${call.operationId}\0${call.callId}`)));
  const byOperation = new Map();
  for (const repair of repairs) for (const id of repair.operationIds) byOperation.set(id, repair);
  const additions = [];
  // Match the store's original last-account rule and source-message timestamp.
  for (const call of validator.calls.values()) {
    const end = validator.operations.get(call.operationId)?.end;
    if (call.placed || call.admission !== "started" || !end || !visible.has(call.messageId)
      || ["error", "aborted", "deferred"].includes(validator.contextInfo.get(call.messageId)?.stopReason)
      || !byOperation.has(call.operationId) || covered.has(`${call.operationId}\0${call.callId}`)) continue;
    additions.push({ account: byOperation.get(call.operationId), call: { ...structuredClone(call),
      cause: end.payload.status === "aborted" ? "user_interrupted" : "crashed", timestamp: timestamp(call.messageId) } });
  }
  return { repairs, additions };
}

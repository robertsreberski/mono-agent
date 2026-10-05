import { createHash } from "node:crypto";

export class NativeSuspendedError extends Error {
  constructor() { super("Native provider suspended this operation; it has not been resumed"); this.name = "NativeSuspendedError"; }
}
export const isExecutableAssistant = (message) => message?.role === "assistant"
  && !["error", "aborted", "deferred"].includes(message.stopReason);

/** Append one idempotent operation account, never a tool result/success receipt. */
export async function recordInterruption(store, turnId, cause, operationIds) {
  for (const operationId of operationIds.length ? operationIds : [null]) {
    const key = `${turnId}\0${operationId ?? ""}`;
    if (store.interruptedOperations.has(key)) continue;
    const calls = [...store.validator.calls.values()].filter((call) => call.turnId === turnId && call.operationId === operationId && !call.placed
      && !["error", "aborted", "deferred"].includes(store.validator.contextInfo.get(call.messageId)?.stopReason))
      .map((call) => ({ callId: call.callId, name: call.name, operationId: call.operationId,
        messageId: call.messageId, admission: call.admission,
        cause: call.result ? "observed_outcome" : call.admission !== "started" ? "skipped" : cause }));
    await store.write("interruption", { cause, operationIds: operationId === null ? [] : [operationId], calls, tipId: store.tip, draftLossPossible: true },
      { turnId, id: `repair:${createHash("sha256").update(key).digest("hex")}` });
    await store.sync();
  }
}

/** Storage-only reopen: no model/tool execution and no inferred completion. */
export async function repairInterruptedSession(store, cause = "crashed") {
  if (!["crashed", "user_interrupted", "skipped", "superseded"].includes(cause)) throw new TypeError("Invalid native interruption cause");
  const turns = await store.getOpenTurns();
  if (!turns.length) return { repaired: false };
  const suspended = new Set([...store.validator.contextInfo.values()].filter((entry) => entry.stopReason === "deferred").map((entry) => entry.operationId));
  for (const turn of turns) {
    const operationIds = store.validator.turns.get(turn.turnId).operations;
    const openIds = operationIds.filter((id) => !store.validator.operations.get(id)?.end);
    const accounts = openIds.length ? openIds : operationIds.slice(-1);
    for (const id of accounts.length ? accounts : [null]) {
      await recordInterruption(store, turn.turnId, suspended.has(id) ? "suspended_not_resumed" : cause, id === null ? [] : [id]);
    }
    for (const op of (await store.getOpenOperations()).reverse()) {
      if (op.turnId === turn.turnId) await store.closeOperation(op.operationId, "interrupted");
    }
    await store.endTurn(turn.turnId, "interrupted"); await store.sync();
  }
  return { repaired: true };
}

const causeText = {
  crashed: "Execution stopped unexpectedly. Its outcome is unknown; check whether it took effect before deciding what to do next.",
  user_interrupted: "Execution was interrupted by the user. Do not automatically repeat it; check whether it took effect if necessary.",
  skipped: "This call was skipped before host invocation and was not executed.",
  superseded: "This work was superseded. Do not automatically execute or repeat it.",
  suspended_not_resumed: "The provider operation was suspended, not resumed. No deferred continuation was executed; wait for the next user message.",
};

/** Synthetic prompt evidence only. Native storage and receipts remain untouched. */
export function projectInterruptions(messages, repairs = [], messageIds = new WeakMap()) {
  const result = [], noticesByTip = new Map(), evidenceByMessage = new Map();
  for (const repair of repairs) {
    const notices = noticesByTip.get(repair.tipId) ?? []; notices.push(repair); noticesByTip.set(repair.tipId, notices);
    for (const call of repair.calls ?? []) {
      const evidence = evidenceByMessage.get(call.messageId) ?? new Map();
      evidence.set(`${call.callId}\0${call.name}`, call); evidenceByMessage.set(call.messageId, evidence);
    }
  }
  appendNotices(result, noticesByTip.get(null) ?? []);
  let pending = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") pending = new Set(isExecutableAssistant(message) && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "toolCall").map((call) => `${call.id}\0${call.name}`) : []);
    else if (message.role !== "toolResult") pending.clear();
    // Old checkpoints can contain synthetic results from non-executable drafts.
    // Never let those orphan projection-only envelopes reach provider serializers.
    if (message.role === "toolResult" && message.projectionOnly && !pending.has(`${message.toolCallId}\0${message.toolName}`)) continue;
    result.push(message);
    const notices = noticesByTip.get(messageIds.get(message)) ?? [];
    if (!isExecutableAssistant(message) || !Array.isArray(message.content)) { appendNotices(result, notices); continue; }
    const placed = new Set();
    for (let next = index + 1; next < messages.length && messages[next].role === "toolResult"; next += 1) placed.add(`${messages[next].toolCallId}\0${messages[next].toolName}`);
    const evidence = evidenceByMessage.get(messageIds.get(message));
    for (const call of message.content.filter((part) => part.type === "toolCall")) {
      const key = `${call.id}\0${call.name}`; if (placed.has(key)) continue;
      const account = evidence?.get(key); if (!account) continue;
      result.push(account.returned ? { ...account.returned, projectionOnly: true }
        : { role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: [{ type: "text", text: causeText[account.cause] ?? causeText.crashed }], isError: true,
          timestamp: account.timestamp, projectionOnly: true, interruptionCause: account.cause });
    }
    appendNotices(result, notices);
  }
  return result;
}
function appendNotices(result, notices) {
  for (const repair of notices) result.push({ role: "user", content: [{ type: "text", text: `${repair.cause === "suspended_not_resumed" ? causeText.suspended_not_resumed : "Native execution was interrupted."} Completed evidence is preserved, no tool was replayed, and any non-durable streamed draft may have been lost. Continue only in response to the next user message.` }],
    timestamp: repair.timestamp, projectionOnly: true, interruptionCause: repair.cause });
}

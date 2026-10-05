import { createHash } from "node:crypto";

export class NativeSuspendedError extends Error {
  constructor() { super("Native session is suspended; provider-owned deferred continuation is required"); this.name = "NativeSuspendedError"; }
}

/** Append an idempotent account, never a tool result or a successful receipt. */
export async function recordInterruption(store, turnId, cause, operationIds) {
  if (store.interruptions.has(turnId)) return;
  const calls = [...store.validator.calls.values()].filter((call) => call.turnId === turnId && !call.placed)
    .map((call) => ({ callId: call.callId, name: call.name, operationId: call.operationId,
      messageId: call.messageId, admission: call.admission,
      cause: call.result ? "observed_outcome" : call.admission !== "started" ? "skipped" : cause }));
  await store.write("interruption", { cause, operationIds, calls, tipId: store.tip, draftLossPossible: true },
    { turnId, id: `repair:${createHash("sha256").update(turnId).digest("hex")}` });
  await store.sync();
}

/** Storage-only reopen: no model/tool execution and no inferred completion. */
export async function repairInterruptedSession(store, cause = "crashed") {
  if (!["crashed", "user_interrupted", "skipped", "superseded"].includes(cause)) throw new TypeError("Invalid native interruption cause");
  const turns = await store.getOpenTurns();
  if (!turns.length) return { repaired: false };
  // A deferred envelope is suspension, not an interrupted execution. Do not
  // fabricate its outcome or permit a new logical turn over its continuation.
  const entries = await store.getEntries();
  if (entries.some((entry) => entry.type === "message" && entry.message.stopReason === "deferred"
    && store.validator.contextInfo.get(entry.id)?.operationId
    && store.validator.openOperations.has(store.validator.contextInfo.get(entry.id).operationId))) throw new NativeSuspendedError();
  for (const turn of turns) {
    const operationIds = store.validator.turns.get(turn.turnId).operations;
    await recordInterruption(store, turn.turnId, cause, [...operationIds]);
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
};

/** Synthetic prompt evidence only. Native storage and receipts remain untouched. */
export function projectInterruptions(messages, repairs = [], messageIds = new WeakMap()) {
  if (!repairs.length) return messages;
  const result = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]; result.push(message);
    const notices = repairs.filter((item) => item.tipId === messageIds.get(message));
    if (message.role !== "assistant" || !Array.isArray(message.content)) { appendNotices(result, notices); continue; }
    const following = [];
    for (let next = index + 1; next < messages.length && messages[next].role === "toolResult"; next += 1) following.push(messages[next]);
    for (const call of message.content.filter((part) => part.type === "toolCall")) {
      if (following.some((placed) => placed.toolCallId === call.id && placed.toolName === call.name)) continue;
      const evidence = [...repairs].reverse().flatMap((repair) => repair.calls ?? []).find((item) => item.callId === call.id && item.name === call.name && item.messageId === messageIds.get(message));
      if (!evidence) continue;
      result.push(evidence.returned ? { ...evidence.returned, projectionOnly: true }
        : { role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: [{ type: "text", text: causeText[evidence.cause] ?? causeText.crashed }], isError: true,
          timestamp: evidence.timestamp, projectionOnly: true, interruptionCause: evidence.cause });
    }
    appendNotices(result, notices);
  }
  return result;
}
function appendNotices(result, notices) {
  for (const repair of notices) result.push({ role: "user", content: [{ type: "text", text: "Native execution was interrupted. Completed evidence is preserved, no tool was replayed, and any non-durable streamed draft may have been lost. Continue only in response to the next user message." }],
    timestamp: repair.timestamp, projectionOnly: true, interruptionCause: repair.cause });
}

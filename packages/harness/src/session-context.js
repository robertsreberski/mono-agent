import { projectInterruptions } from "./interruption.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "./compaction-kit/messages.js";

const isContextMessage = (message) => message?.role !== "assistant"
  || !["error", "aborted", "deferred"].includes(message.stopReason);

export function buildHarnessSessionContext(pathEntries, { includeFailed = false, repairs = [] } = {}) {
  let start = 0;
  for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
    if (pathEntries[index]?.type === "compaction") { start = index; break; }
  }
  const messages = []; const messageIds = new WeakMap();
  for (const entry of pathEntries.slice(start)) {
    if (entry?.type === "message") {
      if (includeFailed || isContextMessage(entry.message)) { messages.push(entry.message); messageIds.set(entry.message, entry.id); }
    } else if (entry?.type === "compaction") {
      messages.push(entry.checkpoint?.summaryMessage ?? createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
      messages.push(...(includeFailed ? entry.retainedTail || [] : (entry.retainedTail || []).filter(isContextMessage)));
    } else if (entry?.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  }
  const visible = new Set(messages); const anchors = new Map(); let previousVisibleId = null;
  for (const entry of pathEntries.slice(start)) {
    if (entry.type === "message" && visible.has(entry.message)) previousVisibleId = entry.id;
    anchors.set(entry.id, previousVisibleId);
  }
  const projectedRepairs = repairs.flatMap((repair) => {
    const anchor = anchors.get(repair.tipId);
    return anchors.has(repair.tipId) || (repair.tipId === null && start === 0) ? [{ ...repair, tipId: anchor ?? null }] : [];
  });
  return projectInterruptions(messages, projectedRepairs, messageIds);
}

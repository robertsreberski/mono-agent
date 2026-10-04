import { createBranchSummaryMessage, createCompactionSummaryMessage } from "./compaction-kit/messages.js";

const isContextMessage = (message) => message?.role !== "assistant"
  || !["error", "aborted", "deferred"].includes(message.stopReason);

export function buildHarnessSessionContext(pathEntries, { includeFailed = false } = {}) {
  let start = 0;
  for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
    if (pathEntries[index]?.type === "compaction") { start = index; break; }
  }
  const messages = [];
  for (const entry of pathEntries.slice(start)) {
    if (entry?.type === "message") {
      if (includeFailed || isContextMessage(entry.message)) messages.push(entry.message);
    } else if (entry?.type === "compaction") {
      messages.push(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
      messages.push(...(includeFailed ? entry.retainedTail || [] : (entry.retainedTail || []).filter(isContextMessage)));
    } else if (entry?.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  }
  return messages;
}

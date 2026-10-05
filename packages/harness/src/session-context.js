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
      if (includeFailed || isContextMessage(entry.message) || (repairs.length && entry.message.content?.some?.((part) => part.type === "toolCall"))) { messages.push(entry.message); messageIds.set(entry.message, entry.id); }
    } else if (entry?.type === "compaction") {
      messages.push(entry.checkpoint?.summaryMessage ?? createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
      messages.push(...(includeFailed ? entry.retainedTail || [] : (entry.retainedTail || []).filter(isContextMessage)));
    } else if (entry?.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  }
  const projectedRepairs = repairs.flatMap((repair) => {
    let index = pathEntries.findIndex((entry) => entry.id === repair.tipId);
    if (index < start) return [];
    // Failed/deferred assistant envelopes remain evidence but are not ordinary
    // request messages. Anchor their interruption account at the preceding
    // visible native message, before any newly supplied user input.
    while (index >= start) {
      const entry = pathEntries[index];
      if (entry.type === "message" && messages.includes(entry.message)) return [{ ...repair, tipId: entry.id }];
      index -= 1;
    }
    return [];
  });
  return projectInterruptions(messages, projectedRepairs, messageIds);
}

import { projectInterruptions } from "./interruption.js";
import { createBranchSummaryMessage } from "./compaction-kit/messages.js";

const isContextMessage = (message: any) => message?.role !== "assistant"
  || !["error", "aborted", "deferred"].includes(message.stopReason);

/** Shared eligibility only; visible-message anchor remapping stays prompt-local. */
export function selectActiveRepairs(pathEntries: any[], repairs: any[] = []) {
  let start = 0;
  for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
    if (pathEntries[index]?.type === "compaction") { start = index; break; }
  }
  const anchors = new Set(pathEntries.slice(start).map((entry: any) => entry.id));
  return { start, repairs: repairs.filter((repair: any) => anchors.has(repair.tipId) || (repair.tipId === null && start === 0)) };
}

export function buildHarnessSessionContext(pathEntries: any, { includeFailed = false, repairs = [] }: { includeFailed?: boolean; repairs?: any[] } = {}) {
  const { start, repairs: activeRepairs } = selectActiveRepairs(pathEntries, repairs);
  const messages = []; const messageIds = new WeakMap();
  for (const entry of pathEntries.slice(start)) {
    if (entry?.type === "message") {
      if (includeFailed || isContextMessage(entry.message)) { messages.push(entry.message); messageIds.set(entry.message, entry.id); }
    } else if (entry?.type === "compaction") {
      messages.push(entry.checkpoint.summaryMessage);
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
  const projectedRepairs = activeRepairs.map((repair: any) => ({ ...repair, tipId: anchors.get(repair.tipId) ?? null }));
  return projectInterruptions(messages, projectedRepairs, messageIds);
}

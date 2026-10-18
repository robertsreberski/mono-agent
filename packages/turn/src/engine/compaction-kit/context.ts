// Adapted from @earendil-works/pi-agent-core 0.99.2 (MIT).
// Copyright (c) 2025 Mario Zechner. See harness/THIRD_PARTY_NOTICES.md.
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "./messages.js";
export function buildContextEntries(pathEntries: any) {
    let compaction;
    let compactionIndex = -1;
    for (let index = pathEntries.length - 1; index >= 0; index--) {
        const entry = pathEntries[index];
        if (entry?.type === "compaction") {
            compaction = entry;
            compactionIndex = index;
            break;
        }
    }
    return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}
function isContextMessage(message: any) {
    return (message.role !== "assistant" ||
        (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred"));
}

export function sessionEntryToContextMessages(entry: any): any[] | undefined {
    switch (entry.type) {
        case "message":
            return isContextMessage(entry.message) ? [entry.message] : [];
        case "compaction":
            return [
                createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
                ...entry.retainedTail.filter(isContextMessage),
            ];
        case "branch_summary":
            return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
        case "custom":
            return [];
    }
}

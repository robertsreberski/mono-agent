import { evidenceDigest } from "./evidence-view.js";

/** Build only from an already durable, validated checkpoint, never a preview or
 * streamed summary. Old/unmarked cuts are not retroactively given provenance. */
export function compactionEvidence(entry: any, journalId: string, operation: any): {
  version: 1; journalId: string; checkpointId: string; operationId: string;
  model: string; trigger: "manual" | "pre-turn" | "reactive" | "mid-run";
  summary: string; sourceDigest: string;
} | undefined {
  const trigger = operation?.cause?.replace(/^continuity:/u, "");
  if (!operation?.cause?.startsWith("continuity:") || !["manual", "pre-turn", "reactive", "mid-run"].includes(trigger)) return undefined;
  const checkpoint = entry?.checkpoint;
  if (entry?.type !== "compaction" || !checkpoint?.coverage || checkpoint.summaryMessage?.summary !== entry.summary
    || typeof entry.summary !== "string" || !journalId || !entry.id || !operation.operationId
    || !operation.model?.provider || !operation.model?.id) throw new TypeError("Invalid durable compaction evidence.");
  return { version: 1, journalId, checkpointId: entry.id, operationId: operation.operationId,
    model: `${operation.model.provider}:${operation.model.id}`, trigger, summary: entry.summary,
    sourceDigest: evidenceDigest({ journalId, coverage: checkpoint.coverage }) };
}

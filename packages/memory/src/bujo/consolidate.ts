import type { MemoryDb, MemoryRecord } from "../store/index.js";

import { rewriteBullet } from "./daily.js";
import { writeEmptyFutureLog, writeIndex } from "./projections.js";

export interface ConsolidateDeps {
  readonly root: string;
  readonly db: MemoryDb;
  readonly now: Date;
}

export interface ConsolidateResult {
  readonly decayed: number;
  readonly duplicateGroups: number;
  readonly superseded: number;
  readonly markdownInvalidated: number;
}

/** Deterministic, no-LLM maintenance: decay, exact-normalized duplicate folding, projections. */
export async function consolidateBujoMemory(deps: ConsolidateDeps): Promise<ConsolidateResult> {
  const { decayed } = deps.db.applyDecay(deps.now);
  const liveRecords = deps.db.topSalient(Math.max(deps.db.count(), 1));
  const groups = groupByNormalizedText(liveRecords);
  let duplicateGroups = 0;
  let superseded = 0;
  let markdownInvalidated = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    const [keeper, ...duplicates] = [...group].sort(compareNewestFirst);
    if (keeper === undefined) continue;
    for (const duplicate of duplicates) {
      deps.db.markSuperseded(duplicate.id, keeper.id, deps.now.toISOString());
      superseded += 1;
      if (duplicate.source.file !== undefined) {
        const rewritten = rewriteBullet(deps.root, duplicate.source.file, duplicate.id, { status: "invalidated" });
        if (rewritten) markdownInvalidated += 1;
      }
    }
  }

  writeIndex(deps.root, deps.db, deps.now);
  writeEmptyFutureLog(deps.root);
  return { decayed, duplicateGroups, superseded, markdownInvalidated };
}

function groupByNormalizedText(records: readonly MemoryRecord[]): Map<string, MemoryRecord[]> {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = normalizeFactText(record.text);
    if (key.length === 0) continue;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [record]);
    } else {
      existing.push(record);
    }
  }
  return groups;
}

function normalizeFactText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function compareNewestFirst(a: MemoryRecord, b: MemoryRecord): number {
  const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byCreated !== 0) return byCreated;
  return b.id.localeCompare(a.id);
}

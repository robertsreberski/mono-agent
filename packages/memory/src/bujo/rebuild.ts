import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { MemoryDb, MemoryRecord } from "../store/index.js";

import { parseDailyFile } from "./grammar.js";
import { readGraph } from "./graph.js";
import type { Bullet } from "./types.js";

/**
 * Rebuild the SQLite index from canonical markdown. No LLM — re-embeds via the db's provider.
 *
 * After indexing memory bullets, reads `graph.jsonl` and mirrors entities/relations into the db.
 * Note: memory↔entity `about` edges are NOT stored in markdown/graph.jsonl (P2 known lossiness)
 * and are intentionally NOT rebuilt here. This is documented and deferred to P3+.
 */
export async function rebuildFromMarkdown(root: string, db: MemoryDb): Promise<{ indexed: number }> {
  const dailyDir = join(root, "daily");
  let files: string[];
  try {
    files = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    // Only a missing directory means "empty". Re-throw permission/IO errors (EACCES, EIO, …) so a
    // transient fault can't silently produce an empty rebuild — db.rebuild() deletes every row first.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    files = [];
  }
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const parsed = parseDailyFile(readFileSync(join(dailyDir, file), "utf8"));
    // Use the real 1-based file line number (not the bullet ordinal) so source.line points at the
    // actual markdown line for provenance / jump-to-source.
    parsed.lines.forEach((line, index) => {
      if (line.bullet !== undefined) {
        records.push(toRecord(line.bullet, `daily/${file}`, index + 1));
      }
    });
  }
  const result = await db.rebuild(records);

  // Ingest entity graph — db.rebuild already wiped the entity tables, so start fresh.
  // No LLM: graph.jsonl is the canonical source written by captureTurn.
  const g = readGraph(root);
  for (const entity of g.entities) {
    try {
      db.upsertEntity(entity);
    } catch {
      // Per-item isolation: a single corrupt entity must not abort the rebuild
    }
  }
  for (const relation of g.relations) {
    try {
      db.addEntityRelation(relation.src, relation.dst, relation.relation);
    } catch {
      // Per-item isolation
    }
  }

  return result;
}

function toRecord(bullet: Bullet, file: string, line: number): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    ...(bullet.dueAt !== undefined ? { dueAt: bullet.dueAt } : {}),
    tags: [],
    source: { file, line },
  };
}

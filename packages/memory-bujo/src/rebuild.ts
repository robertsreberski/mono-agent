import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { MemoryDb, MemoryRecord } from "@mono-agent/memory-store";

import { parseDailyFile } from "./grammar.js";
import type { Bullet } from "./types.js";

/** Rebuild the SQLite index from canonical markdown. No LLM — re-embeds via the db's provider. */
export async function rebuildFromMarkdown(root: string, db: MemoryDb): Promise<{ indexed: number }> {
  const dailyDir = join(root, "daily");
  let files: string[];
  try {
    files = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    files = [];
  }
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const parsed = parseDailyFile(readFileSync(join(dailyDir, file), "utf8"));
    parsed.bullets.forEach((bullet, index) => {
      records.push(toRecord(bullet, `daily/${file}`, index));
    });
  }
  return db.rebuild(records);
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

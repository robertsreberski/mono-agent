import type { MemoryDb } from "../store/index.js";
import { writeCanonicalFileAtomic } from "./path-safety.js";

/** Write <root>/future-log.md: the due/scheduled intentions queue, soonest first. Returns count. */
export function writeFutureLog(root: string, db: MemoryDb, now: Date, horizonDays = 365): number {
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000);
  const items = db.dueItems(horizon, 200);
  const lines = items.map((m) => `- [<] ${m.text}  (due ${m.dueAt ?? "?"})  ^${m.id}`);
  const body = ["# Future Log", "", ...lines, ""].join("\n");
  writeCanonicalFileAtomic(root, "future-log.md", body);
  return items.length;
}

/** Write the deterministic consolidation future log. No synthesis or due-item expansion. */
export function writeEmptyFutureLog(root: string): void {
  writeCanonicalFileAtomic(root, "future-log.md", "# Future Log\n");
}

/** Write <root>/index.md: a living table of contents — counts + top entities + top-salient memories. */
export function writeIndex(root: string, db: MemoryDb, _now: Date): void {
  const memoryCount = db.count();
  const entityCount = db.countEntities();
  const topMemories = db.topSalient(15);
  const entities = db.listEntities(50);

  const overviewLines = [
    "## Overview",
    "",
    `- Memories: ${memoryCount}`,
    `- Entities: ${entityCount}`,
  ];

  const topMemoryLines = [
    "## Top memories",
    "",
    ...topMemories.map((m) => `- ${m.text}  ^${m.id}`),
  ];

  const entityLines = [
    "## Entities",
    "",
    ...entities.map((e) => `- ${e.name} (${e.type ?? "unknown"})`),
  ];

  const body = [
    "# Index",
    "",
    ...overviewLines,
    "",
    ...topMemoryLines,
    "",
    ...entityLines,
    "",
  ].join("\n");

  writeCanonicalFileAtomic(root, "index.md", body);
}

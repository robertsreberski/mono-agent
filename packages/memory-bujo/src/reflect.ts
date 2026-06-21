import { relative } from "node:path";

import type { MemoryDb, MemoryRecord } from "@mono-agent/memory-store";

import { appendBullet, dailyFilePath } from "./daily.js";
import { parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import { MemoryModelError } from "./model-error.js";
import type { Bullet } from "./types.js";

export interface ReflectDeps {
  readonly db: MemoryDb;
  readonly root: string;
  readonly llm: LlmComplete;
  readonly nextId: () => string;
  readonly now: () => Date;
  readonly halfLifeDays?: number;
  readonly floor?: number;
  readonly maxInsights?: number;
}

export interface ReflectResult {
  readonly decayed: number;
  readonly insights: number;
  readonly due: number;
}

export async function reflect(deps: ReflectDeps): Promise<ReflectResult> {
  const now = deps.now();
  const { decayed } = deps.db.applyDecay(now, {
    ...(deps.halfLifeDays !== undefined && { halfLifeDays: deps.halfLifeDays }),
    ...(deps.floor !== undefined && { floor: deps.floor }),
  });
  const insights = await synthesizeInsights(deps, now);
  const due = deps.db.dueItems(now).length;
  return { decayed, insights, due };
}

interface InsightCandidate {
  readonly text: string;
  readonly sourceIds?: string[];
}

/** Build an index record for a freshly-appended insight bullet (source.file relative to root). */
function insightRecordFor(bullet: Bullet, root: string, now: Date): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, now)) },
  };
}

/**
 * Synthesize higher-level insights from the top-salient non-insight memories.
 * Asks the LLM for up to `maxInsights ?? 3` insights as JSON, appends each as a
 * note bullet with isInsight=true, upserts the index record, and adds `supports`
 * edges from the insight to valid source memory ids.
 *
 * A malformed/parse-failed *reply* returns 0, but a model *failure* is rethrown as a
 * {@link MemoryModelError} so a dead model surfaces (the ritual scheduler logs it) instead of
 * looking like a reflection that simply found no insights.
 */
export async function synthesizeInsights(deps: ReflectDeps, now: Date): Promise<number> {
  const candidates = deps.db.topSalient(20).filter((m) => !m.isInsight);
  if (candidates.length < 3) return 0;

  const prompt = buildInsightPrompt(candidates, deps.maxInsights ?? 3);

  let raw: string;
  try {
    raw = await deps.llm.complete(prompt, { label: "reflect" });
  } catch (cause) {
    throw new MemoryModelError("llm", "insights", cause);
  }

  const parsed = parseJsonLoose<InsightCandidate[]>(raw);
  if (!Array.isArray(parsed)) return 0;

  const candidateIds = new Set(candidates.map((m) => m.id));
  const maxInsights = deps.maxInsights ?? 3;
  let created = 0;

  for (const item of parsed) {
    if (created >= maxInsights) break;
    if (typeof item !== "object" || item === null) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text.length === 0) continue;

    const id = deps.nextId();
    const bullet: Bullet = {
      id,
      type: "note",
      status: "open",
      text,
      salience: 0.7,
      isInsight: true,
      createdAt: now.toISOString(),
      refs: [],
    };

    appendBullet(deps.root, bullet, now);
    await deps.db.upsert(insightRecordFor(bullet, deps.root, now));

    // Add "supports" edges from this insight to each referenced source that is in our candidate set.
    const sourceIds = Array.isArray(item.sourceIds) ? item.sourceIds : [];
    for (const sourceId of sourceIds) {
      if (typeof sourceId === "string" && candidateIds.has(sourceId)) {
        deps.db.addEdge(id, sourceId, "supports");
      }
    }

    created += 1;
  }

  return created;
}

function buildInsightPrompt(memories: readonly MemoryRecord[], maxInsights: number): string {
  const memoryList = memories.map((m) => `- id=${m.id} text="${m.text}"`).join("\n");
  return `You are a reflective memory assistant. Given the following memories, synthesize up to ${maxInsights} higher-level insight(s) that reveal patterns, principles, or connections not obvious from any single memory.

Return ONLY a JSON array (no prose, no code fences):
[{"text":"<insight sentence>","sourceIds":["<id1>","<id2>"]}]

MEMORIES:
${memoryList}`;
}

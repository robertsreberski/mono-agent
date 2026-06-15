import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { parseJsonLoose } from "./json.js";
import type { ReflectDeps } from "./reflect.js";
import { rewriteBullet } from "./daily.js";

export type MigrateDeps = ReflectDeps;

export interface MigrateResult {
  readonly promoted: number;
  readonly rescheduled: number;
  readonly clustered: number;
  readonly forgotten: number;
  readonly reviewed: number;
}

type MigrateAction = "promote" | "reschedule" | "cluster" | "forget";

interface LlmDecision {
  readonly action: MigrateAction;
  readonly dueAt?: string;
  readonly collection?: string;
}

const VALID_ACTIONS = new Set<string>(["promote", "reschedule", "cluster", "forget"]);

function buildMigratePrompt(id: string, text: string): string {
  return `You are a BuJo (Bullet Journal) migration assistant. This memory has been open for over 30 days with low salience.

MEMORY:
id=${id}
text="${text}"

Decide what to do with it. Return ONLY a JSON object (no prose, no code fences):
{"action":"promote|reschedule|cluster|forget","dueAt":"<ISO 8601, only for reschedule>","collection":"<slug, only for cluster>"}

- promote: worth keeping + elevating salience
- reschedule: has a future due date, schedule it
- cluster: belongs to a named collection/theme (provide slug)
- forget: no longer relevant, drop it`;
}

/** Monthly BuJo migration ritual: review aging open memories and apply LLM decisions. */
export async function migrate(deps: MigrateDeps): Promise<MigrateResult> {
  const now = deps.now();
  const aging = deps.db.agingOpen(now, { olderThanDays: 30, maxSalience: 0.4, limit: 50 });

  let promoted = 0;
  let rescheduled = 0;
  let clustered = 0;
  let forgotten = 0;

  const decisions: Array<{ action: MigrateAction; id: string; text: string }> = [];

  for (const item of aging) {
    try {
      const prompt = buildMigratePrompt(item.id, item.text);
      const raw = await deps.llm.complete(prompt);
      const parsed = parseJsonLoose<LlmDecision>(raw);

      // Validate: must be a non-null object with a recognized action
      if (
        parsed === undefined ||
        parsed === null ||
        typeof parsed !== "object" ||
        !VALID_ACTIONS.has(parsed.action)
      ) {
        continue;
      }

      const action = parsed.action;
      const sourceFile = item.source.file;

      if (action === "promote") {
        const newSalience = Math.min(1, item.salience + 0.3);
        if (sourceFile !== undefined) {
          rewriteBullet(deps.root, sourceFile, item.id, { salience: newSalience });
        }
        await deps.db.upsert({ ...item, salience: newSalience });
        promoted += 1;
        decisions.push({ action, id: item.id, text: item.text });
      } else if (action === "reschedule") {
        const dueAt = typeof parsed.dueAt === "string" ? parsed.dueAt : undefined;
        const patch: Parameters<typeof rewriteBullet>[3] = {
          status: "scheduled",
          ...(dueAt !== undefined && { dueAt }),
        };
        if (sourceFile !== undefined) {
          rewriteBullet(deps.root, sourceFile, item.id, patch);
        }
        await deps.db.upsert({
          ...item,
          status: "scheduled",
          ...(dueAt !== undefined && { dueAt }),
        });
        rescheduled += 1;
        decisions.push({ action, id: item.id, text: item.text });
      } else if (action === "cluster") {
        const slug = typeof parsed.collection === "string" && parsed.collection.length > 0
          ? parsed.collection
          : "uncategorized";
        await deps.db.upsert({ ...item, collection: slug });
        deps.db.upsertEntity({
          id: `collection:${slug}`,
          name: slug,
          type: "collection",
          createdAt: now.toISOString(),
        });
        deps.db.addEdge(item.id, `collection:${slug}`, "supports");
        clustered += 1;
        decisions.push({ action, id: item.id, text: item.text });
      } else if (action === "forget") {
        if (sourceFile !== undefined) {
          rewriteBullet(deps.root, sourceFile, item.id, { status: "dropped" });
        }
        await deps.db.upsert({ ...item, status: "dropped", validTo: now.toISOString() });
        forgotten += 1;
        decisions.push({ action, id: item.id, text: item.text });
      }
    } catch {
      // Per-item isolation: skip this item, continue with the rest
      continue;
    }
  }

  // Write monthly/<YYYY-MM>.md — append a dated section with all decisions
  if (decisions.length > 0) {
    const yearMonth = now.toISOString().slice(0, 7); // "YYYY-MM"
    const monthlyDir = join(deps.root, "monthly");
    mkdirSync(monthlyDir, { recursive: true });
    const monthlyPath = join(monthlyDir, `${yearMonth}.md`);
    const dateStr = now.toISOString().slice(0, 10);
    const lines = [
      `\n## ${dateStr}`,
      ...decisions.map((d) => `- ${d.action} ${d.id}: "${d.text}"`),
      "",
    ].join("\n");
    appendFileSync(monthlyPath, lines, "utf8");
  }

  return {
    promoted,
    rescheduled,
    clustered,
    forgotten,
    reviewed: aging.length,
  };
}

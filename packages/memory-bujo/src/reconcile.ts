import { relative } from "node:path";

import type { MemoryDb, MemoryRecord, SimilarHit } from "@mono-agent/memory-store";

import { appendBullet, dailyFilePath, rewriteBullet } from "./daily.js";
import { parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import type { Bullet, CandidateMemory } from "./types.js";

/** The outcome of reconciling a single candidate against the existing index. */
export type ReconcileAction =
  | { readonly kind: "add"; readonly id: string }
  | { readonly kind: "update"; readonly id: string }
  | { readonly kind: "supersede"; readonly oldId: string; readonly newId: string }
  | { readonly kind: "noop"; readonly id: string };

export interface ReconcileDeps {
  readonly db: MemoryDb;
  readonly root: string;
  readonly llm: LlmComplete;
  readonly nextId: () => string;
  readonly now: () => Date;
  /** Distance below which an ADD also threads a `thread` edge to the neighbour. Default 0.35. */
  readonly threadThreshold?: number;
  /** Distance below which we consult the LLM to classify; above → ADD outright (skip LLM). Default 0.5. */
  readonly dupThreshold?: number;
}

const VALID_ACTIONS = new Set(["add", "update", "supersede", "noop"]);

interface Classification {
  readonly action: string;
  readonly targetId?: string;
  readonly text?: string;
}

/**
 * Reconcile distilled candidates against the existing memory index, writing to BOTH the
 * canonical markdown daily files and the SQLite index. Each candidate is handled independently
 * (an LLM/IO failure on one does not abort the others). The LLM is consulted only for candidates
 * that are close to an existing memory; clearly-novel candidates are added without an LLM call.
 */
export async function reconcile(
  candidates: readonly CandidateMemory[],
  deps: ReconcileDeps,
): Promise<ReconcileAction[]> {
  const threadThreshold = deps.threadThreshold ?? 0.35;
  const dupThreshold = deps.dupThreshold ?? 0.5;
  const actions: ReconcileAction[] = [];

  for (const candidate of candidates) {
    const similar = await deps.db.findSimilar(candidate.text, 5);

    // Clearly novel (nothing close enough) → ADD outright, no LLM.
    if (similar.length === 0 || (similar[0]?.distance ?? Infinity) > dupThreshold) {
      actions.push(await add(candidate, similar, deps, threadThreshold));
      continue;
    }

    const decision = await classify(candidate, similar, deps);
    actions.push(await apply(candidate, decision, similar, deps, threadThreshold));
  }

  return actions;
}

/** Ask the LLM to classify the candidate against its nearest neighbours; tolerate any malformed reply. */
async function classify(
  candidate: CandidateMemory,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
): Promise<Classification | undefined> {
  let raw: string;
  try {
    raw = await deps.llm.complete(classifyPrompt(candidate, similar));
  } catch {
    return undefined; // LLM error → caller falls back to ADD
  }
  const parsed = parseJsonLoose<Classification>(raw);
  if (parsed === undefined || typeof parsed !== "object") return undefined;
  const action = typeof parsed.action === "string" ? parsed.action : "";
  if (!VALID_ACTIONS.has(action)) return undefined;

  const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
  // The target must be one of the neighbours we offered the LLM. "add" needs no target.
  if (action !== "add") {
    if (targetId === undefined || !similar.some((h) => h.record.id === targetId)) return undefined;
  }
  return {
    action,
    ...(targetId !== undefined && { targetId }),
    ...(typeof parsed.text === "string" && { text: parsed.text }),
  };
}

const classifyPrompt = (candidate: CandidateMemory, similar: readonly SimilarHit[]): string => {
  const neighbours = similar
    .map((h) => `- id=${h.record.id} distance=${h.distance.toFixed(3)} text="${h.record.text}"`)
    .join("\n");
  return `CLASSIFY a new candidate memory against existing memories. Decide whether it is novel,
a duplicate, a refinement, or a contradiction. Return ONLY JSON:
{"action":"add|update|supersede|noop","targetId":"<existing id, omit for add>","text":"<merged/new text for update|supersede>"}.
- add: genuinely new information.
- noop: an exact duplicate of an existing memory (no change needed).
- update: refines/merges an existing memory; set targetId and text to the merged sentence.
- supersede: contradicts/replaces an existing memory; set targetId and text to the new sentence.

CANDIDATE: type=${candidate.type} text="${candidate.text}"

EXISTING:
${neighbours}`;
};

/** Dispatch a parsed classification (or fall back to ADD when it is missing/invalid). */
async function apply(
  candidate: CandidateMemory,
  decision: Classification | undefined,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Promise<ReconcileAction> {
  if (decision === undefined) return add(candidate, similar, deps, threadThreshold);

  switch (decision.action) {
    case "noop":
      // targetId is guaranteed present for non-add by classify().
      return { kind: "noop", id: decision.targetId ?? "" };
    case "update":
      return update(candidate, decision, similar, deps, threadThreshold);
    case "supersede":
      return supersede(candidate, decision, similar, deps, threadThreshold);
    default:
      return add(candidate, similar, deps, threadThreshold);
  }
}

/** ADD: append a new bullet, index it, and thread edges to near neighbours. */
async function add(
  candidate: CandidateMemory,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Promise<ReconcileAction> {
  const now = deps.now();
  const id = deps.nextId();
  const bullet: Bullet = {
    id,
    type: candidate.type,
    status: "open",
    text: candidate.text,
    salience: candidate.salience,
    isInsight: candidate.isInsight,
    createdAt: now.toISOString(),
    refs: [],
  };
  appendBullet(deps.root, bullet, now);
  await deps.db.upsert(recordFor(bullet, deps.root, now));

  for (const hit of similar) {
    if (hit.distance <= threadThreshold) {
      deps.db.addEdge(id, hit.record.id, "thread", 1 - hit.distance);
    }
  }
  return { kind: "add", id };
}

/** UPDATE: merge text into an existing memory (markdown + re-embedded index), keeping its id. */
async function update(
  candidate: CandidateMemory,
  decision: Classification,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Promise<ReconcileAction> {
  const targetId = decision.targetId ?? "";
  const target = deps.db.get(targetId);
  if (target === undefined || target.source.file === undefined) {
    return add(candidate, similar, deps, threadThreshold);
  }
  const mergedText = decision.text ?? candidate.text;
  rewriteBullet(deps.root, target.source.file, targetId, { text: mergedText });
  await deps.db.upsert({ ...target, text: mergedText });
  return { kind: "update", id: targetId };
}

/** SUPERSEDE: invalidate the old memory (markdown + index) and add the new one in its place. */
async function supersede(
  candidate: CandidateMemory,
  decision: Classification,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Promise<ReconcileAction> {
  const targetId = decision.targetId ?? "";
  const old = deps.db.get(targetId);
  if (old === undefined) {
    return add(candidate, similar, deps, threadThreshold);
  }
  const now = deps.now();
  const id = deps.nextId();
  const newText = decision.text ?? candidate.text;
  const bullet: Bullet = {
    id,
    type: candidate.type,
    status: "open",
    text: newText,
    salience: candidate.salience,
    isInsight: candidate.isInsight,
    createdAt: now.toISOString(),
    refs: [],
  };
  appendBullet(deps.root, bullet, now);
  await deps.db.supersede(targetId, recordFor(bullet, deps.root, now));
  if (old.source.file !== undefined) {
    rewriteBullet(deps.root, old.source.file, targetId, { status: "invalidated" });
  }
  return { kind: "supersede", oldId: targetId, newId: id };
}

/** Build an index record mirroring a freshly-appended bullet (source.file is the daily file, relative to root). */
function recordFor(bullet: Bullet, root: string, now: Date): MemoryRecord {
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

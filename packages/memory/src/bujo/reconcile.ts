import { relative } from "node:path";

import type { MemoryDb, MemoryRecord, SimilarHit } from "../store/index.js";

import { appendBullet, dailyFilePath, rewriteBullet } from "./daily.js";
import { normalizeCandidateText, type CandidateMemory } from "./distill.js";
import { parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import { MemoryModelError } from "./model-error.js";
import type { Bullet } from "./types.js";

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
  readonly abortSignal?: AbortSignal;
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
    try {
      // findSimilar embeds the query, so a down embedding model throws here for EVERY candidate —
      // a systemic outage, not a per-item data problem. Tag it so the catch below surfaces it.
      let similar: readonly SimilarHit[];
      try {
        similar = await deps.db.findSimilar(candidate.text, 5, {
          ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
        });
      } catch (cause) {
        deps.abortSignal?.throwIfAborted();
        throw new MemoryModelError("embedding", "findSimilar", cause);
      }
      deps.abortSignal?.throwIfAborted();

      // Clearly novel (nothing close enough) → ADD outright, no LLM.
      if (similar.length === 0 || (similar[0]?.distance ?? Infinity) > dupThreshold) {
        actions.push(await executePlannedAction(
          planAddWithoutIndex(candidate, similar, deps, threadThreshold),
          deps,
        ));
        continue;
      }

      const decision = await classify(candidate, similar, deps);
      actions.push(await executePlannedAction(
        planLegacyAction(candidate, decision, similar, deps, threadThreshold),
        deps,
      ));
    } catch (err) {
      // Abort is a lifecycle boundary, not an isolatable candidate failure. In
      // particular, an abort-ignoring provider may settle only after close()
      // has already released this operation's database.
      deps.abortSignal?.throwIfAborted();
      // A model outage (embedding or classify LLM) is systemic and must surface — every candidate
      // would hit it, so swallowing it would make a dead model look like a no-op capture.
      if (err instanceof MemoryModelError) throw err;
      // Per-candidate isolation: a genuine per-item *data* failure (e.g. a missing daily file during
      // UPDATE/SUPERSEDE) must not abort the rest of the batch. Skip it.
      continue;
    }
  }

  return actions;
}

/**
 * Reconcile a whole captured turn with one embedding batch and at most one LLM
 * classification call. Novel candidates bypass the second LLM call.
 */
export async function reconcileBatch(
  candidates: readonly CandidateMemory[],
  deps: ReconcileDeps,
): Promise<Array<ReconcileAction | undefined>> {
  const threadThreshold = deps.threadThreshold ?? 0.35;
  const dupThreshold = deps.dupThreshold ?? 0.5;
  let neighbours: readonly SimilarHit[][];
  try {
    neighbours = await deps.db.findSimilarMany(candidates.map((candidate) => candidate.text), 5, {
      ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    });
  } catch (cause) {
    deps.abortSignal?.throwIfAborted();
    throw new MemoryModelError("embedding", "findSimilarBatch", cause);
  }
  deps.abortSignal?.throwIfAborted();

  const reconcileIndexes = candidates.flatMap((_candidate, index) => {
    const similar = neighbours[index] ?? [];
    return similar.length > 0 && (similar[0]?.distance ?? Infinity) <= dupThreshold ? [index] : [];
  });
  const reconcileIndexSet = new Set(reconcileIndexes);
  const decisions = reconcileIndexes.length === 0
    ? new Map<number, Classification>()
    : await classifyBatch(candidates, neighbours, reconcileIndexes, deps);
  rejectConflictingMutations(decisions);
  deps.abortSignal?.throwIfAborted();
  const plans: Array<BatchActionPlan | undefined> = candidates.map(() => undefined);
  for (const [index, candidate] of candidates.entries()) {
    const similar = neighbours[index] ?? [];
    try {
      if (!reconcileIndexSet.has(index)) {
        plans[index] = { index, ...planAddWithoutIndex(candidate, similar, deps, threadThreshold) };
      } else {
        // A close candidate with a missing or malformed batch decision must
        // fail closed. Leave its slot empty: synthesizing a noop would later
        // attach this candidate's entities to a neighbour the model never
        // selected, corrupting the precise graph.
        const decision = decisions.get(index);
        if (decision === undefined) continue;
        plans[index] = { index, ...planBatchAction(candidate, decision, similar, deps, threadThreshold) };
      }
    } catch (error) {
      if (error instanceof MemoryModelError) throw error;
      // One malformed candidate cannot abort the rest of the turn.
    }
  }

  const writes = plans.flatMap((plan) => plan?.record === undefined ? [] : [plan]);
  let vectors: readonly (readonly number[] | undefined)[];
  try {
    // One persistence embedding batch for every ADD/UPDATE/SUPERSEDE. This
    // happens before canonical mutation so a provider outage is systemic and
    // cannot masquerade as an empty successful capture.
    vectors = await deps.db.prepareUpsertVectors(writes.map((plan) => plan.record!));
  } catch (cause) {
    throw new MemoryModelError("embedding", "persistBatch", cause);
  }
  deps.abortSignal?.throwIfAborted();

  const accepted: BatchActionPlan[] = [];
  const acceptedVectors: Array<readonly number[] | undefined> = [];
  for (const [index, plan] of writes.entries()) {
    deps.abortSignal?.throwIfAborted();
    try {
      plan.writeCanonical();
      accepted.push(plan);
      acceptedVectors.push(vectors[index]);
    } catch {
      // Preserve per-item source isolation. A partial canonical write is
      // precision-safe and remains recoverable by the explicit safe rebuild.
    }
  }
  if (accepted.length > 0) {
    deps.db.commitPreparedUpserts(accepted.map((plan) => plan.record!), acceptedVectors);
  }
  for (const plan of accepted) plan.finalizeIndex();

  const acceptedIndexes = new Set(accepted.map((plan) => plan.index));
  return plans.map((plan) => {
    if (plan === undefined) return undefined;
    if (plan.record !== undefined && !acceptedIndexes.has(plan.index)) return undefined;
    return plan.action;
  });
}

/**
 * A batch is planned against one pre-write snapshot. Two UPDATE/SUPERSEDE
 * decisions for the same existing row would therefore overwrite or invalidate
 * each other while both appeared accepted. Fail every colliding mutation
 * closed before vector preflight or canonical writes.
 */
function rejectConflictingMutations(decisions: Map<number, Classification>): void {
  const byTarget = new Map<string, number[]>();
  for (const [index, decision] of decisions) {
    if ((decision.action !== "update" && decision.action !== "supersede") || decision.targetId === undefined) continue;
    const indexes = byTarget.get(decision.targetId) ?? [];
    indexes.push(index);
    byTarget.set(decision.targetId, indexes);
  }
  for (const indexes of byTarget.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) decisions.delete(index);
  }
}

interface BatchActionPlan {
  readonly index: number;
  readonly action: ReconcileAction;
  readonly record?: MemoryRecord;
  writeCanonical(): void;
  finalizeIndex(): void;
}

/** Preserve the exported legacy reconcile semantics while sharing the batch planner's fenced writes. */
function planLegacyAction(
  candidate: CandidateMemory,
  decision: Classification | undefined,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Omit<BatchActionPlan, "index"> {
  const resolved = decision ?? closestNoop(similar);
  return resolved === undefined
    ? planAddWithoutIndex(candidate, similar, deps, threadThreshold)
    : planBatchAction(candidate, resolved, similar, deps, threadThreshold);
}

/**
 * Finish every legacy ADD/UPDATE/SUPERSEDE with the same provider-first,
 * synchronous-commit boundary as reconcileBatch. No canonical source can be
 * touched until the persistence vector exists and the lifecycle signal is
 * still live; after that check there is no async gap in which close() can
 * release SQLite between source mutation and index commit.
 */
async function executePlannedAction(
  plan: Omit<BatchActionPlan, "index">,
  deps: ReconcileDeps,
): Promise<ReconcileAction> {
  if (plan.record === undefined) {
    deps.abortSignal?.throwIfAborted();
    return plan.action;
  }

  let vectors: readonly (readonly number[] | undefined)[];
  try {
    vectors = await deps.db.prepareUpsertVectors([plan.record]);
  } catch (cause) {
    deps.abortSignal?.throwIfAborted();
    throw new MemoryModelError("embedding", "persist", cause);
  }
  deps.abortSignal?.throwIfAborted();

  plan.writeCanonical();
  deps.db.commitPreparedUpserts([plan.record], vectors);
  plan.finalizeIndex();
  return plan.action;
}

function planBatchAction(
  candidate: CandidateMemory,
  decision: Classification,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Omit<BatchActionPlan, "index"> {
  switch (decision.action) {
    case "add":
      return planAddWithoutIndex(candidate, similar, deps, threadThreshold);
    case "noop":
      return {
        action: { kind: "noop", id: decision.targetId ?? "" },
        writeCanonical: () => {},
        finalizeIndex: () => {},
      };
    case "update":
      return planUpdate(candidate, decision, deps);
    case "supersede":
      return planSupersede(candidate, decision, deps);
    default:
      throw new Error("memory-reconcile: unsupported batch action.");
  }
}

function planAddWithoutIndex(
  candidate: CandidateMemory,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
  threadThreshold: number,
): Omit<BatchActionPlan, "index"> {
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
  const record = recordFor(bullet, deps.root, now);
  return {
    action: { kind: "add", id },
    record,
    writeCanonical: () => { appendBullet(deps.root, bullet, now); },
    finalizeIndex: () => {
      for (const hit of similar) {
        if (hit.distance <= threadThreshold) deps.db.addEdge(id, hit.record.id, "thread", 1 - hit.distance);
      }
    },
  };
}

function planUpdate(
  candidate: CandidateMemory,
  decision: Classification,
  deps: ReconcileDeps,
): Omit<BatchActionPlan, "index"> {
  const targetId = decision.targetId ?? "";
  const target = deps.db.get(targetId);
  if (target === undefined || target.source.file === undefined) {
    throw new Error(`memory-reconcile: update target "${targetId}" is unavailable.`);
  }
  const mergedText = decision.text ?? candidate.text;
  return {
    action: { kind: "update", id: targetId },
    record: { ...target, text: mergedText },
    writeCanonical: () => { rewriteBullet(deps.root, target.source.file!, targetId, { text: mergedText }); },
    finalizeIndex: () => {},
  };
}

function planSupersede(
  candidate: CandidateMemory,
  decision: Classification,
  deps: ReconcileDeps,
): Omit<BatchActionPlan, "index"> {
  const targetId = decision.targetId ?? "";
  const old = deps.db.get(targetId);
  if (old === undefined) throw new Error(`memory-reconcile: supersede target "${targetId}" is unavailable.`);
  const now = deps.now();
  const id = deps.nextId();
  const bullet: Bullet = {
    id,
    type: candidate.type,
    status: "open",
    text: decision.text ?? candidate.text,
    salience: candidate.salience,
    isInsight: candidate.isInsight,
    createdAt: now.toISOString(),
    refs: [],
  };
  const record = recordFor(bullet, deps.root, now);
  return {
    action: { kind: "supersede", oldId: targetId, newId: id },
    record,
    writeCanonical: () => {
      appendBullet(deps.root, bullet, now);
      if (old.source.file !== undefined) rewriteBullet(deps.root, old.source.file, targetId, { status: "invalidated" });
    },
    finalizeIndex: () => { deps.db.markSuperseded(targetId, id, now.toISOString()); },
  };
}

async function classifyBatch(
  candidates: readonly CandidateMemory[],
  neighbours: readonly (readonly SimilarHit[])[],
  indexes: readonly number[],
  deps: ReconcileDeps,
): Promise<Map<number, Classification>> {
  const input = indexes.map((index) => ({
    index,
    candidate: candidates[index],
    existing: (neighbours[index] ?? []).map((hit) => ({
      id: hit.record.id,
      distance: Number(hit.distance.toFixed(6)),
      text: hit.record.text,
    })),
  }));
  let raw: string;
  try {
    raw = await deps.llm.complete(
      `Classify each candidate against only its supplied existing memories. Return ONLY a JSON array:
[{"index":0,"action":"add|update|supersede|noop","targetId":"existing id when required","text":"merged/replacement text when needed"}]
- add: genuinely new; noop: duplicate; update: refinement; supersede: contradiction.
- Preserve every input index exactly once. targetId must come from that candidate's existing list.

INPUT:
${JSON.stringify(input)}`,
      {
        label: "capture:reconcile-batch",
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      },
    );
  } catch (cause) {
    throw new MemoryModelError("llm", "classify-batch", cause);
  }
  const parsed = parseJsonLoose<unknown[]>(raw);
  const decisions = new Map<number, Classification>();
  const seenIndexes = new Set<number>();
  const duplicates = new Set<number>();
  if (!Array.isArray(parsed)) return decisions;
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { index?: unknown; action?: unknown; targetId?: unknown; text?: unknown };
    const index = typeof record.index === "number" && Number.isInteger(record.index) ? record.index : -1;
    if (!indexes.includes(index) || duplicates.has(index)) continue;
    if (seenIndexes.has(index)) {
      decisions.delete(index);
      duplicates.add(index);
      continue;
    }
    seenIndexes.add(index);
    if (typeof record.action !== "string" || !VALID_ACTIONS.has(record.action)) continue;
    const targetId = typeof record.targetId === "string" ? record.targetId : undefined;
    if (record.action !== "add" && (
      targetId === undefined || !(neighbours[index] ?? []).some((hit) => hit.record.id === targetId)
    )) continue;
    const text = normalizeCandidateText(record.text);
    decisions.set(index, {
      action: record.action,
      ...(targetId === undefined ? {} : { targetId }),
      ...(text === undefined ? {} : { text }),
    });
  }
  return decisions;
}

/**
 * Ask the LLM to classify the candidate against its nearest neighbours. A malformed *reply* is
 * tolerated (→ undefined → caller fails closed to the nearest neighbour), but a model *failure* is rethrown as a
 * {@link MemoryModelError} so a dead model surfaces instead of silently degrading to ADD.
 */
async function classify(
  candidate: CandidateMemory,
  similar: readonly SimilarHit[],
  deps: ReconcileDeps,
): Promise<Classification | undefined> {
  let raw: string;
  try {
    raw = await deps.llm.complete(classifyPrompt(candidate, similar), {
      label: "capture:reconcile",
      ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    });
  } catch (cause) {
    deps.abortSignal?.throwIfAborted();
    throw new MemoryModelError("llm", "classify", cause);
  }
  deps.abortSignal?.throwIfAborted();
  const parsed = parseJsonLoose<Classification>(raw);
  if (parsed === undefined || typeof parsed !== "object") return undefined;
  const action = typeof parsed.action === "string" ? parsed.action : "";
  if (!VALID_ACTIONS.has(action)) return undefined;

  const targetId = typeof parsed.targetId === "string" ? parsed.targetId : undefined;
  // The target must be one of the neighbours we offered the LLM. "add" needs no target.
  if (action !== "add") {
    if (targetId === undefined || !similar.some((h) => h.record.id === targetId)) return undefined;
  }
  const text = normalizeCandidateText(parsed.text);
  return {
    action,
    ...(targetId !== undefined && { targetId }),
    ...(text === undefined ? {} : { text }),
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

function closestNoop(similar: readonly SimilarHit[]): Classification | undefined {
  const id = similar[0]?.record.id;
  return id === undefined ? undefined : { action: "noop", targetId: id };
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

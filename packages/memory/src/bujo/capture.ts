import { extractCapturePlan } from "./capture-batch.js";
import { appendGraphBatch } from "./graph.js";
import { reconcileBatch, type ReconcileAction, type ReconcileDeps } from "./reconcile.js";

export interface CaptureTurnResult {
  readonly actions: ReconcileAction[];
  readonly entities: number;
  readonly relations: number;
  readonly associations: number;
}

/**
 * Full capture pipeline for a single conversation turn:
 *  1. Extract bounded candidate memories plus their precise graph evidence in one LLM call.
 *  2. Reconcile all close candidates in at most one additional LLM call.
 *  3. Persist entities and relations canonical-first, then mirror them to the index.
 *  4. Persist only each candidate's explicit memory/entity associations.
 *
 * Never throws on a single bad entity/relation item — each write is wrapped defensively.
 * Returns the action and graph-write counts.
 */
export async function captureTurn(text: string, deps: ReconcileDeps): Promise<CaptureTurnResult> {
  // One batched extraction call yields candidates + their precise entity ids;
  // one optional batched reconcile call classifies every near neighbour.
  const extraction = await extractCapturePlan(text, deps.llm, deps.abortSignal);
  deps.abortSignal?.throwIfAborted();
  const actionSlots = await reconcileBatch(extraction.candidates, deps);
  deps.abortSignal?.throwIfAborted();
  const actions = actionSlots.filter((action): action is ReconcileAction => action !== undefined);

  const now = deps.now();
  const createdAt = now.toISOString();

  const associations = extraction.candidates.flatMap((candidate, index) => {
    const action = actionSlots[index];
    if (action === undefined) return [];
    const memoryId = memoryIdForAction(action);
    return (candidate.entityIds ?? []).map((entityId) => ({
      memoryId,
      entityId,
      provenance: "capture" as const,
      createdAt,
    }));
  });
  // Canonical-first with one graph read + one append for the whole capture.
  deps.abortSignal?.throwIfAborted();
  const canonical = appendGraphBatch(deps.root, {
    entities: extraction.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      ...(entity.type !== undefined ? { type: entity.type } : {}),
      createdAt,
    })),
    relations: extraction.relations.map((relation) => ({ ...relation, createdAt })),
    associations,
  });

  // Mirror exact canonical records to the rebuildable DB. Per-item DB
  // isolation cannot alter the single canonical append.
  for (const entity of canonical.entities) {
    try {
      deps.db.upsertEntity(entity);
    } catch {
      // Per-item isolation: a single bad entity must not abort the turn
    }
  }

  // Persist each relation canonical-first (graph.jsonl), then mirror to the db index.
  for (const relation of canonical.relations) {
    try {
      deps.db.addEntityRelation(relation.src, relation.dst, relation.relation, relation.createdAt);
    } catch {
      // Per-item isolation: a single bad relation must not abort the turn
    }
  }

  // Persist candidate-specific associations. Reconcile action identity
  // is preserved: update/noop target the existing id; supersede/add target the
  // new id. There is deliberately no turn-wide Cartesian association.
  let associationCount = 0;
  for (const association of canonical.associations) {
    try {
      deps.db.associateMemory(association);
      associationCount += 1;
    } catch {
      // Per-item isolation
    }
  }

  return {
    actions,
    entities: extraction.entities.length,
    relations: extraction.relations.length,
    associations: associationCount,
  };
}

function memoryIdForAction(action: ReconcileAction): string {
  if (action.kind === "supersede") return action.newId;
  return action.id;
}

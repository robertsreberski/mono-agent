import { extractCapturePlan } from "./capture-batch.js";
import { appendAssociation, appendEntity, appendRelation } from "./graph.js";
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
  const extraction = await extractCapturePlan(text, deps.llm);
  const actionSlots = await reconcileBatch(extraction.candidates, deps);
  const actions = actionSlots.filter((action): action is ReconcileAction => action !== undefined);

  const now = deps.now();
  const createdAt = now.toISOString();

  // Persist each entity canonical-first (graph.jsonl), then mirror to the rebuildable db
  // index. graph.jsonl is the canonical source rebuildFromMarkdown reads; writing it first means a
  // crash between the two writes still recovers the entity on the next rebuild.
  for (const entity of extraction.entities) {
    try {
      const record = {
        id: entity.id,
        name: entity.name,
        ...(entity.type !== undefined ? { type: entity.type } : {}),
        createdAt,
      };
      appendEntity(deps.root, record);
      deps.db.upsertEntity(record);
    } catch {
      // Per-item isolation: a single bad entity must not abort the turn
    }
  }

  // Persist each relation canonical-first (graph.jsonl), then mirror to the db index.
  for (const relation of extraction.relations) {
    try {
      appendRelation(deps.root, {
        src: relation.src,
        dst: relation.dst,
        relation: relation.relation,
        createdAt,
      });
      deps.db.addEntityRelation(relation.src, relation.dst, relation.relation);
    } catch {
      // Per-item isolation: a single bad relation must not abort the turn
    }
  }

  // Persist candidate-specific associations. Reconcile action identity
  // is preserved: update/noop target the existing id; supersede/add target the
  // new id. There is deliberately no turn-wide Cartesian association.
  let associations = 0;
  for (const [index, candidate] of extraction.candidates.entries()) {
    const action = actionSlots[index];
    if (action === undefined) continue;
    const memoryId = memoryIdForAction(action);
    for (const entityId of candidate.entityIds ?? []) {
      try {
        const association = { memoryId, entityId, provenance: "capture" as const, createdAt };
        appendAssociation(deps.root, association);
        deps.db.associateMemory(association);
        associations += 1;
      } catch {
        // Per-item isolation
      }
    }
  }

  return {
    actions,
    entities: extraction.entities.length,
    relations: extraction.relations.length,
    associations,
  };
}

function memoryIdForAction(action: ReconcileAction): string {
  if (action.kind === "supersede") return action.newId;
  return action.id;
}

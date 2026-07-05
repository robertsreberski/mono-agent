import { distill } from "./distill.js";
import { extractEntities } from "./entities.js";
import { appendEntity, appendRelation } from "./graph.js";
import { reconcile, type ReconcileAction, type ReconcileDeps } from "./reconcile.js";

export interface CaptureTurnResult {
  readonly actions: ReconcileAction[];
  readonly entities: number;
  readonly relations: number;
}

/**
 * Full capture pipeline for a single conversation turn:
 *  1. distill(text) → candidate memories
 *  2. reconcile(candidates) → ADD / UPDATE / SUPERSEDE / NOOP actions (writes markdown + index)
 *  3. extractEntities(text) → typed entities + relations
 *  4. Persist each entity canonical-first: graph.jsonl, THEN mirror to the db index
 *  5. Persist each relation canonical-first: graph.jsonl, THEN mirror to the db index
 *  6. Link this turn's ADDed memories to extracted entities via `about` edges (coarse co-occurrence)
 *
 * Never throws on a single bad entity/relation item — each write is wrapped defensively.
 * Returns a summary: actions list, entity count, relation count.
 */
export async function captureTurn(text: string, deps: ReconcileDeps): Promise<CaptureTurnResult> {
  // Step 1+2: distill candidates and reconcile against existing index
  const candidates = await distill(text, deps.llm);
  const actions = await reconcile(candidates, deps);

  // Step 3: extract entities and relations from the turn text
  const extraction = await extractEntities(text, deps.llm);

  const now = deps.now();
  const createdAt = now.toISOString();

  // Step 4: persist each entity canonical-first (graph.jsonl), then mirror to the rebuildable db
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

  // Step 5: persist each relation canonical-first (graph.jsonl), then mirror to the db index.
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

  // Step 6: link ADDed memories to extracted entities via `about` edges
  const addedIds = actions.flatMap((a) => (a.kind === "add" ? [a.id] : []));
  const entityIds = extraction.entities.map((e) => e.id);
  for (const memoryId of addedIds) {
    for (const entityId of entityIds) {
      try {
        deps.db.addEdge(memoryId, entityId, "about");
      } catch {
        // Per-item isolation
      }
    }
  }

  return {
    actions,
    entities: extraction.entities.length,
    relations: extraction.relations.length,
  };
}

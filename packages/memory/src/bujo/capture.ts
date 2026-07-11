import { extractCapturePlan } from "./capture-batch.js";
import {
  replayCaptureIntent,
  replayCaptureOutbox,
  writeCaptureIntent,
  type CaptureIntentAction,
  type CaptureIntentHandle,
} from "./capture-outbox.js";
import type { GraphBatchInput } from "./graph.js";
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
  deps.abortSignal?.throwIfAborted();
  // A graph/DB mirror fault can leave one committed intent while the process
  // remains alive. Finish it before paying for or planning another turn so
  // later updates cannot make the earlier exact outcome unreplayable.
  replayCaptureOutbox(deps.root, deps.db);
  // One batched extraction call yields candidates + their precise entity ids;
  // one optional batched reconcile call classifies every near neighbour.
  const extraction = await extractCapturePlan(text, deps.llm, deps.abortSignal);
  deps.abortSignal?.throwIfAborted();
  const now = deps.now();
  const createdAt = now.toISOString();
  let intentHandle: CaptureIntentHandle | undefined;
  let preparedActions: readonly CaptureIntentAction[] = [];
  await reconcileBatch(extraction.candidates, {
    ...deps,
    // Once the intent exists it is the single commit owner. Writing the same
    // records directly here and then replaying the intent would duplicate the
    // SQLite/canonical transaction without improving durability.
    deferBatchCommit: true,
    beforeBatchCommit: (prepared) => {
      const graph = graphForPreparedActions(extraction, prepared, createdAt);
      intentHandle = writeCaptureIntent(deps.root, prepared, graph, createdAt);
      preparedActions = prepared;
    },
  });
  deps.abortSignal?.throwIfAborted();
  if (intentHandle === undefined) throw new Error("memory-capture: reconcile completed without a durable intent.");
  const canonical = replayCaptureIntent(deps.root, intentHandle, deps.db);
  const actions = preparedActions.map(reconcileActionForIntent);

  return {
    actions,
    entities: canonical.entities.length,
    relations: canonical.relations.length,
    associations: canonical.associations.length,
  };
}

function reconcileActionForIntent(action: CaptureIntentAction): ReconcileAction {
  if (action.kind === "supersede") {
    return { kind: "supersede", oldId: action.oldId, newId: action.newId };
  }
  return { kind: action.kind, id: action.id };
}

function graphForPreparedActions(
  extraction: Awaited<ReturnType<typeof extractCapturePlan>>,
  prepared: Parameters<NonNullable<ReconcileDeps["beforeBatchCommit"]>>[0],
  createdAt: string,
): GraphBatchInput {
  const byIndex = new Map(prepared.map((action) => [action.candidateIndex, action]));
  const associations = extraction.candidates.flatMap((candidate, index) => {
    const action = byIndex.get(index);
    if (action === undefined) return [];
    const memoryId = action.kind === "supersede" ? action.newId : action.id;
    return (candidate.entityIds ?? []).map((entityId) => ({
      memoryId,
      entityId,
      provenance: "capture" as const,
      createdAt,
    }));
  });
  return {
    entities: extraction.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      ...(entity.type !== undefined ? { type: entity.type } : {}),
      createdAt,
    })),
    relations: extraction.relations.map((relation) => ({ ...relation, createdAt })),
    associations,
  };
}

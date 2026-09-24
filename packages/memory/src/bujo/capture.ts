import { extractCapturePlanStrict } from "./capture-batch.js";
import {
  replayCaptureIntent,
  writeCaptureIntent,
  type CaptureIntentAction,
  type CaptureIntentHandle,
} from "./capture-outbox.js";
import type { ExtractedEntity } from "./entities.js";
import { selectKnownEntityHints } from "./entity-reuse.js";
import { readGraph, type GraphBatchInput } from "./graph.js";
import { withSerializedBujoMutation } from "./mutation-lock.js";
import { reconcileBatch, type ReconcileAction, type ReconcileDeps } from "./reconcile.js";

export interface CaptureTurnResult {
  readonly actions: ReconcileAction[];
  readonly entities: number;
  readonly relations: number;
  readonly associations: number;
}

/** Strong completed-turn capture: strict all-or-nothing extraction and reconciliation. */
export async function captureTurnStrict(text: string, deps: ReconcileDeps): Promise<CaptureTurnResult> {
  return await withSerializedBujoMutation(deps, async () => await captureTurnUnlocked(text, deps));
}

/**
 * Existing entities this turn appears to mention, offered to the extractor so a
 * repeat mention extends the established node. Best-effort by design: capture
 * must never fail because the reuse hint could not be read, and an unreadable
 * graph simply reverts to today's behaviour of minting a fresh id.
 */
function knownEntityHints(root: string, text: string): ExtractedEntity[] {
  try {
    return selectKnownEntityHints(text, readGraph(root).entities);
  } catch {
    return [];
  }
}

async function captureTurnUnlocked(
  text: string,
  deps: ReconcileDeps,
): Promise<CaptureTurnResult> {
  deps.abortSignal?.throwIfAborted();
  // One batched extraction call yields candidates + their precise entity ids;
  // one optional batched reconcile call classifies every near neighbour.
  // Strict capture samples the host-owned clock once, before extraction, and
  // uses that same instant for the observation anchor and capture metadata.
  // Durable intake retries replace this clock with immutable admittedAt.
  const knownEntities = knownEntityHints(deps.root, text);
  const observedAt = deps.now();
  const extraction = await extractCapturePlanStrict(text, deps.llm, deps.abortSignal, knownEntities, {
    observedAt: observedAt.toISOString(),
    ...(deps.captureSpeakerKind === undefined ? {} : { captureSpeakerKind: deps.captureSpeakerKind }),
    ...(deps.captureEvidence === undefined ? {} : { captureEvidence: deps.captureEvidence }),
    ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }),
  });
  deps.abortSignal?.throwIfAborted();
  const createdAt = observedAt.toISOString();
  let intentHandle: CaptureIntentHandle | undefined;
  let preparedActions: readonly CaptureIntentAction[] = [];
  await reconcileBatch(extraction.candidates, {
    ...deps,
    // Reconciliation must reuse the same host-owned observation sample; it
    // cannot observe a later wall clock or reinterpret relative-time anchors.
    now: () => observedAt,
    strictModelOutput: true,
    labelsForAction: (_action, candidate) => candidate.labels,
    // Once the intent exists it is the single commit owner. Writing the same
    // records directly here and then replaying the intent would duplicate the
    // SQLite/canonical transaction without improving durability.
    deferBatchCommit: true,
    beforeBatchCommit: (prepared) => {
      const graph = graphForPreparedActions(extraction, prepared, createdAt);
      intentHandle = writeCaptureIntent(
        deps.root,
        prepared,
        graph,
        createdAt,
        deps.captureRetentionKey === undefined ? {} : { retentionKey: deps.captureRetentionKey },
      );
      preparedActions = prepared;
    },
  });
  deps.abortSignal?.throwIfAborted();
  if (intentHandle === undefined) throw new Error("memory-capture: reconcile completed without a durable intent.");
  const canonical = replayCaptureIntent(deps.root, intentHandle, deps.db, {
    ...(deps.canonicalGraphRepairGuard === undefined
      ? {}
      : { canonicalGraphRepairGuard: deps.canonicalGraphRepairGuard }),
  });
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
  extraction: Awaited<ReturnType<typeof extractCapturePlanStrict>>,
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

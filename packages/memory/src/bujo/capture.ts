import { extractCapturePlanStrict } from "./capture-batch.js";
import { capturePlanInputHash, recoveredCapturePlan, retainCapturePlan } from "./capture-plan-cache.js";
import { captureLabels } from "./capture-labels.js";
import { labelsOf } from "./labels.js";
import {
  replayCaptureIntent,
  writeCaptureIntent,
  type CaptureIntentAction,
  type CaptureIntentHandle,
} from "./capture-outbox.js";
import type { ExtractedEntity } from "./entities.js";
import { selectKnownEntityHints, type KnownEntityHint } from "./entity-reuse.js";
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
function knownEntityHints(root: string, text: string): KnownEntityHint[] {
  try {
    const graph = readGraph(root);
    const associations = new Map<string, number>();
    for (const { entityId } of graph.associations) associations.set(entityId, (associations.get(entityId) ?? 0) + 1);
    return selectKnownEntityHints(text, graph.entities.map((entity) => ({ ...entity, associations: associations.get(entity.id) ?? 0 })));
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
  const ownerTurn = deps.captureSpeakerKind === "human-turn" && deps.captureEvidence?.ownerTurn === true;
  // Only a host-verified owner turn may bind the canonical owner id; never offer it elsewhere.
  const knownEntities: ExtractedEntity[] = knownEntityHints(deps.root, text)
    .filter((entity) => ownerTurn || entity.id !== "person:owner");
  if (ownerTurn) {
    // The host owner has exactly one canonical id. Offer it first so owner
    // facts bind there rather than to a name-based duplicate further down.
    const index = knownEntities.findIndex((entity) => entity.id === "person:owner");
    const owner = index < 0 ? { id: "person:owner", name: "Owner", type: "person" } : knownEntities.splice(index, 1)[0]!;
    knownEntities.unshift(owner);
  }
  const observedAt = deps.now();
  const key = deps.captureRetentionKey;
  const inputHash = capturePlanInputHash(text);
  const extraction = (key === undefined ? undefined : recoveredCapturePlan(deps.root, key, inputHash))
    ?? await extractCapturePlanStrict(text, deps.llm, deps.abortSignal, knownEntities, {
    observedAt: observedAt.toISOString(),
    ...(deps.captureSpeakerKind === undefined ? {} : { captureSpeakerKind: deps.captureSpeakerKind }),
    ...(deps.captureEvidence === undefined ? {} : { captureEvidence: deps.captureEvidence }),
    ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }),
  }, deps.captureSettings?.focus);
  deps.abortSignal?.throwIfAborted();
  const only = deps.captureSettings?.only;
  // The extractor already host-validates labels; don't let unaccepted candidates
  // influence reconcile decisions or persist unrelated graph nodes.
  const selected = only === undefined ? extraction : {
    ...extraction,
    candidates: extraction.candidates.filter((candidate) => candidate.labels?.some((label) => only.includes(label.kind))),
  };
  if (key !== undefined) retainCapturePlan(deps.root, key, inputHash, selected);
  const createdAt = observedAt.toISOString();
  const labelContext = { ...deps, entityNames: new Map(extraction.entities.map((entity) => [entity.id, entity.name])) };
  let intentHandle: CaptureIntentHandle | undefined;
  let preparedActions: readonly CaptureIntentAction[] = [];
  await reconcileBatch(selected.candidates, {
    ...deps,
    ...(only === undefined ? {} : { keepCaptureAction: (action: CaptureIntentAction): boolean => {
      const bullet = action.kind === "supersede" ? action.afterNew.bullet
        : action.kind === "noop" ? undefined : action.after.bullet;
      return bullet !== undefined && labelsOf(bullet).some((label) => only.includes(label.kind));
    } }),
    // Reconciliation must reuse the same host-owned observation sample; it
    // cannot observe a later wall clock or reinterpret relative-time anchors.
    now: () => observedAt,
    strictModelOutput: true,
    fallbackOnClassifierFailure: true,
    isFinalCaptureAttempt: deps.isFinalCaptureAttempt === true,
    labelsForAction: (_action, candidate, _previous, finalText) => candidate.labels === undefined ? undefined
      : captureLabels(candidate.labels, finalText ?? candidate.text, labelContext),
    // Once the intent exists it is the single commit owner. Writing the same
    // records directly here and then replaying the intent would duplicate the
    // SQLite/canonical transaction without improving durability.
    deferBatchCommit: true,
    beforeBatchCommit: (prepared) => {
      const graph = graphForPreparedActions(selected, prepared, createdAt, only !== undefined);
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
  filterGraph = false,
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
  const keptEntities = new Set(associations.map((association) => association.entityId));
  return {
    entities: extraction.entities.filter((entity) => !filterGraph || keptEntities.has(entity.id)).map((entity) => ({
      id: entity.id,
      name: entity.name,
      ...(entity.type !== undefined ? { type: entity.type } : {}),
      createdAt,
    })),
    relations: extraction.relations.filter((relation) => !filterGraph
      || (keptEntities.has(relation.src) && keptEntities.has(relation.dst)))
      .map((relation) => ({ ...relation, createdAt })),
    associations,
  };
}

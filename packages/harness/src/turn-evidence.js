import { validateSessionTurn } from "./journal-schema.js";
export { digestTurnInput } from "./journal-schema.js";

/** Explicit field builder: protected binding cannot persist arbitrary host options. */
export function createTurnBinding(descriptor, model) {
  validateSessionTurn(descriptor, descriptor.handleId);
  if (!descriptor.reconciliation) return undefined;
  return { version: 1, kind: descriptor.kind, ownerKey: descriptor.ownerKey,
    historyBucket: descriptor.historyBucket, turnId: descriptor.turnId,
    handleId: descriptor.handleId, baseRevision: descriptor.baseRevision,
    reconciliation: { version: 1, purpose: descriptor.reconciliation.purpose,
      fenceDigest: descriptor.reconciliation.fenceDigest, initialInputId: descriptor.reconciliation.initialInputId },
    model: { provider: model.provider, id: model.id, api: model.api } };
}

/** Open operations take precedence; an unsealed turn can instead have a last closed operation. */
export function selectTurnInterruptionAccounts(store, turnId, cause = "crashed") {
  const operations = store.validator.turns.get(turnId)?.operations ?? [];
  const open = operations.filter((id) => !store.validator.operations.get(id)?.end);
  const selected = open.length ? open : operations.slice(-1);
  return (selected.length ? selected : [null]).map((operationId) => ({ operationId,
    cause: operationId !== null && store.validator.operations.get(operationId)?.suspended ? "suspended_not_resumed" : cause }));
}

/** Read one indexed logical turn, not the full journal/context branch. */
export async function readTurnEvidence(store, turnId) {
  return store.readQueue(async () => {
    await store.verifyRead();
    const turn = store.validator.turns.get(turnId);
    if (!turn) return undefined;
    const operations = turn.operations.map((id) => {
      const op = store.validator.operations.get(id);
      return { operationId: id, type: op.start.payload.type, cause: op.start.payload.cause,
        parentOperationId: op.start.payload.parentOperationId, baselineTipId: op.start.payload.baselineTipId,
        startSeq: op.start.seq, endSeq: op.end?.seq ?? null, status: op.end?.payload.status ?? null,
        tipId: op.end?.payload.tipId ?? null, model: structuredClone(op.start.payload.config.model ?? null),
        suspended: op.suspended === true };
    });
    const evidence = { journalId: store.metadata.journalId, handleId: store.metadata.id, turnId,
      identitySource: turn.start.payload.identitySource, binding: structuredClone(turn.start.payload.binding ?? null),
      baselineTipId: turn.start.payload.baselineTipId, tipId: turn.end?.payload.tipId ?? store.tip, currentTipId: store.tip,
      status: turn.end?.payload.status ?? null, seal: structuredClone(turn.end?.payload.seal ?? null),
      finalOperationId: turn.end?.payload.finalOperationId ?? turn.finalOperationId ?? null,
      operations, consumedInputIds: [...turn.inputs], inputs: structuredClone([...turn.inputEvidence.values()]),
      admittedInputs: structuredClone([...turn.admittedInputIds].map((id) => ({ id, ...store.validator.inputs.get(id) }))),
      context: turn.contextIds.map((id) => {
        const entry = store.validator.contextInfo.get(id);
        return { id, kind: entry.kind, seq: entry.seq, parentId: entry.parentId, operationId: entry.operationId ?? null,
          role: entry.role ?? null, stopReason: entry.stopReason ?? null };
      }),
      interruptionEvidence: structuredClone(turn.interruptionIds.map((id) => store.interruptions.get(id))) };
    await store.verifyRead(); return evidence;
  });
}

/** Match before repair. Reference/ancestry validity is established by the journal validator. */
export function matchTurnEvidence(evidence, request) {
  const descriptor = request.descriptor;
  validateSessionTurn(descriptor, descriptor.handleId);
  if (!descriptor.reconciliation) throw new TypeError("Turn reconciliation requires explicit protected opt-in");
  if (!evidence) return { status: "absent" };
  const mismatch = (reason) => ({ status: "mismatch", reason });
  const binding = evidence.binding;
  if (!binding) return mismatch("unbound_turn");
  if (request.purpose !== binding.reconciliation.purpose || request.purpose !== descriptor.reconciliation.purpose) return mismatch("purpose");
  if (request.purpose === "execution" && evidence.identitySource !== "host") return mismatch("identity_source");
  for (const key of ["kind", "ownerKey", "historyBucket", "turnId", "handleId", "baseRevision"]) if (binding[key] !== descriptor[key]) return mismatch(key);
  if (evidence.handleId !== descriptor.handleId) return mismatch("handleId");
  for (const key of ["fenceDigest", "initialInputId"]) if (binding.reconciliation[key] !== descriptor.reconciliation[key]) return mismatch(key);
  const model = request.expectedModel;
  if (!model || model.provider !== binding.model.provider || model.id !== binding.model.id
    || (model.api !== undefined && model.api !== binding.model.api)) return mismatch("model");
  if (evidence.operations.some((op) => !op.model || ["provider", "id", "api"].some((key) => op.model[key] !== binding.model[key]))) return mismatch("operation_model");
  if (request.expectedBaseTip !== undefined && evidence.baselineTipId !== request.expectedBaseTip) return mismatch("baseline_tip");
  if (!Array.isArray(request.expectedInputs) || request.expectedInputs.some((input) => typeof input?.id !== "string" || !input.id.length || input.id.length > 512 || !/^[a-f0-9]{64}$/.test(input.requestDigest)
    || !["initial", "live"].includes(input.placement)) || new Set(request.expectedInputs.map((input) => input.id)).size !== request.expectedInputs.length) {
    throw new TypeError("Invalid expected turn inputs");
  }
  const expected = new Map(request.expectedInputs.map((input) => [input.id, input]));
  if (request.purpose === "compaction" && (expected.size || evidence.consumedInputIds.length)) return mismatch("compaction_inputs");
  if (request.purpose === "execution" && (expected.get(binding.reconciliation.initialInputId)?.placement !== "initial" || request.expectedInputs.filter((input) => input.placement === "initial").length !== 1)) return mismatch("initial_input");
  if (evidence.inputs.some((input) => !input.complete || !expected.has(input.id)
    || input.requestDigest !== expected.get(input.id).requestDigest || (input.placement !== expected.get(input.id).placement
      && !(input.placement === "replay" && input.id === binding.reconciliation.initialInputId && expected.get(input.id).placement === "initial")))) return mismatch("consumed_inputs");
  if (evidence.admittedInputs.some((input) => !expected.has(input.id)
    || input.requestDigest !== expected.get(input.id).requestDigest || input.placement !== expected.get(input.id).placement)) return mismatch("admitted_inputs");
  return { status: "matched", evidence };
}

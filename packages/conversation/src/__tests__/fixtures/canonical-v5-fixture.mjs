import { createHash } from "node:crypto";
export const bucket = "fictional-v4-bucket";
export const modelKey = "openai:fictional-model";
export const timestamp = "2000-01-01T00:00:00.000Z";
export const conversationKey = (id) => createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
const handleId = (id, epoch) => createHash("sha256").update("mono-agent-provider-session-v2\0").update(id).update("\0").update(epoch).digest("hex");
const journalId = (id, epoch) => createHash("sha256").update(`mono-host-journal-v1\0${handleId(id, epoch)}`).digest("hex");
const authorityFor = (id) => {
  const ownerKey = id.replace(/#\d{4}-\d{2}-\d{2}$/u, "");
  const coordinates = { historyBucket: id, ownerKey, rootId: "1".repeat(64), version: 1 };
  return { ...coordinates, authorityId: createHash("sha256").update(JSON.stringify(coordinates)).digest("hex") };
};
// Fictional canonical fixtures only: no production authority issuance.
export function canonicalRecord(id = bucket) {
  const epoch = "a".repeat(64), predecessorEpoch = "b".repeat(64);
  const artifact = { id: "e".repeat(64), hash: "e".repeat(64) };
  return { version: 3, conversationId: id, messages: [{ role: "assistant", content: "Fictional retained answer.", timestamp }],
    providerSession: { epoch, revision: 7, modelKey },
    native: { authority: authorityFor(id), projection: artifact },
    lastSwitch: { version: 1, switchId: "d".repeat(64), intentDigest: "f".repeat(64), fromEpoch: predecessorEpoch, toEpoch: epoch, artifact },
    lastCommit: { version: 1, turnId: "fictional-prior-turn", inputDigest: "3".repeat(64), candidateDigest: "4".repeat(64),
      journalId: journalId(id, epoch), tipId: "fictional-prior-tip", baseRevision: 6, committedRevision: 7, outcome: "completed" } };
}
/** The unsupported pre-release v4 chain shape, refused and never migrated. */

export function evidence(request) {
  const { descriptor } = request;
  const initial = request.expectedInputs.find((input) => input.placement === "initial");
  return { status: "matched", journalId: createHash("sha256").update(`mono-host-journal-v1\0${descriptor.handleId}`).digest("hex"), handleId: descriptor.handleId, turnId: descriptor.turnId,
    baselineTipId: null, tipId: "fictional-next-tip", currentTipId: "fictional-next-tip", outcome: "completed",
    seal: { version: 1, outcome: "completed", result: { text: "Fictional new answer.", error: null, failureKind: null, cancelled: false, stopReason: "stop" } },
    binding: { ...descriptor, version: 1, model: { provider: "openai", id: "fictional-model", api: "openai-responses" } },
    inputs: initial ? [{ ...initial, messageId: "fictional-input-envelope", complete: true }] : [], admittedInputs: [],
    finalOperationId: "fictional-operation", consumedInputIds: initial ? [initial.id] : [],
    operations: [{ operationId: "fictional-operation", type: request.purpose === "execution" ? "prompt" : "compaction", cause: "initial", parentOperationId: null,
      baselineTipId: null, tipId: "fictional-next-tip", startSeq: 1, endSeq: 2, status: "completed", suspended: false }], interruptionEvidence: [] };
}

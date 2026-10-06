import { MODEL_SWITCH_BILLING_POLICY, summaryAttemptId, switchDigest, switchHash, validateModelSwitchState, validateSwitchReference } from "./durable-model-switch-contract.js";
import type { HandoffReference, ModelSwitchIdentity, ModelSwitchReservation, ModelSwitchState, SummaryAttempt } from "./durable-model-switch-contract.js";

/** Pure policy only; callers persist the resulting state BEFORE a paid call. */
export function createModelSwitchState(coordinates: Omit<ModelSwitchIdentity, "switchId">, reservation: ModelSwitchReservation): ModelSwitchState {
  const state: ModelSwitchState = { version: 1, identity: { ...structuredClone(coordinates), switchId: switchDigest(coordinates) }, reservation: structuredClone(reservation),
    billingPolicy: MODEL_SWITCH_BILLING_POLICY, authorizationGeneration: 0, authorizations: [], attempts: [], phase: "outgoing", artifact: null };
  validateModelSwitchState(state); return state;
}
export class SummaryAttemptAlreadyRecordedError extends Error {
  readonly code = "ERR_HANDOFF_ATTEMPT_ALREADY_RECORDED";
  constructor() { super("This summary attempt is already recorded; never automatically repeat it"); }
}
export function admitSummaryAttempt(state: ModelSwitchState, producer: SummaryAttempt["producer"]): ModelSwitchState {
  validateModelSwitchState(state);
  if (state.attempts.some((attempt) => attempt.generation === state.authorizationGeneration && attempt.producer === producer)) throw new SummaryAttemptAlreadyRecordedError();
  if (state.phase !== producer) throw new Error("Summary producer is out of approved order");
  const result: ModelSwitchState = { ...state, attempts: [...state.attempts, { id: summaryAttemptId(state.identity.switchId, state.authorizationGeneration, producer),
    generation: state.authorizationGeneration, producer, outcome: "started", artifact: null }] };
  validateModelSwitchState(result); return structuredClone(result);
}
/** Reject known output or advance an outcome-unknown admission without rebilling.
 * Neither path erases the admitted attempt; restart alone grants no generation. */
export function finishSummaryAttempt(state: ModelSwitchState, producer: SummaryAttempt["producer"], outcome: "rejected" | "unknown"): ModelSwitchState {
  validateModelSwitchState(state);
  if (state.phase !== producer) throw new Error("Summary producer is out of approved order");
  const attempt = state.attempts.find((entry) => entry.generation === state.authorizationGeneration && entry.producer === producer);
  if (!attempt || attempt.outcome !== "started") throw new Error("No outcome-unknown attempt is admitted");
  const result: ModelSwitchState = { ...state, phase: producer === "outgoing" ? "checkpoint" : "pending",
    attempts: state.attempts.map((entry) => entry === attempt && outcome === "rejected" ? { ...entry, outcome: "rejected" } : entry) };
  validateModelSwitchState(result); return structuredClone(result);
}
/** Unfit producer input makes no billed admission. Checkpoint fallback is free. */
export function advanceUnfitProducer(state: ModelSwitchState): ModelSwitchState {
  validateModelSwitchState(state);
  if (!["outgoing", "checkpoint", "incoming"].includes(state.phase) || state.attempts.some((attempt) => attempt.generation === state.authorizationGeneration && attempt.producer === state.phase)) {
    throw new Error("Cannot classify an already admitted producer as unbilled");
  }
  const result: ModelSwitchState = { ...state, phase: state.phase === "outgoing" ? "checkpoint" : state.phase === "checkpoint" ? "incoming" : "pending" };
  validateModelSwitchState(result); return structuredClone(result);
}
export function acceptHandoffReference(state: ModelSwitchState, artifact: HandoffReference): ModelSwitchState {
  validateModelSwitchState(state); validateSwitchReference(artifact);
  if (state.phase === "ready") {
    if (switchDigest(state.artifact) !== switchDigest(artifact)) throw new Error("Ready artifact is immutable");
    return structuredClone(state);
  }
  if (!["outgoing", "checkpoint", "incoming"].includes(state.phase)) throw new Error("Handoff pending requires a new explicit message");
  const attempt = state.attempts.find((entry) => entry.generation === state.authorizationGeneration && entry.producer === state.phase);
  if (state.phase !== "checkpoint" && (!attempt || attempt.outcome !== "started")) throw new Error("A paid producer must be durably admitted before acceptance");
  const result: ModelSwitchState = { ...state, phase: "ready", artifact: structuredClone(artifact), attempts: state.attempts.map((entry) => entry === attempt ? { ...entry, outcome: "accepted", artifact: structuredClone(artifact) } : entry) };
  validateModelSwitchState(result); return result;
}
/** Only the host's explicit-message path calls this; recovery/maintenance cannot.
 * Keep all authorization identities bounded and reject exhaustion, never drop a
 * used identity and accidentally treat an old user message as fresh authority. */
export function authorizeSummaryMessage(state: ModelSwitchState, messageDigest: string): ModelSwitchState {
  validateModelSwitchState(state); switchHash(messageDigest);
  if (state.authorizations.some((authorization) => authorization.messageDigest === messageDigest)) return structuredClone(state);
  if (state.phase !== "pending") throw new Error("A new summary authorization requires handoff pending");
  if (state.authorizations.length >= 32) throw new RangeError("Summary authorization journal is full");
  const generation = state.authorizationGeneration + 1;
  const result: ModelSwitchState = { ...state, authorizationGeneration: generation, authorizations: [...state.authorizations, { generation, messageDigest }], phase: "outgoing" };
  validateModelSwitchState(result); return structuredClone(result);
}

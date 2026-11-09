// Closed, content-free proof acceptance and refusal codes. No runtime authority.
import { fail } from "./continuity-observation-input.mjs";
import { DEFAULT_MAX_INPUT_TOKENS } from "./continuity-arms.mjs";
export const PROOF_CODES = Object.freeze(["E2_BOUNDARY_MISMATCH", "E2_PROOF_TOOL_REFUSED", "E2_PROOF_SENTINEL_NOT_OFFERED", "E2_PROOF_SENTINEL_REPEATED", "E2_PROOF_RECOVERY_FAILED", "E2_PROOF_INITIAL_PRESENT", "E2_PROOF_LEAK", "E2_PROOF_CEILING_MISSING", "E2_PROOF_RUN_FAILED", "E2_PROBE_TOOLS_REFUSED", "E2_PROOF_PACK_MISSING", "E2_PROOF_CANCEL_NOT_FORWARDED", "E2_PROOF_EGRESS_REFUSED", "E2_PROOF_IDLE_NOT_EVICTED", "E2_PROOF_RESTART_MISSING", "E2_PROOF_ACTION_FAILED", "E2_PROOF_FIXTURE_FAILED"]);
export const proofRefusalCode = value => PROOF_CODES.includes(value) ? value : null;
export function requireProof(value, code) { if (!value) fail(code); }

// Collected runtime facts must pass before an assertion record is emitted.
export function assertSetupCompactions(compactions, metadata) {
  const count = metadata?.expect?.setupCompactions;
  const trigger = metadata?.pressure?.find(row => row.metric === "compactionTokensBefore")?.min;
  requireProof(Number.isSafeInteger(count) && count > 0 && trigger === DEFAULT_MAX_INPUT_TOKENS
    && compactions.length === count && compactions.every(c => c.trigger === "proactive" && c.durable === true && c.requests > 0 && c.policy?.triggerTokens === trigger), "E2_PROOF_CEILING_MISSING");
}
export function assertProofEvidence({ arm, pressureArm, initialAbsent, recovered, correct, safe, sentinel, boundary = false, pack = false, forwarded = false, restarted = false, sentinelOffered = false, idle, compactions = [] }) {
  requireProof(initialAbsent === true, "E2_PROOF_INITIAL_PRESENT");
  requireProof(recovered === true, "E2_PROOF_RECOVERY_FAILED");
  requireProof(correct === true, "E2_PROOF_ACTION_FAILED");
  requireProof(safe === true, "E2_PROOF_LEAK");
  requireProof(sentinel?.completed === true && sentinel.repeated === false, "E2_PROOF_SENTINEL_REPEATED");
  if (arm === "switch") { requireProof(boundary === true, "E2_BOUNDARY_MISMATCH"); requireProof(pack === true, "E2_PROOF_PACK_MISSING"); }
  if (arm === "cancel") { requireProof(forwarded === true, "E2_PROOF_CANCEL_NOT_FORWARDED"); requireProof(restarted === true, "E2_PROOF_RESTART_MISSING"); requireProof(sentinelOffered === true, "E2_PROOF_SENTINEL_NOT_OFFERED"); }
  if (arm === "idle") requireProof(idle?.observed === true && idle.reason === "idle_timeout" && idle.timeoutMs >= 1000 && idle.elapsedMs >= 1000, "E2_PROOF_IDLE_NOT_EVICTED");
  if (arm === "pressure") assertSetupCompactions(compactions, pressureArm);
  return { initialAbsence: true, digestVerifiedRecovery: true, correctNextAction: true, noCanaryOrForeignLeak: true, sentinelSingleEffect: true,
    ...(arm === "switch" ? { coldModelChange: true, firstSolPack: true } : {}),
    ...(arm === "cancel" ? { forwardedCancellation: true, newProcess: true, sentinelOfferedAfterResume: true, modelNonRepeat: true } : { harnessNonReexecution: true }),
    ...(arm === "idle" ? { observedWallClockIdleEviction: true } : {}), ...(arm === "pressure" ? { durableShippingCeilingCompaction: true } : {}) };
}

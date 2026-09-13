import { isAbsolute, resolve } from "node:path";

export type SubagentFailureReason = "continuation_not_started" | "settlement_unknown" | "session_continuity_lost" | "timeout" | "cancelled" | "failed" | "empty" | "interrupted";
export type SubagentContinuity = "retained" | "lost" | "unknown";
export interface SubagentTurnIntent {
  readonly token: string;
  readonly kind: "foreground" | "detached";
  readonly settlementPending: true;
}
export interface SubagentRecoveryFence {
  readonly turnToken: string;
  readonly sequence: number;
  readonly reason: SubagentFailureReason;
  readonly continuity: SubagentContinuity;
}
/** Private: never project the root to the provider or choose an owner by opening this path. */
export interface SubagentOwnerLink { readonly storeRoot: string; readonly jobId: string }
export interface SubagentOwnerIdentity extends SubagentOwnerLink {
  readonly conversationId: string;
  readonly instanceId: string;
  readonly instanceIncarnation: string;
  readonly turnToken: string;
}
export type SubagentOwnerResolution =
  | { readonly state: "held" | "unavailable" }
  | { readonly state: "released" | "not_admitted"; readonly identity: SubagentOwnerIdentity; readonly sequence: number; readonly receiptPending?: boolean; readonly reason?: SubagentFailureReason; readonly continuity: SubagentContinuity };

export class SubagentRecoveryError extends Error {
  constructor(readonly code: "subagent_owner_unavailable" | "subagent_ownership_held" | "subagent_recovery_required" | "subagent_stale_turn" | "subagent_recovery_ack_invalid" | "subagent_recovery_ack_stale" | "subagent_recovery_already_consumed" | "subagent_recovery_ack_conflict" | "subagent_recovery_not_retained" | "subagent_recovery_background_required" | "subagent_recovery_policy_unavailable" | "subagent_recovery_policy_denied") {
    super(code);
    this.name = "SubagentRecoveryError";
  }
}
export const isSubagentUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
export const isSubagentFailureReason = (value: unknown): value is SubagentFailureReason => typeof value === "string"
  && ["continuation_not_started", "settlement_unknown", "session_continuity_lost", "timeout", "cancelled", "failed", "empty", "interrupted"].includes(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function isSubagentTurnIntent(value: unknown): value is SubagentTurnIntent {
  return object(value) && exact(value, ["token", "kind", "settlementPending"]) && isSubagentUuid(value.token)
    && ["foreground", "detached"].includes(String(value.kind)) && value.settlementPending === true;
}
export function isSubagentRecoveryFence(value: unknown): value is SubagentRecoveryFence {
  return object(value) && exact(value, ["turnToken", "sequence", "reason", "continuity"]) && isSubagentUuid(value.turnToken)
    && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && isSubagentFailureReason(value.reason) && ["retained", "lost", "unknown"].includes(String(value.continuity));
}
export function isSubagentOwnerLink(value: unknown): value is SubagentOwnerLink {
  return object(value) && exact(value, ["storeRoot", "jobId"]) && isSubagentUuid(value.jobId)
    && typeof value.storeRoot === "string" && Buffer.byteLength(value.storeRoot) <= 4096 && !value.storeRoot.includes("\0")
    && isAbsolute(value.storeRoot) && resolve(value.storeRoot) === value.storeRoot;
}
export function sameSubagentOwner(left: SubagentOwnerIdentity, right: SubagentOwnerIdentity): boolean {
  return object(right) && ["storeRoot", "jobId", "conversationId", "instanceId", "instanceIncarnation", "turnToken"].every((key) => left[key as keyof SubagentOwnerIdentity] === right[key as keyof SubagentOwnerIdentity]);
}

export interface SubagentKnownOwner { readonly instanceId: string; readonly incarnation?: string; readonly jobId?: string }

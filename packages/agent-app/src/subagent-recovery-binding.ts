import { createHmac, randomBytes } from "node:crypto";
import { isSubagentUuid, SubagentRecoveryError, type SubagentRecoveryFence } from "./subagent-registry-ownership.js";

export interface SubagentRecoveryAcknowledgement {
  readonly ack: string;
  readonly message: string;
  readonly background?: boolean;
  readonly close?: boolean;
  readonly description?: string;
}
interface Consumption { token: string; digest: string; turnToken: string }
/** Private per-incarnation comparison key, never a model bearer capability. */
export interface SubagentRecoveryBinding {
  key: string;
  issued?: { token: string; profile: string };
  consumed?: Consumption;
  previous?: Consumption;
}
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const token = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 128) return false;
  const parts = value.split(":");
  return parts.length === 3 && isSubagentUuid(parts[0]) && isSubagentUuid(parts[1]) && /^[1-9][0-9]{0,15}$/u.test(parts[2]!) && Number.isSafeInteger(Number(parts[2]));
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function consumption(value: unknown): value is Consumption {
  return object(value) && exact(value, ["token", "digest", "turnToken"]) && token(value.token) && hex(value.digest)
    && isSubagentUuid(value.turnToken);
}
export function isSubagentRecoveryBinding(value: unknown): value is SubagentRecoveryBinding {
  return object(value) && exact(value, ["key", ...["issued", "consumed", "previous"].filter((key) => Object.hasOwn(value, key))]) && hex(value.key)
    && (value.issued === undefined || (object(value.issued) && exact(value.issued, ["token", "profile"]) && token(value.issued.token) && hex(value.issued.profile)))
    && (value.consumed === undefined || consumption(value.consumed)) && (value.previous === undefined || consumption(value.previous));
}
export const newSubagentRecoveryBinding = (): SubagentRecoveryBinding => ({ key: randomBytes(32).toString("hex") });
const digest = (binding: SubagentRecoveryBinding, value: unknown): string => createHmac("sha256", Buffer.from(binding.key, "hex")).update(JSON.stringify(value)).digest("hex");
export const recoveryToken = (incarnation: string, recovery: SubagentRecoveryFence): string => `${incarnation}:${recovery.turnToken}:${recovery.sequence}`;
export function issueRecoveryAcknowledgement(binding: SubagentRecoveryBinding, incarnation: string, recovery: SubagentRecoveryFence, profile: unknown): string {
  const value = recoveryToken(incarnation, recovery);
  binding.issued = { token: value, profile: digest(binding, profile) };
  return value;
}
function requestDigest(binding: SubagentRecoveryBinding, request: SubagentRecoveryAcknowledgement, profile: unknown): string {
  if (Object.keys(request).some((key) => !["ack", "message", "background", "close", "description"].includes(key)) || !token(request.ack) || typeof request.message !== "string" || !request.message.trim() || Buffer.byteLength(request.message) > 256 * 1024
    || (request.background !== undefined && typeof request.background !== "boolean") || (request.close !== undefined && typeof request.close !== "boolean")
    || (request.description !== undefined && (typeof request.description !== "string" || request.description.length > 80))) throw new SubagentRecoveryError("subagent_recovery_ack_invalid");
  return digest(binding, [request.ack, request.message, request.background === true, request.close === true, request.description ?? null, profile]);
}
/** Always called before busy checks. Never returns a prior execution receipt. */
export function checkRecoveryAcknowledgement(binding: SubagentRecoveryBinding | undefined, request: SubagentRecoveryAcknowledgement, profile: unknown): void {
  if (!binding) throw new SubagentRecoveryError("subagent_recovery_ack_stale");
  const candidate = requestDigest(binding, request, profile);
  const prior = [binding.consumed, binding.previous].find((item) => item?.token === request.ack);
  if (prior) throw new SubagentRecoveryError(prior.digest === candidate ? "subagent_recovery_already_consumed" : "subagent_recovery_ack_conflict");
  if (binding.issued?.token !== request.ack || binding.issued.profile !== digest(binding, profile)) throw new SubagentRecoveryError("subagent_recovery_ack_stale");
}
/**
 * Re-key an already consumed acknowledgement onto the profile the same
 * transaction just rewrote.
 *
 * A route change is applied after consumption, because the digest covers
 * `[systemPrompt, definition]` and mutating the definition first would make
 * every acknowledged continuation stale. Without this, a duplicate delivery of
 * the IDENTICAL request would then hash against the new definition and be
 * reported as `subagent_recovery_ack_conflict` instead of the
 * `subagent_recovery_already_consumed` replay it actually is. Nothing is
 * widened: the token and turn stay fixed and a matching token always refuses,
 * so this only keeps the refusal's reason truthful.
 */
export function rebindConsumedAcknowledgement(binding: SubagentRecoveryBinding, request: SubagentRecoveryAcknowledgement, profile: unknown): void {
  if (binding.consumed?.token !== request.ack) return;
  binding.consumed = { ...binding.consumed, digest: requestDigest(binding, request, profile) };
}
/** Called in the same durable registry transaction as the new reservation/intent. */
export function consumeRecoveryAcknowledgement(binding: SubagentRecoveryBinding, request: SubagentRecoveryAcknowledgement, profile: unknown, turnToken: string): void {
  checkRecoveryAcknowledgement(binding, request, profile);
  if (binding.consumed) binding.previous = binding.consumed;
  binding.consumed = { token: request.ack, digest: requestDigest(binding, request, profile), turnToken };
  delete binding.issued;
}

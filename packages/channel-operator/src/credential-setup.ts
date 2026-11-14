import type { CapabilityActionProcess } from "./capability-actions.js";

export const CREDENTIAL_CARDS = ["telegram", "slack", "openai-api"] as const;
export type CredentialCardId = typeof CREDENTIAL_CARDS[number];
export type CredentialFieldId = "bot" | "app" | "bearer" | "allowedIds";
export interface CredentialRequest {
  readonly card: CredentialCardId;
  readonly process: CapabilityActionProcess;
  readonly fence: string;
  readonly confirmed: true;
}
export interface CredentialSaveRequest extends CredentialRequest { readonly fields: Partial<Record<CredentialFieldId, string>> }
export interface CredentialCardStatus {
  readonly id: CredentialCardId;
  readonly available: boolean;
  readonly reason: "ready" | "no-reloadable-source" | "prerequisites" | "env-shadowed";
  readonly fields: readonly { readonly id: Exclude<CredentialFieldId, "allowedIds">; readonly state: "set" | "not-set" }[];
  /** Non-blocking: environment-owned configuration fields are not changed by Save. */
  readonly environmentOverrides?: true;
  readonly configReady: boolean;
  readonly configPending: boolean;
}
export interface CredentialSnapshot {
  readonly version: 1;
  readonly process: CapabilityActionProcess;
  /** Random, process-local concurrency fence. Not a content digest. */
  readonly fence: string;
  readonly cards: readonly CredentialCardStatus[];
}
export interface CredentialSaved { readonly card: CredentialCardId; readonly process: CapabilityActionProcess; readonly outcome: "saved" | "saved-config-pending" }
export interface CredentialSetupService {
  read(): Promise<CredentialSnapshot>;
  save(input: CredentialSaveRequest): Promise<CredentialSaved>;
  retry(input: CredentialRequest): Promise<CredentialSaved>;
}
export class CredentialSetupError extends Error {
  constructor(readonly code: "credential_conflict" | "credential_unavailable" | "credential_invalid" | "credential_outcome_unknown", readonly status: 400 | 409 | 503) { super(code); }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid credential request.");
  return value as Record<string, unknown>;
}
function card(value: unknown): CredentialCardId {
  if (!CREDENTIAL_CARDS.includes(value as CredentialCardId)) throw new Error("Invalid credential card.");
  return value as CredentialCardId;
}
function identity(value: unknown): CapabilityActionProcess {
  const r = record(value, ["pid", "startedAt"]);
  if (!Number.isSafeInteger(r.pid) || Number(r.pid) <= 0 || typeof r.startedAt !== "string" || r.startedAt.length > 64 || !Number.isFinite(Date.parse(r.startedAt))) throw new Error("Invalid credential process.");
  return { pid: Number(r.pid), startedAt: r.startedAt };
}
function fence(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid credential fence.");
  return value;
}
export function parseCredentialRequest(value: unknown): CredentialRequest {
  const r = record(value, ["card", "process", "fence", "confirmed"]);
  if (r.confirmed !== true) throw new Error("Confirmation required.");
  return { card: card(r.card), process: identity(r.process), fence: fence(r.fence), confirmed: true };
}
export function parseCredentialSaveRequest(value: unknown): CredentialSaveRequest {
  const r = record(value, ["card", "process", "fence", "confirmed", "fields"]);
  const base = parseCredentialRequest({ card: r.card, process: r.process, fence: r.fence, confirmed: r.confirmed });
  const allowed = base.card === "telegram" ? ["bot", "allowedIds"] : base.card === "slack" ? ["bot", "app", "allowedIds"] : ["bearer"];
  const fields = record(r.fields, allowed);
  if (Object.keys(fields).length === 0 || Object.keys(fields).length > 3 || Object.values(fields).some((item) => typeof item !== "string" || new TextEncoder().encode(item).length > 4096 || item.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(item))) throw new Error("Invalid credential fields.");
  return { ...base, fields: fields as CredentialSaveRequest["fields"] };
}
export function parseCredentialSnapshot(value: unknown): CredentialSnapshot {
  const r = record(value, ["version", "process", "fence", "cards"]);
  if (r.version !== 1 || !Array.isArray(r.cards) || r.cards.length !== 3) throw new Error("Invalid credential status.");
  const cards = r.cards.map((raw): CredentialCardStatus => {
    const c = record(raw, ["id", "available", "reason", "fields", "environmentOverrides", "configReady", "configPending"]);
    const id = card(c.id);
    if ((c.environmentOverrides !== undefined && c.environmentOverrides !== true) || typeof c.available !== "boolean" || typeof c.configReady !== "boolean" || typeof c.configPending !== "boolean" || !["ready", "no-reloadable-source", "prerequisites", "env-shadowed"].includes(String(c.reason)) || !Array.isArray(c.fields)) throw new Error("Invalid credential status.");
    const expected = id === "slack" ? ["bot", "app"] : id === "telegram" ? ["bot"] : ["bearer"];
    const fields = c.fields.map((raw): CredentialCardStatus["fields"][number] => {
      const f = record(raw, ["id", "state"]);
      if (!expected.includes(String(f.id)) || (f.state !== "set" && f.state !== "not-set")) throw new Error("Invalid credential status.");
      return { id: f.id as "bot" | "app" | "bearer", state: f.state };
    });
    if (fields.length !== expected.length || new Set(fields.map((field) => field.id)).size !== expected.length) throw new Error("Invalid credential fields.");
    return { id, ...(c.environmentOverrides === true ? { environmentOverrides: true as const } : {}), available: c.available, reason: c.reason as CredentialCardStatus["reason"], fields, configReady: c.configReady, configPending: c.configPending };
  });
  if (new Set(cards.map((c) => c.id)).size !== 3) throw new Error("Duplicate credential card.");
  return { version: 1, process: identity(r.process), fence: fence(r.fence), cards };
}
export function parseCredentialSaved(value: unknown): CredentialSaved {
  const r = record(value, ["card", "process", "outcome"]);
  if (r.outcome !== "saved" && r.outcome !== "saved-config-pending") throw new Error("Invalid credential outcome.");
  return { card: card(r.card), process: identity(r.process), outcome: r.outcome };
}

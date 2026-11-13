/** Separate from the v1 read-only discovery snapshot. Never accepts paths or patches. */
export type CapabilityActionId = "memory-lite" | "cron-controls";
export interface CapabilityActionProcess { readonly pid: number; readonly startedAt: string }
export interface CapabilityActionInput { readonly action: CapabilityActionId; readonly process: CapabilityActionProcess }
export interface CapabilityActionSaveInput extends CapabilityActionInput { readonly expectedVersion: string; readonly confirmed: true }
export type CapabilityActionReason = "eligible" | "already-configured" | "memory-configured" | "memory-root-unsafe" | "no-valid-jobs" | "env-shadowed";
export interface CapabilityActionsSnapshot {
  readonly version: 1;
  readonly process: CapabilityActionProcess;
  readonly actions: readonly { readonly id: CapabilityActionId; readonly available: boolean; readonly active: boolean; readonly reason: CapabilityActionReason }[];
}
export interface CapabilityActionPreview extends CapabilityActionInput {
  readonly expectedVersion: string;
  /** Only static, owned values. Never current config, credentials or paths from disk. */
  readonly changes: readonly { readonly field: "memory" | "cron.operatorActions.enabled"; readonly value: string }[];
  readonly normalizesFormatting: true;
  readonly noOp: boolean;
}
export interface CapabilityActionSaved extends CapabilityActionInput { readonly version: string; readonly changed: boolean }
export interface CapabilityActionsService {
  read(): Promise<CapabilityActionsSnapshot>;
  preview(input: CapabilityActionInput): Promise<CapabilityActionPreview>;
  save(input: CapabilityActionSaveInput): Promise<CapabilityActionSaved>;
}
export class CapabilityActionError extends Error {
  constructor(readonly code: "capability_action_conflict" | "capability_action_unavailable" | "capability_action_failed", readonly status: 409 | 503) {
    super(code === "capability_action_conflict" ? "Settings or process changed; refresh and review a new preview." : code === "capability_action_unavailable" ? "This action is unavailable; use the manual setup guidance." : "Settings could not be saved; inspect them in the owner terminal before retrying.");
  }
}
export const MAX_CAPABILITY_ACTION_BYTES = 16 * 1024;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid capability action.");
  return value as Record<string, unknown>;
}
function action(value: unknown): CapabilityActionId { if (value !== "memory-lite" && value !== "cron-controls") throw new Error("Invalid capability action."); return value; }
function processIdentity(value: unknown): CapabilityActionProcess {
  const r = object(value, ["pid", "startedAt"]);
  if (!Number.isSafeInteger(r.pid) || Number(r.pid) <= 0 || typeof r.startedAt !== "string" || r.startedAt.length > 64 || !Number.isFinite(Date.parse(r.startedAt))) throw new Error("Invalid capability process.");
  return { pid: Number(r.pid), startedAt: r.startedAt };
}
function version(value: unknown): string { if (typeof value !== "string" || !/^(?:[a-f0-9]{64})?$/u.test(value)) throw new Error("Invalid config version."); return value; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid capability flag."); return value; }
export function parseCapabilityActionInput(value: unknown): CapabilityActionInput {
  const r = object(value, ["action", "process"]); return { action: action(r.action), process: processIdentity(r.process) };
}
export function parseCapabilityActionSaveInput(value: unknown): CapabilityActionSaveInput {
  const r = object(value, ["action", "process", "expectedVersion", "confirmed"]);
  if (r.confirmed !== true) throw new Error("Explicit confirmation required.");
  return { action: action(r.action), process: processIdentity(r.process), expectedVersion: version(r.expectedVersion), confirmed: true };
}
export function parseCapabilityActionsSnapshot(value: unknown): CapabilityActionsSnapshot {
  const r = object(value, ["version", "process", "actions"]);
  if (r.version !== 1 || !Array.isArray(r.actions) || r.actions.length !== 2) throw new Error("Invalid capability actions.");
  const actions = r.actions.map((value) => {
    const item = object(value, ["id", "available", "active", "reason"]);
    if (!["eligible", "already-configured", "memory-configured", "memory-root-unsafe", "no-valid-jobs", "env-shadowed"].includes(String(item.reason))) throw new Error("Invalid capability reason.");
    return { id: action(item.id), available: boolean(item.available), active: boolean(item.active), reason: item.reason as CapabilityActionReason };
  });
  if (new Set(actions.map((item) => item.id)).size !== 2) throw new Error("Duplicate capability action.");
  return { version: 1, process: processIdentity(r.process), actions };
}
export function parseCapabilityActionPreview(value: unknown): CapabilityActionPreview {
  const r = object(value, ["action", "process", "expectedVersion", "changes", "normalizesFormatting", "noOp"]);
  if (r.normalizesFormatting !== true || !Array.isArray(r.changes) || r.changes.length > 1) throw new Error("Invalid capability preview.");
  const id = action(r.action);
  const changes = r.changes.map((value) => {
    const item = object(value, ["field", "value"]);
    if (item.field !== (id === "memory-lite" ? "memory" : "cron.operatorActions.enabled") || typeof item.value !== "string" || item.value.length > 4096) throw new Error("Invalid owned field.");
    return { field: item.field as "memory" | "cron.operatorActions.enabled", value: item.value };
  });
  return { action: id, process: processIdentity(r.process), expectedVersion: version(r.expectedVersion), changes, normalizesFormatting: true, noOp: boolean(r.noOp) };
}
export function parseCapabilityActionSaved(value: unknown): CapabilityActionSaved {
  const r = object(value, ["action", "process", "version", "changed"]);
  return { action: action(r.action), process: processIdentity(r.process), version: version(r.version), changed: boolean(r.changed) };
}

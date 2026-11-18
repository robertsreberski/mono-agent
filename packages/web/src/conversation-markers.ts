import { isManualCompactionReason, manualCompactionDiagnostic } from "@mono-agent/contracts";
import type { WebConversationMarkerPart } from "./contracts.js";

/** Validate marker payloads at storage/cache boundaries. */
export function isConversationMarker(value: unknown): value is WebConversationMarkerPart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  const date = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v));
  const route = (v: unknown): boolean => {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    return (r.model === null || typeof r.model === "string") && (r.effort === null || typeof r.effort === "string");
  };
  const project = (v: unknown): boolean => {
    if (v === null) return true;
    if (typeof v !== "object") return false;
    const p = v as Record<string, unknown>;
    return typeof p.id === "string" && typeof p.name === "string"
      && ["default", "blue", "purple", "amber", "rose"].includes(String(p.color));
  };
  const count = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  const compaction = (): boolean => typeof part.operationId === "string" && part.operationId.length > 0
    && (part.trigger === "manual" || part.trigger === "automatic")
    && (part.status === "succeeded" || part.status === "skipped" || part.status === "failed")
    && count(part.tokensBefore) && count(part.tokensAfter)
    && (part.tokenCountsExact === undefined || typeof part.tokenCountsExact === "boolean")
    && (part.reason === undefined || isManualCompactionReason(part.reason))
    && (part.httpStatus === undefined || (typeof part.httpStatus === "number" && Number.isInteger(part.httpStatus) && part.httpStatus >= 400 && part.httpStatus <= 599));
  return part.type === "conversation-marker" && date(part.at) && (
    part.kind === "compaction" ? compaction()
      : part.kind === "model" ? route(part.before) && route(part.after)
      : part.kind === "project" ? project(part.before) && project(part.after)
        : part.kind === "resumed" && date(part.previousMessageAt)
          && typeof part.idleMs === "number" && Number.isFinite(part.idleMs) && part.idleMs > 3_600_000
  );
}

/** Display only known codes. A future code means no explanation, not a provider error. */
export function compactionMarkerDiagnostic(data: { status?: unknown; reason?: unknown; httpStatus?: unknown }) {
  return (data.status === "skipped" || data.status === "failed") && isManualCompactionReason(data.reason)
    ? manualCompactionDiagnostic(data) : {};
}

const benignCompactionSkips = new Set([
  "nothing_to_compact", "below_trigger", "attempt_in_flight", "no_new_assistant", "insufficient_growth", "projected_savings",
]);

/** No-op bookkeeping is not a chat event. Don't hide any paid or uncertain work. */
export function isBenignAutomaticCompactionSkip(data: Record<string, unknown>): boolean {
  if (data.trigger === "manual" || data.status !== "skipped" || typeof data.reason !== "string" || !benignCompactionSkips.has(data.reason)) return false;
  const accounting = data.accounting as { requests?: unknown } | null | undefined;
  if (accounting === undefined || accounting === null) return true; // Older producers omit accounting on these no-ops.
  return Array.isArray(accounting.requests) && accounting.requests.every(row => row?.providerInvoked === false);
}

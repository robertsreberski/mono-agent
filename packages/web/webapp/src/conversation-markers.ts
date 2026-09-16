import type { ConversationMarkerPart } from "./types";

/** Validate marker payloads at storage/cache boundaries. */
export function isConversationMarker(value: unknown): value is ConversationMarkerPart {
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
  return part.type === "conversation-marker" && date(part.at) && (
    part.kind === "model" ? route(part.before) && route(part.after)
      : part.kind === "project" ? project(part.before) && project(part.after)
        : part.kind === "resumed" && date(part.previousMessageAt)
          && typeof part.idleMs === "number" && Number.isFinite(part.idleMs) && part.idleMs > 3_600_000
  );
}

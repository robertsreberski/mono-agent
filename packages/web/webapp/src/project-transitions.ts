import { hasSidecarAnchor, isSidecarRecord, mergeTransitions } from "./transition-sidecars";
import type { ProjectTransition } from "./types";

/** Immutable sidecars survive latest-window refreshes and merge independently of messages. */
export function mergeProjectTransitions(
  held: readonly ProjectTransition[] = [],
  incoming: readonly ProjectTransition[] = [],
): readonly ProjectTransition[] {
  return mergeTransitions(held, incoming);
}

/** Old device rows omit sidecars; malformed local data never reaches the renderer. */
export function readProjectTransitions(value: unknown): readonly ProjectTransition[] {
  if (!Array.isArray(value)) return [];
  const identity = (item: unknown): boolean => item === null || (isSidecarRecord(item)
    && typeof item.id === "string" && typeof item.name === "string"
    && ["default", "blue", "purple", "amber", "rose"].includes(String(item.color)));
  return value.filter((item): item is ProjectTransition => isSidecarRecord(item)
    && hasSidecarAnchor(item) && identity(item.before) && identity(item.after));
}

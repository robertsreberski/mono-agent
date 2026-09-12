import { hasSidecarAnchor, isSidecarRecord, mergeTransitions } from "./transition-sidecars";
import type { ModelTransition } from "./types";

/** Immutable sidecars survive latest-window refreshes and merge independently of messages. */
export function mergeModelTransitions(
  held: readonly ModelTransition[] = [],
  incoming: readonly ModelTransition[] = [],
): readonly ModelTransition[] {
  return mergeTransitions(held, incoming);
}

/** Old device rows omit sidecars; malformed local data never reaches the renderer. */
export function readModelTransitions(value: unknown): readonly ModelTransition[] {
  if (!Array.isArray(value)) return [];
  // A route end is a pair of nullable strings, and BOTH have to be there: a
  // half-read row would render a change against a side this console invented.
  const selection = (item: unknown): boolean => isSidecarRecord(item)
    && (item.model === null || typeof item.model === "string")
    && (item.effort === null || typeof item.effort === "string");
  return value.filter((item): item is ModelTransition => isSidecarRecord(item)
    && hasSidecarAnchor(item) && selection(item.before) && selection(item.after));
}

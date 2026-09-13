/**
 * Transcript sidecars: immutable rows that sit BETWEEN messages.
 *
 * They are read with a page and with the latest window, never written by this
 * console, and never replaced: the server only ever appends, so an id already
 * held is the same row. That is what lets a refresh of the newest window merge
 * with pages the operator scrolled back to, without either dropping the other.
 */
export function mergeTransitions<T extends { readonly id: number }>(
  held: readonly T[] = [],
  incoming: readonly T[] = [],
): readonly T[] {
  const ids = new Set(held.map((item) => item.id));
  const added = incoming.filter((item) => !ids.has(item.id));
  return added.length === 0 ? held : [...held, ...added].sort((a, b) => a.id - b.id);
}

export const isSidecarRecord = (item: unknown): item is Record<string, unknown> =>
  typeof item === "object" && item !== null && !Array.isArray(item);

/** The anchor every sidecar shares; malformed local data never reaches the renderer. */
export function hasSidecarAnchor(item: Record<string, unknown>): boolean {
  return Number.isSafeInteger(item.id) && Number(item.id) > 0
    && (item.afterMessageId === null || typeof item.afterMessageId === "string")
    && (item.turnId === null || typeof item.turnId === "string")
    && typeof item.createdAt === "string";
}

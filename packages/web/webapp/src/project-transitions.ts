import type { ProjectTransition } from "./types";

/** Immutable sidecars survive latest-window refreshes and merge independently of messages. */
export function mergeProjectTransitions(
  held: readonly ProjectTransition[] = [],
  incoming: readonly ProjectTransition[] = [],
): readonly ProjectTransition[] {
  const ids = new Set(held.map((item) => item.id));
  const added = incoming.filter((item) => !ids.has(item.id));
  return added.length === 0 ? held : [...held, ...added].sort((a, b) => a.id - b.id);
}

/** Old device rows omit sidecars; malformed local data never reaches the renderer. */
export function readProjectTransitions(value: unknown): readonly ProjectTransition[] {
  if (!Array.isArray(value)) return [];
  const record = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
  const identity = (item: unknown): boolean => item === null || (record(item)
    && typeof item.id === "string" && typeof item.name === "string"
    && ["default", "blue", "purple", "amber", "rose"].includes(String(item.color)));
  return value.filter((item): item is ProjectTransition => record(item)
    && Number.isSafeInteger(item.id) && Number(item.id) > 0
    && (item.afterMessageId === null || typeof item.afterMessageId === "string")
    && (item.turnId === null || typeof item.turnId === "string")
    && typeof item.createdAt === "string" && identity(item.before) && identity(item.after));
}

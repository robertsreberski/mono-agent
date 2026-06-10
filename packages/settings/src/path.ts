import type { SettingsJson } from "./types.js";

/**
 * Internal path helpers shared by field-group, patch-validator, and redact.
 *
 * These were previously byte-identical copies in each module. Centralizing them
 * keeps traversal/clone semantics consistent across read, write, validate, and
 * redact code paths. Not part of the package public API.
 */

/** Read the value at a dotted path, returning undefined when any segment is missing. */
export function readPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = obj;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Set a value at a dotted path, creating fresh plain objects for any missing,
 * null, non-object, or array intermediate segments.
 */
export function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[segment] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1] as string] = value;
}

/** Delete the value at a dotted path; no-op when any intermediate segment is missing. */
export function deletePath(obj: Record<string, unknown>, path: readonly string[]): void {
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== "object") {
      return;
    }
    cursor = next as Record<string, unknown>;
  }
  delete cursor[path[path.length - 1] as string];
}

/** Structurally clone a JSON-compatible value. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Structurally clone a SettingsJson value (typed wrapper around {@link clone}). */
export function cloneJson(value: SettingsJson): SettingsJson {
  return clone(value);
}

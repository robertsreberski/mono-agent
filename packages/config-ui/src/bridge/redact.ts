import type { MonoAgentConfigJson } from "@worklab-ai/config";

import type { FieldGroup } from "../schema/types.js";

/**
 * Marker returned in place of a secret value on GET responses.
 */
export interface RedactedSecret {
  readonly __secret: true;
  readonly set: boolean;
}

/**
 * Walk the registered field groups and replace secret values in the JSON
 * config with `{ __secret: true, set: <boolean> }` so the SPA can show a
 * "Set" badge without ever receiving the actual value.
 */
export function redactSecrets(
  json: MonoAgentConfigJson,
  groups: readonly FieldGroup[],
): MonoAgentConfigJson {
  const next = clone(json) as Record<string, unknown>;
  for (const group of groups) {
    for (const field of group.fields) {
      if (field.kind !== "secret") {
        continue;
      }
      const set = hasValue(next, field.path);
      setPath(next, field.path, { __secret: true, set } satisfies RedactedSecret);
    }
  }
  return next as MonoAgentConfigJson;
}

function hasValue(obj: Record<string, unknown>, path: readonly string[]): boolean {
  let cursor: unknown = obj;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null) {
    return false;
  }
  if (typeof cursor === "string") {
    return cursor.length > 0;
  }
  return true;
}

function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== "object") {
      const fresh: Record<string, unknown> = {};
      cursor[segment] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1] as string] = value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

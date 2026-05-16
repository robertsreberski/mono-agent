import type { FieldDefinition, FieldGroup, SettingsJson } from "./types.js";

export type FieldValue = string | number | boolean | undefined;

/**
 * Identity helper for type inference when hosts define a FieldGroup.
 */
export function defineFieldGroup(group: FieldGroup): FieldGroup {
  return group;
}

/**
 * Read a field's current value from a settings object. CSV fields collapse
 * arrays to a comma-joined string so renderers can share one input component.
 */
export function readFieldValue(
  json: SettingsJson,
  field: FieldDefinition,
): FieldValue {
  const raw = readPath(json as Record<string, unknown>, field.path);
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (field.kind === "csv") {
    if (!Array.isArray(raw)) {
      return undefined;
    }
    return raw.map(String).join(", ");
  }
  if (field.kind === "integer") {
    return typeof raw === "number" ? raw : undefined;
  }
  if (field.kind === "switch") {
    return typeof raw === "boolean" ? raw : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Apply an edit into a partial settings patch. Empty strings clear the path
 * from the sparse patch. CSV values split on commas.
 */
export function writeFieldValue(
  patch: SettingsJson,
  field: FieldDefinition,
  value: string,
): SettingsJson {
  const trimmed = value.trim();
  const next = cloneJson(patch) as Record<string, unknown>;
  if (trimmed.length === 0) {
    deletePath(next, field.path);
    return next as SettingsJson;
  }
  let coerced: unknown = trimmed;
  if (field.kind === "csv") {
    coerced = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  } else if (field.kind === "integer") {
    if (!/^\d+$/u.test(trimmed)) {
      throw new Error(`${field.id} must be an integer.`);
    }
    coerced = Number.parseInt(trimmed, 10);
  } else if (field.kind === "switch") {
    coerced = trimmed === "true";
  }
  setPath(next, field.path, coerced);
  return next as SettingsJson;
}

function readPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = obj;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
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

function deletePath(obj: Record<string, unknown>, path: readonly string[]): void {
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

function cloneJson(value: SettingsJson): SettingsJson {
  return JSON.parse(JSON.stringify(value)) as SettingsJson;
}

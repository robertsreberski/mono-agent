import { coerceInteger } from "./coerce.js";
import { cloneJson, deletePath, readPath, setPath } from "./path.js";
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
    const result = coerceInteger(trimmed, { min: field.min, max: field.max });
    if (!result.ok) {
      throw new Error(integerErrorMessage(field, result.reason));
    }
    coerced = result.value;
  } else if (field.kind === "switch") {
    coerced = trimmed === "true";
  }
  setPath(next, field.path, coerced);
  return next as SettingsJson;
}

/**
 * Read a field's raw stored value without CSV/kind coercion. Operator surfaces
 * use this to display secret markers or build their own renderings instead of
 * reimplementing path traversal.
 */
export function readRawFieldValue(json: SettingsJson, field: FieldDefinition): unknown {
  return readPath(json as Record<string, unknown>, field.path);
}

function integerErrorMessage(
  field: FieldDefinition,
  reason: "not_integer" | "below_min" | "above_max",
): string {
  switch (reason) {
    case "below_min":
      return `${field.id} must be >= ${field.min}.`;
    case "above_max":
      return `${field.id} must be <= ${field.max}.`;
    default:
      return `${field.id} must be an integer.`;
  }
}

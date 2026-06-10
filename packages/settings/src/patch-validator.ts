import { coerceInteger } from "./coerce.js";
import { setPath } from "./path.js";
import type { FieldDefinition, FieldGroup, SettingsJson } from "./types.js";

export interface PatchValidationOk {
  readonly ok: true;
  /** A new patch object containing only registered field paths. */
  readonly patch: SettingsJson;
}

export interface PatchValidationError {
  readonly ok: false;
  /** Dotted leaf paths that have no matching FieldDefinition. */
  readonly unregistered: readonly string[];
  /** Dotted leaf paths whose values failed kind/min/max coercion. */
  readonly invalid: readonly { readonly path: string; readonly reason: string }[];
}

export type PatchValidationResult = PatchValidationOk | PatchValidationError;

/**
 * Validate a sparse patch against the registered FieldGroup schema.
 */
export function validateSettingsPatch(
  rawPatch: unknown,
  groups: readonly FieldGroup[],
): PatchValidationResult {
  const fieldsByPath = indexFieldsByPath(groups);
  const leaves = collectLeaves(rawPatch);
  const unregistered: string[] = [];
  const invalid: { path: string; reason: string }[] = [];
  const validated: { field: FieldDefinition; value: unknown }[] = [];

  for (const leaf of leaves) {
    const key = leaf.path.join(".");
    const field = fieldsByPath.get(key);
    if (!field) {
      unregistered.push(key);
      continue;
    }
    const coerced = coerceLeaf(field, leaf.value);
    if (!coerced.ok) {
      invalid.push({ path: key, reason: coerced.reason });
      continue;
    }
    validated.push({ field, value: coerced.value });
  }

  if (unregistered.length > 0 || invalid.length > 0) {
    return { ok: false, unregistered, invalid };
  }

  const cleanPatch: Record<string, unknown> = {};
  for (const { field, value } of validated) {
    if (value === undefined) {
      continue;
    }
    setPath(cleanPatch, field.path, value);
  }
  return { ok: true, patch: cleanPatch as SettingsJson };
}

interface Leaf {
  readonly path: readonly string[];
  readonly value: unknown;
}

function collectLeaves(input: unknown, prefix: readonly string[] = []): readonly Leaf[] {
  if (input === null || input === undefined) {
    if (prefix.length === 0) {
      return [];
    }
    return [{ path: prefix, value: input }];
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return [{ path: prefix, value: input }];
  }
  const out: Leaf[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out.push(...collectLeaves(value, [...prefix, key]));
  }
  return out;
}

function indexFieldsByPath(groups: readonly FieldGroup[]): Map<string, FieldDefinition> {
  const map = new Map<string, FieldDefinition>();
  for (const group of groups) {
    for (const field of group.fields) {
      map.set(field.path.join("."), field);
    }
  }
  return map;
}

interface CoerceOk {
  readonly ok: true;
  readonly value: unknown;
}
interface CoerceFail {
  readonly ok: false;
  readonly reason: string;
}
type CoerceResult = CoerceOk | CoerceFail;

function coerceLeaf(field: FieldDefinition, raw: unknown): CoerceResult {
  if (raw === null) {
    return { ok: true, value: undefined };
  }
  switch (field.kind) {
    case "string":
    case "secret":
    case "path": {
      if (typeof raw !== "string") {
        return { ok: false, reason: `${field.id} must be a string.` };
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return { ok: true, value: undefined };
      }
      return { ok: true, value: trimmed };
    }
    case "select": {
      if (typeof raw !== "string") {
        return { ok: false, reason: `${field.id} must be a string.` };
      }
      if (raw.trim().length === 0) {
        return { ok: true, value: undefined };
      }
      const allowed = (field.options ?? []).map((opt) => opt.value);
      if (allowed.length > 0 && !allowed.includes(raw)) {
        return {
          ok: false,
          reason: `${field.id} must be one of: ${allowed.join(", ")}.`,
        };
      }
      return { ok: true, value: raw };
    }
    case "switch": {
      if (typeof raw === "boolean") {
        return { ok: true, value: raw };
      }
      if (raw === "true" || raw === "false") {
        return { ok: true, value: raw === "true" };
      }
      return { ok: false, reason: `${field.id} must be a boolean.` };
    }
    case "integer": {
      const result = coerceInteger(raw, { min: field.min, max: field.max });
      if (!result.ok) {
        switch (result.reason) {
          case "below_min":
            return { ok: false, reason: `${field.id} must be >= ${field.min}.` };
          case "above_max":
            return { ok: false, reason: `${field.id} must be <= ${field.max}.` };
          default:
            return { ok: false, reason: `${field.id} must be an integer.` };
        }
      }
      return { ok: true, value: result.value };
    }
    case "csv": {
      if (Array.isArray(raw)) {
        const cleaned = raw
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0);
        return { ok: true, value: cleaned.length === 0 ? undefined : cleaned };
      }
      if (typeof raw === "string") {
        const cleaned = raw
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        return { ok: true, value: cleaned.length === 0 ? undefined : cleaned };
      }
      return { ok: false, reason: `${field.id} must be a string or array of strings.` };
    }
    default:
      return { ok: false, reason: `${field.id} has unsupported kind.` };
  }
}

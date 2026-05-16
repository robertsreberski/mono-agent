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
      const value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim().length > 0 && /^-?\d+$/u.test(raw.trim())
            ? Number(raw.trim())
            : Number.NaN;
      if (!Number.isInteger(value)) {
        return { ok: false, reason: `${field.id} must be an integer.` };
      }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, reason: `${field.id} must be >= ${field.min}.` };
      }
      if (field.max !== undefined && value > field.max) {
        return { ok: false, reason: `${field.id} must be <= ${field.max}.` };
      }
      return { ok: true, value };
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

function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
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

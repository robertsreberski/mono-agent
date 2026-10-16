












export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}









import {
normalizeOptionalString,
readBoolean,
readChoice,
readCsv,
readInteger
} from "@mono-agent/contracts";




import { invalidJson,MonoAgentConfigError } from "../errors.js";


/**
 * JSON scalar coercion for direct `mono-agent.config.json` parsing.
 *
 * The shared `@mono-agent/contracts` coercers operate on strings, so a
 * JSON scalar is rendered to its string form before validation. Numbers and
 * booleans stringify exactly the way the previous JSON-to-string projection
 * rendered them, which keeps every range, enum and choice diagnostic identical
 * apart from naming the JSON path instead of a variable nobody set. Objects and
 * arrays are never scalars: they fail closed with the path the operator edits.
 */
export function jsonString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new MonoAgentConfigError("invalid_json", `${path} must be a string.`, { path });
}

export function requireJsonString(value: unknown, path: string): string {
  const normalized = normalizeOptionalString(jsonString(value, path));
  if (normalized === undefined) {
    throw new MonoAgentConfigError("invalid_json", `${path} is required.`, { path });
  }
  return normalized;
}

export function jsonInteger(
  value: unknown,
  path: string,
  fallback: number,
  bounds?: { readonly min: number; readonly max: number },
): number {
  return readInteger(jsonString(value, path), path, fallback, invalidJson, bounds);
}

export function jsonOptionalInteger(
  value: unknown,
  path: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  if (value === undefined) return undefined;
  return readInteger(jsonString(value, path), path, bounds.min, invalidJson, bounds);
}

export function jsonOptionalNumber(
  value: unknown,
  path: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `${path} must be a number between ${bounds.min} and ${bounds.max}.`,
        { path, reason: "out_of_range" },
      );
    }
    return value;
  }
  const normalized = normalizeOptionalString(jsonString(value, path));
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${path} must be a number between ${bounds.min} and ${bounds.max}.`,
      { path, reason: "out_of_range" },
    );
  }
  return parsed;
}

export function jsonBoolean(value: unknown, path: string, fallback: boolean): boolean {
  return readBoolean(jsonString(value, path), path, fallback, invalidJson);
}

export function jsonOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return readBoolean(jsonString(value, path), path, false, invalidJson);
}

export function jsonChoice<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
  fallback: T,
): T {
  return readChoice(jsonString(value, path), path, choices, fallback, invalidJson);
}

/**
 * Read a JSON string array. Arrays are kept element-wise so values containing
 * commas survive intact; a lone comma-separated string is still split for
 * tolerance. Anything else fails closed with the JSON path.
 */
export function jsonStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return readCsv(value);
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") {
        throw new MonoAgentConfigError("invalid_json", `${path} must be an array of strings.`, { path });
      }
      return entry;
    }).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  throw new MonoAgentConfigError("invalid_json", `${path} must be an array of strings.`, { path });
}

/**
 * Narrow an optional JSON block to a record. Missing stays missing; anything
 * present but not an object fails closed with the block path.
 */
export function jsonRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new MonoAgentConfigError("invalid_json", `${path} must be an object.`, { path });
}

/**
 * Tolerant container access for the pure parent blocks (`runtime`, `context`,
 * `tools`, ...). A malformed parent behaves as absent so the required-field
 * and default logic below still produces the authoritative diagnostic.
 */
export function jsonContainer(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function assertJsonScalarFields(record: Record<string, unknown>, path: string, fields: Readonly<Record<string, "string" | "number" | "boolean">>): void {
  for (const [field, kind] of Object.entries(fields)) {
    if (record[field] !== undefined && typeof record[field] !== kind) {
      const fieldPath = `${path}.${field}`;
      throw new MonoAgentConfigError("invalid_json", `${fieldPath} must be a ${kind}.`, { path: fieldPath });
    }
  }
}

/** Read an optional integer field from a parsed object, bounded and integer-checked. */
export function readObjectInteger(
  object: Record<string, unknown>,
  key: string,
  source: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source}.${key} must be an integer between ${bounds.min} and ${bounds.max}.`,
      { path: `${source}.${key}` },
    );
  }
  return value;
}

export function readObjectString(
  object: Record<string, unknown>,
  key: string,
  source: string,
  required: boolean,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    if (required) {
      throw new MonoAgentConfigError("invalid_json", `${source}.${key} is required.`, { path: `${source}.${key}` });
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new MonoAgentConfigError("invalid_json", `${source}.${key} must be a non-empty trimmed string.`, { path: `${source}.${key}` });
  }
  return value;
}

export function readObjectBoolean(
  object: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
  source: string,
): boolean {
  const value = object[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new MonoAgentConfigError("invalid_json", `${source}.${key} must be a boolean.`, { path: `${source}.${key}` });
}

export function readPlainObject(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source} must be an object.`, { path: source });
  }
  return { ...value };
}

import type { MonoAgentConfigJson } from "@worklab-ai/config";
import { identityGroup } from "./core/identity.js";
import { memoryGroup } from "./core/memory.js";
import { runtimeGroup } from "./core/runtime.js";
import { telegramGroup } from "./core/telegram.js";
import { toolsGroup } from "./core/tools.js";
import type { FieldDefinition, FieldGroup, FieldGroupRegistry } from "./types.js";

/**
 * Identity helper for type inference when hosts define a FieldGroup.
 */
export function defineFieldGroup(group: FieldGroup): FieldGroup {
  return group;
}

/**
 * Built-in core field groups: identity, runtime, memory, tools, telegram.
 *
 * Hosts can prepend, append, or replace entries when they call
 * startConfigUiBridge to control which sections appear in the UI.
 */
export const CORE_FIELD_GROUPS: FieldGroupRegistry = [
  identityGroup,
  runtimeGroup,
  memoryGroup,
  toolsGroup,
  telegramGroup,
];

/**
 * Read a field's current value from a JSON config object. Returns
 * `undefined` when the path is not set. CSV fields collapse arrays to
 * a comma-joined string so the same renderer can be used in the SPA.
 */
export function readFieldValue(
  json: MonoAgentConfigJson,
  field: FieldDefinition,
): string | number | undefined {
  const raw = readPath(json as unknown as Record<string, unknown>, field.path);
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
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Apply an edit from the SPA into a partial JSON config, ready for the
 * bridge PUT. Empty strings clear the path. CSV values split on commas.
 * Throws if the field kind is integer and the input is not parseable.
 */
export function writeFieldValue(
  patch: MonoAgentConfigJson,
  field: FieldDefinition,
  value: string,
): MonoAgentConfigJson {
  const trimmed = value.trim();
  const next = cloneJson(patch) as Record<string, unknown>;
  if (trimmed.length === 0) {
    deletePath(next, field.path);
    return next as MonoAgentConfigJson;
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
  return next as MonoAgentConfigJson;
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

function cloneJson(value: MonoAgentConfigJson): MonoAgentConfigJson {
  return JSON.parse(JSON.stringify(value)) as MonoAgentConfigJson;
}

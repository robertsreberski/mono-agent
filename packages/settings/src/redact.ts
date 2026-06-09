import { clone, setPath } from "./path.js";
import type { FieldGroup, SettingsJson } from "./types.js";

export interface RedactedSecret {
  readonly __secret: true;
  readonly set: boolean;
}

/** Alias for {@link RedactedSecret} — the marker shape written in place of secrets. */
export type SecretMarker = RedactedSecret;

/**
 * Narrow an unknown value to a {@link SecretMarker}. Operator surfaces use this
 * to detect redacted secret fields instead of hand-rolling `__secret` checks.
 */
export function isSecretMarker(value: unknown): value is SecretMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly __secret?: unknown }).__secret === true &&
    typeof (value as { readonly set?: unknown }).set === "boolean"
  );
}

/**
 * Replace registered secret values with markers so operator surfaces can show
 * presence without receiving raw secret material.
 */
export function redactSettingsForFieldGroups(
  json: SettingsJson,
  groups: readonly FieldGroup[],
): SettingsJson {
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
  return next as SettingsJson;
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

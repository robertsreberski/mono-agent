/**
 * Shared integer coercion used by both writeFieldValue (field-group.ts) and
 * validateSettingsPatch (patch-validator.ts) so negatives and min/max bounds are
 * handled identically across the write and validate code paths. Not part of the
 * package public API.
 */

export interface IntegerCoercionOk {
  readonly ok: true;
  readonly value: number;
}

export interface IntegerCoercionError {
  readonly ok: false;
  readonly reason: "not_integer" | "below_min" | "above_max";
}

export type IntegerCoercionResult = IntegerCoercionOk | IntegerCoercionError;

export interface IntegerBounds {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

/**
 * Coerce a raw value (number or numeric string, signed) to a bounded integer.
 * Strings are trimmed before parsing; only `-?\d+` strings parse. The caller
 * owns message formatting so existing error strings stay byte-identical.
 */
export function coerceInteger(raw: unknown, bounds: IntegerBounds = {}): IntegerCoercionResult {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0 && /^-?\d+$/u.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isInteger(value)) {
    return { ok: false, reason: "not_integer" };
  }
  if (bounds.min !== undefined && value < bounds.min) {
    return { ok: false, reason: "below_min" };
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return { ok: false, reason: "above_max" };
  }
  return { ok: true, value };
}

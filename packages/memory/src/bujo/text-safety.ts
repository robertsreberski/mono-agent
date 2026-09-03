/**
 * Structural safety for text that will be written into canonical memory.
 *
 * This is a corruption boundary the store owns on behalf of every caller, not a
 * content-policy boundary: it rejects code points that would corrupt the bullet
 * grammar, smuggle terminal/bidi control sequences into text an operator later
 * reads, or blow a durable size bound. Judging what a memory *says* — for
 * example whether it carries a credential — belongs to the caller that has the
 * surrounding context, not here.
 */

/** Lone surrogates, C0 controls (tab/LF/CR excluded), DEL, and C1 controls. */
const UNSAFE_CODE_POINTS = /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/** Explicit bidirectional formatting controls, which can spoof rendered order. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** The bullet metadata delimiter; text carrying it would corrupt the grammar. */
export const BULLET_META_DELIMITER = "<!--mem";

/**
 * Validate one durable text field and return it unchanged.
 *
 * `subject` and `label` compose the thrown message so each caller keeps its own
 * diagnostic wording (`completed-turn summary`, `remembered text`, …).
 * `allowLayoutWhitespace` permits tab/LF/CR for callers that normalize layout
 * whitespace themselves; callers that store the value as one line reject them.
 * `rejectBulletDelimiter` is opt-in so this stays byte-compatible with the
 * completed-turn admission path it was extracted from.
 */
export function assertBoundedMemoryText(
  value: unknown,
  subject: string,
  label: string,
  maxBytes: number,
  allowLayoutWhitespace: boolean,
  rejectBulletDelimiter = false,
): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || UNSAFE_CODE_POINTS.test(value)
    || BIDI_CONTROLS.test(value)
    || (rejectBulletDelimiter && value.includes(BULLET_META_DELIMITER))
    || (!allowLayoutWhitespace && /[\r\n\t]/u.test(value))) {
    throw new Error(`memory-bujo: ${subject} ${label} is invalid or exceeds its bound.`);
  }
  return value;
}

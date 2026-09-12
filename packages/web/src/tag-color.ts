import type { WebTagColor } from "./contracts.js";
import { WebConsoleError } from "./errors.js";

/** Source-owned palette: never accepts CSS, URLs, or arbitrary style values. */
export function parseTagColor(value: unknown): WebTagColor {
  if (value === "default" || value === "blue" || value === "purple" || value === "amber" || value === "rose"
    || value === "green" || value === "teal" || value === "red") return value;
  throw new WebConsoleError("invalid_tag", "Choose default, blue, purple, amber, rose, green, teal, or red for tag color.", 400);
}

export function parseTagName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WebConsoleError("invalid_tag", "Tag names must be one non-empty line of at most 120 characters without control characters.", 400);
  }
  return name;
}

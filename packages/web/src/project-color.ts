import type { WebProjectColor } from "./contracts.js";
import { WebConsoleError } from "./errors.js";

/** Source-owned palette: never accepts CSS, URLs, or arbitrary style values. */
export function parseProjectColor(value: unknown): WebProjectColor {
  if (value === "default" || value === "blue" || value === "purple" || value === "amber" || value === "rose") return value;
  throw new WebConsoleError("invalid_project", "Choose default, blue, purple, amber, or rose for project color.", 400);
}

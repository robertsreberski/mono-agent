// @ts-check
import { resolve } from "node:path";
/** One cache/path identity for runtime and administrative native storage. */
export function normalizeDurableSessionsRoot(value) {
  return typeof value === "string" && value.trim() ? resolve(value.trim()) : null;
}

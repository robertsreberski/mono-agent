// @ts-check
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
/** One cache/path identity for runtime and administrative native storage. */
export function normalizeDurableSessionsRoot(value) {
  return typeof value === "string" && value.trim() ? resolve(value.trim()) : null;
}

/** Refuse pre-release storage before permissions, locks or journals are changed. */
export function assertSupportedSessionsRoot(root) {
  const path = join(root, "mono-v2");
  try { lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`Sessions root contains ${path}, written by a pre-release build; restore a backup or remove it after checking nothing in it is needed. No automatic migration is supported.`);
}

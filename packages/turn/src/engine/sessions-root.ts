// @ts-check
import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
/** One cache/path identity for runtime and administrative native storage. */
export function normalizeDurableSessionsRoot(value: any): string;
export function normalizeDurableSessionsRoot(value: any): string | null {
  return typeof value === "string" && value.trim() ? resolve(value.trim()) : null;
}

/** Refuse pre-release storage before permissions, locks or journals are changed. */
export function assertSupportedSessionsRoot(root: any): void {
  const path = probeUnsupportedSessionsRootSync(root);
  if (path === undefined) return;
  throw Object.assign(new Error(`Sessions root contains ${path}, written by a pre-release build; restore a backup or remove it after checking nothing in it is needed. No automatic migration is supported.`),
    { code: "ERR_SESSIONS_ROOT_UNSUPPORTED" });
}

function unsupportedRootPath(root: string): string { return join(root, "mono-v2"); }

/**
 * Read-only presence probe; lstat deliberately counts dangling symlinks as present.
 */
export async function probeUnsupportedSessionsRoot(root: string): Promise<string | undefined> {
  const path = unsupportedRootPath(root);
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  return path;
}

function probeUnsupportedSessionsRootSync(root: string): string | undefined {
  const path = unsupportedRootPath(root);
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  return path;
}

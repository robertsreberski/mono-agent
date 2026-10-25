import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSecureReadableDirectory, assertSecureReadableFile } from "./paths.js";

const PREFIX = ".continuity-purge-";
// Accept the old UUID journal names until their owed purges have drained.
const PATTERN = /^\.continuity-purge-(?:[0-9a-f]{64}|[0-9a-f-]{36})\.json(?:\.applying)?$/;
const TEMP_PATTERN = /^\.continuity-purge-(?:[0-9a-f]{64}|[0-9a-f-]{36})\.json\.tmp$/;
export interface ContinuityPurge {
  readonly scope: "logical" | "physical";
  readonly conversationId: string;
}
interface PendingPurge extends ContinuityPurge { readonly path: string }

/** Caller holds the canonical root transaction and the scope's canonical owner. */
export function persistContinuityPurge(root: string, purge: ContinuityPurge): void {
  const writeStarted = Date.now();
  assertSecureReadableDirectory(root);
  validatePurgeId(purge.conversationId);
  const key = createHash("sha256").update(JSON.stringify([purge.scope, purge.conversationId])).digest("hex");
  const path = join(root, `${PREFIX}${key}.json`), temporary = `${path}.tmp`;
  // The same-key temp is necessarily stale under this root transaction, even
  // after wall-clock rollback. Other keys retain the conservative mtime guard.
  // Never follow an insecure entry.
  for (const name of readdirSync(root).filter(name => TEMP_PATTERN.test(name))) {
    const path = join(root, name);
    try {
      assertSecureReadableFile(path);
      if (path === temporary || lstatSync(path).mtimeMs < writeStarted) unlinkSync(path);
    } catch (error) { if (!["ENOENT", "history_security_invalid"].includes((error as { code: string }).code)) throw error; }
  }
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(purge)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  syncRoot(root);
}

/** Count/inspect independently: one invalid intent must not hide valid ones. */
export function inspectContinuityPurges(root: string): { pending: readonly PendingPurge[]; invalid: number } {
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], invalid: 0 }; throw error; }
  assertSecureReadableDirectory(root);
  const pending: PendingPurge[] = [];
  let invalid = 0;
  for (const name of names.filter(name => name.startsWith(PREFIX) && /\.json(?:\.applying)?$/.test(name))) {
    if (!PATTERN.test(name)) { invalid++; continue; }
    const path = join(root, name);
    try {
      if (assertSecureReadableFile(path) > 32 * 1024) throw new Error("Oversized continuity purge journal.");
      const value = JSON.parse(readFileSync(path, "utf8")) as ContinuityPurge;
      if ((value.scope !== "logical" && value.scope !== "physical") || Object.keys(value).sort().join() !== "conversationId,scope") throw new Error("Invalid continuity purge journal.");
      validatePurgeId(value.conversationId);
      pending.push({ ...value, path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid++;
    }
  }
  // Recover a prior claim before claiming a newer intent at the same base name.
  pending.sort((a, b) => Number(b.path.endsWith(".applying")) - Number(a.path.endsWith(".applying")));
  return { pending, invalid };
}

export function pendingContinuityPurges(root: string): readonly PendingPurge[] {
  const result = inspectContinuityPurges(root);
  if (result.invalid) throw new Error("Invalid continuity purge journal; continuity is unavailable.");
  return result.pending;
}

/** SQLite writer ownership is held. The fixed claim prevents unlinking a newer
 * canonical intent written at the deterministic base name during this purge. */
export function claimContinuityPurge(root: string, path: string): string {
  if (path.endsWith(".applying")) return path;
  const claimed = `${path}.applying`;
  // A corrupt prior claim must not be overwritten by a valid new intent. Only
  // this SQLite owner creates claim files, so the absence check is owner-safe.
  try { lstatSync(claimed); throw new Error("Continuity purge claim is still pending."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  renameSync(path, claimed);
  syncRoot(root);
  return claimed;
}

/** Called only after the destructive SQLite transaction has durably committed. */
export function acknowledgeContinuityPurge(root: string, path: string): void {
  unlinkSync(path);
  syncRoot(root);
}
function syncRoot(root: string): void {
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Canonical IDs permit non-NUL controls; do not narrow legacy reset admission.
function validatePurgeId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 4 * 1024 || value.includes("\0")) {
    throw new TypeError("Invalid canonical continuity purge scope.");
  }
}

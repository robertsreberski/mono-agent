import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSecureReadableDirectory, assertSecureReadableFile, normalizeId } from "./paths.js";

const PREFIX = ".continuity-purge-";
const PATTERN = /^\.continuity-purge-[0-9a-f-]{36}\.json$/;
export interface ContinuityPurge {
  readonly scope: "logical" | "physical";
  readonly conversationId: string;
}

/** Canonical-root journal, deliberately independent of the optional SQLite store. */
export function persistContinuityPurge(root: string, purge: ContinuityPurge): void {
  assertSecureReadableDirectory(root);
  normalizeId(purge.conversationId, "conversationId");
  const path = join(root, `${PREFIX}${randomUUID()}.json`), temporary = `${path}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(purge)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  syncRoot(root);
}

/** Invalid/unreadable journals fail closed for readers and prevent writer admission. */
export function pendingContinuityPurges(root: string): readonly (ContinuityPurge & { readonly path: string })[] {
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  assertSecureReadableDirectory(root);
  return names.filter(name => PATTERN.test(name)).flatMap(name => {
    const path = join(root, name);
    try {
      if (assertSecureReadableFile(path) > 8192) throw new Error("Oversized continuity purge journal.");
      const value = JSON.parse(readFileSync(path, "utf8")) as ContinuityPurge;
      if ((value.scope !== "logical" && value.scope !== "physical") || Object.keys(value).sort().join() !== "conversationId,scope") throw new Error("Invalid continuity purge journal.");
      normalizeId(value.conversationId, "conversationId");
      return [{ ...value, path }];
    } catch (error) {
      // A concurrent writer may already have durably applied this immutable intent.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
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

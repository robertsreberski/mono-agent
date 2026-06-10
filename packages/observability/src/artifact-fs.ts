import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

/**
 * Shared, security-critical filesystem and validation helpers for the
 * observability artifact store. These guards are duplicated nowhere else;
 * every recorder/reader/registry module imports from here so the traversal
 * defenses stay identical.
 */

export const DEFAULT_MAX_RUNS = 50;
export const DEFAULT_MAX_EVENTS_PER_RUN = 500;
export const DEFAULT_MAX_STRING_BYTES = 4_096;

/** Thrown to abort with a caller-supplied, code-tagged error. */
export type Raise = (message: string) => never;

/** Variant that also forwards the offending field name into the error details. */
export type RaiseField = (message: string, field: string) => never;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Collapse a candidate identifier into a path-safe artifact base name. Any
 * character outside `[a-z0-9._-]` is replaced so the result can never contain a
 * path separator; `safeJoin` still enforces containment as a second layer.
 */
export function safeArtifactName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "run";
}

/**
 * Reject a run id that could traverse outside the artifact directory. Empty/
 * non-string ids raise via `raiseEmpty`; traversal-shaped ids raise via
 * `raiseTraversal`. The two callbacks let each package keep its distinct error
 * code/message surface (recorded-runs and trace-sources historically differed
 * on the empty-id code), while the guard logic stays identical.
 */
export function normalizeRunId(runId: string, raiseTraversal: Raise, raiseEmpty: Raise = raiseTraversal): string {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    raiseEmpty("runId must be a non-empty string.");
  }
  const trimmed = runId.trim();
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    raiseTraversal("runId cannot contain path separators or '..'.");
  }
  return trimmed;
}

/**
 * Resolve `fileName` under `root` and fail closed if the result escapes the
 * (normalized, separator-terminated) root. `raise` carries the package-specific
 * escape message ("escapes artifactDir" vs "escapes registryDir").
 */
export function safeJoin(root: string, fileName: string, raise: Raise): string {
  const normalizedRoot = normalize(resolve(root));
  const resolved = normalize(join(normalizedRoot, fileName));
  const safeRoot = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (!resolved.startsWith(safeRoot)) {
    raise("escape");
  }
  return resolved;
}

export function positiveInteger(value: number | undefined, fallback: number, field: string, raise: RaiseField): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    raise(`${field} must be a positive integer.`, field);
  }
  return value;
}

export function minInteger(value: number | undefined, fallback: number, min: number, field: string, raise: RaiseField): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min) {
    raise(`${field} must be an integer of at least ${min}.`, field);
  }
  return value;
}

/**
 * Write a serialized artifact atomically via a temp file + rename, so readers
 * (list/read) never observe a half-written file. The registry already did this;
 * the recorder now shares the same primitive for its summary + events files.
 */
export async function writeJsonAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

export { mkdir };

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

import type { Raise } from "./guards.js";

/**
 * Shared, security-critical filesystem and validation helpers for the
 * observability artifact store. These guards are duplicated nowhere else;
 * every recorder/reader/registry module imports from here so the traversal
 * defenses stay identical.
 *
 * The node-free validation helpers and limit constants now live in
 * {@link ./guards.ts} and are re-exported here so every existing importer keeps
 * its current import surface while the node:fs/node:path helpers stay co-located
 * with the filesystem primitives.
 */

export {
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_STRING_BYTES,
  errorMessage,
  isErrno,
  isRecord,
  minInteger,
  positiveInteger,
  stringField,
} from "./guards.js";
export type { Raise, RaiseField } from "./guards.js";

/**
 * Collapse a candidate identifier into a path-safe artifact base name. Any
 * character outside `[a-z0-9._-]` is replaced so the result can never contain a
 * path separator; `safeJoin` still enforces containment as a second layer.
 */
export function safeArtifactName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "run";
}

/** Whether a run id satisfies the shared non-empty/path-containment guard. */
export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === "string"
    && runId.trim().length > 0
    && !runId.trim().includes("/")
    && !runId.trim().includes("\\")
    && !runId.trim().includes("..");
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
  if (!isSafeRunId(trimmed)) {
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

let atomicWriteSequence = 0;

/**
 * Write a serialized artifact atomically via a temp file + rename, so readers
 * (list/read) never observe a half-written file. The registry already did this;
 * the recorder now shares the same primitive for its summary + events files.
 * The temp name carries a per-process sequence (not a timestamp) so concurrent
 * writers in the same millisecond never collide on the temp path.
 */
export async function writeJsonAtomic(filePath: string, contents: string): Promise<void> {
  atomicWriteSequence += 1;
  const tempPath = `${filePath}.${process.pid}.${atomicWriteSequence}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

export { mkdir };

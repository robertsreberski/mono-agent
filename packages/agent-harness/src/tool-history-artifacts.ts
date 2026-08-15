import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Canonicalize the configured tool-output root without creating it. */
export function canonicalToolArtifactRoot(path: string): string {
  if (!isAbsolute(path)) throw new TypeError("tool history artifact root must be absolute.");
  const normalized = resolve(path);
  try {
    lstatSync(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      let existing = dirname(normalized);
      for (;;) {
        try {
          return resolve(canonicalAccessibleDirectory(existing), relative(existing, normalized));
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          const parent = dirname(existing);
          if (parent === existing) return normalized;
          existing = parent;
        }
      }
    }
    throw error;
  }
  // Keep a configured directory alias usable, but resolve it before accepting
  // the root so a file target, dangling/cyclic link, or inaccessible directory
  // cannot become a trusted containment boundary.
  return canonicalAccessibleDirectory(normalized);
}

function canonicalAccessibleDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) {
    throw new TypeError("tool history artifact root must be a directory.");
  }
  accessSync(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}

/** Validate a newly reported artifact without following provider-controlled symlinks. */
export function validatedToolHistoryArtifactPath(
  candidate: string,
  artifactRoot: string,
  runId: string,
  trustedRootAliases: readonly string[] = [artifactRoot],
): string | undefined {
  const normalized = normalizedCandidate(candidate, artifactRoot, runId, trustedRootAliases);
  if (normalized === undefined) return undefined;
  return safeRegularFileExists(normalized.runRoot, normalized.path) ? normalized.path : undefined;
}

/** Recompute availability for a path that was validated before insertion. */
export function toolHistoryArtifactAvailable(
  candidate: string,
  artifactRoot: string,
  runId: string,
): boolean {
  try {
    const normalized = normalizedCandidate(candidate, artifactRoot, runId, [artifactRoot]);
    return normalized !== undefined && safeRegularFileExists(normalized.runRoot, normalized.path);
  } catch {
    // Availability is a total read-time probe. Configuration/open validation
    // remains strict, but a root that changed afterward is simply unavailable
    // and must not surface a host path through an I/O error.
    return false;
  }
}

function normalizedCandidate(
  candidate: string,
  artifactRoot: string,
  runId: string,
  trustedRootAliases: readonly string[],
): { readonly runRoot: string; readonly path: string } | undefined {
  if (!isAbsolute(candidate)) return undefined;
  const base = canonicalToolArtifactRoot(artifactRoot);
  const canonicalRunRoot = resolve(base, sanitizeRunId(runId));
  const lexicalCandidate = resolve(candidate);
  // Prove lexical containment against host-configured roots before touching
  // any provider-supplied path. A trusted root may have a platform alias (for
  // example macOS /var -> /private/var), but candidate components never earn
  // canonicalization and are checked below without following symlinks.
  for (const alias of new Set([base, ...trustedRootAliases.map((value) => resolve(value))])) {
    const aliasRunRoot = resolve(alias, sanitizeRunId(runId));
    const relation = relative(aliasRunRoot, lexicalCandidate);
    if (relation.length === 0 || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      continue;
    }
    return { runRoot: canonicalRunRoot, path: resolve(canonicalRunRoot, relation) };
  }
  return undefined;
}

function safeRegularFileExists(runRoot: string, candidate: string): boolean {
  const relation = relative(runRoot, candidate);
  const segments = relation.split(sep).filter(Boolean);
  let cursor = runRoot;
  try {
    const rootInfo = lstatSync(cursor);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = join(cursor, segments[index]!);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) return false;
      if (index < segments.length - 1 && !info.isDirectory()) return false;
      if (index === segments.length - 1) return info.isFile();
    }
  } catch {
    return false;
  }
  return false;
}

function sanitizeRunId(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "manual";
}

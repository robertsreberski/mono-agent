import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
          lstatSync(existing);
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          const parent = dirname(existing);
          if (parent === existing) return normalized;
          existing = parent;
          continue;
        }
        // An existing ancestor may itself be a dangling symlink. Keep the
        // realpath failure authoritative instead of climbing past that link
        // and accepting a merely lexical containment boundary.
        return resolve(canonicalAccessibleDirectory(existing), relative(existing, normalized));
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

export interface ToolHistoryArtifactSinkInput {
  readonly filename: string;
  readonly buffer: Buffer;
  readonly toolName: string;
  readonly toolUseId: string | null;
}

/** Build one synchronous, best-effort artifact writer bound to a trusted run. */
export function createToolHistoryArtifactSink(options: {
  readonly artifactRoot: string;
  readonly runId: string;
}): (artifact: ToolHistoryArtifactSinkInput) => string | null {
  return (artifact) => {
    let descriptor: number | undefined;
    let createdPath: string | undefined;
    let createdIdentity: { readonly dev: number; readonly ino: number } | undefined;
    try {
      if (!validArtifactFilename(artifact?.filename) || !Buffer.isBuffer(artifact?.buffer)) return null;
      const artifactRoot = canonicalToolArtifactRoot(options.artifactRoot);
      ensurePrivateDirectory(artifactRoot);
      const runRoot = resolve(artifactRoot, sanitizeRunId(options.runId));
      ensurePrivateDirectory(runRoot);
      const candidate = join(runRoot, artifact.filename);
      if (dirname(candidate) !== runRoot) return null;

      descriptor = openSync(
        candidate,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      createdPath = candidate;
      const opened = fstatSync(descriptor);
      assertPrivateArtifactFile(opened, 0);
      createdIdentity = { dev: opened.dev, ino: opened.ino };
      let offset = 0;
      while (offset < artifact.buffer.length) {
        const written = writeSync(descriptor, artifact.buffer, offset, artifact.buffer.length - offset);
        if (written <= 0) throw new Error("Tool artifact write made no progress.");
        offset += written;
      }
      fsyncSync(descriptor);
      const complete = fstatSync(descriptor);
      assertPrivateArtifactFile(complete, artifact.buffer.length);
      closeSync(descriptor);
      descriptor = undefined;

      const named = lstatSync(candidate);
      assertPrivateArtifactFile(named, artifact.buffer.length);
      if (named.dev !== complete.dev || named.ino !== complete.ino) {
        throw new Error("Tool artifact path changed during publication.");
      }
      return validatedToolHistoryArtifactPath(candidate, artifactRoot, options.runId) ?? null;
    } catch {
      try {
        if (descriptor !== undefined) closeSync(descriptor);
      } catch { /* best-effort */ }
      try {
        if (createdPath !== undefined && createdIdentity !== undefined) {
          const current = lstatSync(createdPath);
          if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) unlinkSync(createdPath);
        }
      } catch { /* best-effort */ }
      return null;
    }
  };
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

function validArtifactFilename(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 240
    && value === basename(value)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Tool artifact directory must be a non-symlink directory.");
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error("Tool artifact directory must be owned by the current user.");
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error("Tool artifact directory must have mode 0700.");
  }
}

function assertPrivateArtifactFile(info: Stats, expectedSize: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Tool artifact must be a single-link non-symlink regular file.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error("Tool artifact must be owned by the current user.");
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error("Tool artifact must have mode 0600.");
  }
  if (info.size !== expectedSize) throw new Error("Tool artifact size did not match the source buffer.");
}

function sanitizeRunId(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "manual";
}

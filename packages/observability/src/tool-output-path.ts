import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
        // realpath failure authoritative instead of climbing past that link.
        return resolve(canonicalAccessibleDirectory(existing), relative(existing, normalized));
      }
    }
    throw error;
  }
  // Safe configured aliases remain usable, but all later containment checks
  // operate beneath the canonical directory rather than beneath the alias.
  return canonicalAccessibleDirectory(normalized);
}

/** Project a run id into the exact directory name used by the tool-output sink. */
export function toolOutputRunDirectoryName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "manual";
}

function canonicalAccessibleDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) {
    throw new TypeError("tool history artifact root must be a directory.");
  }
  accessSync(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}

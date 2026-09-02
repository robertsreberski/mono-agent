#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WORKSPACE_PARENTS = ["packages", "extras"];
const OUTPUT_DIRECTORIES = ["dist", path.join("webapp", "dist")];
const RETIRED_OUTPUT_DIRECTORIES = [path.join("demos", "final-agent", "dist")];

/**
 * Remove every build output directory so the next build cannot inherit compiled files whose
 * sources were deleted.
 *
 * `dist/` is gitignored, so a long-lived checkout accumulates output for sources that no
 * longer exist and `pnpm pack` ships it: @mono-agent/telegram-adapter@0.15.3 published
 * `dist/ask.js` two releases after `src/ask.ts` was removed.
 *
 * Deliberately not wired into `pnpm run build`. It discards each package's
 * `dist/.tsbuildinfo`, which would turn every local and worktree build into a full rebuild of
 * the whole graph. Run it before a release; `release:pack` fails closed when it was skipped.
 */
export function cleanBuildOutputs({ repoRoot = REPO_ROOT, log = console.log } = {}) {
  const removed = [];
  for (const parent of WORKSPACE_PARENTS) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const output of OUTPUT_DIRECTORIES) {
        const relativeDir = path.join(parent, entry.name, output);
        const outputDir = path.join(repoRoot, relativeDir);
        if (!fs.existsSync(outputDir)) continue;
        fs.rmSync(outputDir, { recursive: true, force: true });
        removed.push(relativeDir);
        log(`removed ${relativeDir}`);
      }
    }
  }
  // Keep this exact transitional cleanup after the demo sources are removed. Long-lived
  // checkouts can still contain the ignored compiled CLI and must not retain a runnable demo.
  // Do not broaden this to demos/**: ordinary fixtures using that name are not retired output.
  for (const relativeDir of RETIRED_OUTPUT_DIRECTORIES) {
    const outputDir = path.join(repoRoot, relativeDir);
    if (!fs.existsSync(outputDir)) continue;
    if (hasSymlinkedParent(repoRoot, relativeDir)) {
      log(`skipped ${relativeDir}: a parent path is a symbolic link`);
      continue;
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
    removed.push(relativeDir);
    log(`removed ${relativeDir}`);
  }
  log(`clean: removed ${removed.length} build output ${removed.length === 1 ? "directory" : "directories"}`);
  return removed;
}

function hasSymlinkedParent(repoRoot, relativeDir) {
  let candidate = repoRoot;
  for (const component of path.dirname(relativeDir).split(path.sep)) {
    candidate = path.join(candidate, component);
    if (!fs.existsSync(candidate)) return false;
    if (fs.lstatSync(candidate).isSymbolicLink()) return true;
  }
  return false;
}

// argv[1] is absent when this module is imported rather than executed (`node -e`, test runners).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanBuildOutputs();
}

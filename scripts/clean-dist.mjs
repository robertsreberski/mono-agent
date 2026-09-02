#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WORKSPACE_PARENTS = ["packages", "extras"];
const OUTPUT_DIRECTORIES = ["dist", path.join("webapp", "dist")];
const RETIRED_OUTPUT_DIRECTORIES = [path.join("demos", "final-agent", "dist")];
const RETIRED_REMOVAL_REFUSED = 73;
const RETIRED_OUTPUT_REMOVER_SOURCE = `
const fs = require("node:fs");
const expected = JSON.parse(process.argv[1]);
function matches(details, identity) {
  return !details.isSymbolicLink()
    && details.isDirectory()
    && String(details.dev) === identity.dev
    && String(details.ino) === identity.ino;
}
let parent;
let target;
try {
  parent = fs.lstatSync(".");
  target = fs.lstatSync(expected.entry);
} catch {
  process.exit(${RETIRED_REMOVAL_REFUSED});
}
if (!matches(parent, expected.parent) || !matches(target, expected.target)) {
  process.exit(${RETIRED_REMOVAL_REFUSED});
}
fs.rmSync(expected.entry, { recursive: true, force: true });
`;

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
export function cleanBuildOutputs({
  repoRoot = REPO_ROOT,
  log = console.log,
  beforeRetiredOutputRemoval,
} = {}) {
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
    const inspected = inspectRetiredOutput(repoRoot, relativeDir);
    if (inspected.status === "absent") continue;
    if (inspected.status === "unsafe") {
      log(`skipped ${relativeDir}: ${inspected.reason}`);
      continue;
    }
    if (!retiredOutputIdentityIsStable(inspected)) {
      log(`skipped ${relativeDir}: path identity changed before deletion`);
      continue;
    }
    beforeRetiredOutputRemoval?.({ relativeDir, outputDir: inspected.outputDir });
    if (!removeRetiredOutputFromBoundParent(inspected)) {
      log(`skipped ${relativeDir}: path identity changed during deletion`);
      continue;
    }
    removed.push(relativeDir);
    log(`removed ${relativeDir}`);
  }
  log(`clean: removed ${removed.length} build output ${removed.length === 1 ? "directory" : "directories"}`);
  return removed;
}

function removeRetiredOutputFromBoundParent(inspected) {
  const parent = inspected.identities.at(-2);
  const target = inspected.identities.at(-1);
  // The child binds its cwd to the checked parent inode, so replacing the lexical parent with a
  // symlink cannot redirect rmSync. A hostile same-UID replacement of the final directory entry
  // after the child's identity check remains outside pure Node's descriptor-relative abilities;
  // replacing it with a symlink is still safe because rmSync removes, rather than follows, it.
  const result = spawnSync(process.execPath, [
    "--input-type=commonjs",
    "-e",
    RETIRED_OUTPUT_REMOVER_SOURCE,
    JSON.stringify({
      entry: path.basename(inspected.outputDir),
      parent: { dev: String(parent.dev), ino: String(parent.ino) },
      target: { dev: String(target.dev), ino: String(target.ino) },
    }),
  ], {
    cwd: parent.candidate,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status === RETIRED_REMOVAL_REFUSED
    || (result.error instanceof Error && "code" in result.error
      && (result.error.code === "ENOENT" || result.error.code === "ENOTDIR"))) {
    return false;
  }
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not safely remove retired output (${result.signal ?? `exit ${result.status}`}): `
      + result.stderr.trim(),
    );
  }
  return true;
}

function inspectRetiredOutput(repoRoot, relativeDir) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(path.resolve(repoRoot));
  } catch (error) {
    if (isMissingPathError(error)) return { status: "absent" };
    return { status: "unsafe", reason: "repository root could not be resolved safely" };
  }

  const identities = [];
  const components = relativeDir.split(path.sep);
  let candidate = canonicalRoot;
  for (const [index, component] of ["", ...components].entries()) {
    if (index > 0) candidate = path.join(candidate, component);
    let details;
    try {
      details = fs.lstatSync(candidate);
    } catch (error) {
      if (isMissingPathError(error)) return { status: "absent" };
      return { status: "unsafe", reason: "path could not be inspected safely" };
    }
    if (details.isSymbolicLink()) {
      return {
        status: "unsafe",
        reason: index === components.length
          ? "the output path is a symbolic link"
          : "a parent path is a symbolic link",
      };
    }
    if (!details.isDirectory()) {
      return { status: "unsafe", reason: "the cleanup path is not a directory" };
    }
    identities.push({ candidate, dev: details.dev, ino: details.ino });
  }
  return {
    status: "ready",
    outputDir: candidate,
    identities,
  };
}

function retiredOutputIdentityIsStable(inspected) {
  for (const identity of inspected.identities) {
    let details;
    let canonical;
    try {
      details = fs.lstatSync(identity.candidate);
      canonical = fs.realpathSync(identity.candidate);
    } catch {
      return false;
    }
    if (details.isSymbolicLink()
      || !details.isDirectory()
      || details.dev !== identity.dev
      || details.ino !== identity.ino
      || canonical !== identity.candidate) {
      return false;
    }
  }
  return true;
}

function isMissingPathError(error) {
  return error instanceof Error && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

// argv[1] is absent when this module is imported rather than executed (`node -e`, test runners).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanBuildOutputs();
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WORKSPACE_PARENTS = ["packages", "extras"];
const OUTPUT_DIRECTORIES = ["dist", path.join("webapp", "dist")];
const RETIRED_OUTPUT_DIRECTORIES = [path.join("demos", "final-agent", "dist")];
const RETIRED_PENDING_OUTPUT_NAME_PATTERN =
  /^\.dist\.cleaning-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RETIRED_REMOVAL_REFUSED = 73;
const RETIRED_REMOVAL_FAILED = 74;
const RETIRED_REMOVAL_RESULT_PREFIX = "mono-agent-retired-removal:";
const RETIRED_OUTPUT_REMOVER_SOURCE = `
const fs = require("node:fs");
const expected = JSON.parse(process.argv[1]);
const resultPrefix = ${JSON.stringify(RETIRED_REMOVAL_RESULT_PREFIX)};
function finish(exitCode, status, details = {}) {
  fs.writeSync(1, resultPrefix + JSON.stringify({ status, ...details }) + "\\n");
  process.exit(exitCode);
}
function errorCode(error) {
  return error && typeof error.code === "string" ? error.code : "UNKNOWN";
}
function quarantineState() {
  try {
    const details = fs.lstatSync(expected.quarantine);
    return matches(details, expected.target)
      ? { quarantineState: "retained" }
      : { quarantineState: "indeterminate" };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { quarantineState: "absent" }
      : { quarantineState: "indeterminate" };
  }
}
function matches(details, identity) {
  return !details.isSymbolicLink()
    && details.isDirectory()
    && String(details.dev) === identity.dev
    && String(details.ino) === identity.ino;
}
let parent;
let target;
let canonicalParent;
try {
  parent = fs.lstatSync(".");
  target = fs.lstatSync(expected.entry);
  canonicalParent = fs.realpathSync(".");
} catch (error) {
  finish(${RETIRED_REMOVAL_REFUSED}, "initial-check-failed", { code: errorCode(error) });
}
if (!matches(parent, expected.parent)
  || !matches(target, expected.target)
  || canonicalParent !== expected.parent.canonical) {
  finish(${RETIRED_REMOVAL_REFUSED}, "initial-identity-mismatch");
}
try {
  fs.lstatSync(expected.quarantine);
  finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-exists", {
    quarantineState: "indeterminate",
  });
} catch (error) {
  if (errorCode(error) !== "ENOENT") {
    finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-check-failed", {
      code: errorCode(error),
      quarantineState: "indeterminate",
    });
  }
}
try {
  fs.renameSync(expected.entry, expected.quarantine);
} catch (error) {
  finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-rename-failed", {
    code: errorCode(error),
    ...quarantineState(),
  });
}
let quarantined;
try {
  quarantined = fs.lstatSync(expected.quarantine);
} catch (error) {
  finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-check-failed", {
    code: errorCode(error),
    ...quarantineState(),
  });
}
if (!matches(quarantined, expected.target)) {
  finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-identity-mismatch", {
    quarantineState: "indeterminate",
  });
}
try {
  fs.rmSync(expected.quarantine, { recursive: true, force: true });
} catch (error) {
  finish(${RETIRED_REMOVAL_FAILED}, "quarantine-cleanup-failed", {
    code: errorCode(error),
    ...quarantineState(),
  });
}
try {
  fs.lstatSync(expected.quarantine);
  finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-cleanup-incomplete", {
    ...quarantineState(),
  });
} catch (error) {
  if (errorCode(error) !== "ENOENT") {
    finish(${RETIRED_REMOVAL_REFUSED}, "quarantine-post-cleanup-check-failed", {
      code: errorCode(error),
      ...quarantineState(),
    });
  }
}
finish(0, "removed");
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
  retiredOutputChildEnv = process.env,
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
    const parentInspection = inspected.status === "ready"
      ? {
        status: "ready",
        outputDir: path.dirname(inspected.outputDir),
        identities: inspected.identities.slice(0, -1),
      }
      : inspectRetiredOutput(repoRoot, path.dirname(relativeDir));
    if (parentInspection.status === "unsafe") {
      log(`skipped ${relativeDir}: ${inspected.status === "unsafe"
        ? inspected.reason
        : parentInspection.reason}`);
      continue;
    }
    if (parentInspection.status === "ready") {
      const pendingInspection = inspectPendingRetiredOutputs(parentInspection);
      if (pendingInspection.status === "unsafe") {
        log(`skipped ${relativeDir}: ${pendingInspection.reason}`);
        continue;
      }
      if (pendingInspection.paths.length > 0) {
        for (const pendingPath of pendingInspection.paths) {
          log(`skipped ${relativeDir}: retained pending deletion requires inspection at ${pendingPath}`);
        }
        continue;
      }
    }
    if (inspected.status === "unsafe") {
      log(`skipped ${relativeDir}: ${inspected.reason}`);
      continue;
    }
    if (inspected.status === "absent") continue;
    if (!retiredOutputIdentityIsStable(inspected)) {
      log(`skipped ${relativeDir}: path identity changed before deletion`);
      continue;
    }
    beforeRetiredOutputRemoval?.({ relativeDir, outputDir: inspected.outputDir });
    const cleanup = removeRetiredOutputFromBoundParent(inspected, retiredOutputChildEnv);
    if (!cleanup.removed) {
      log(`skipped ${relativeDir}: ${cleanup.reason}`);
      continue;
    }
    removed.push(relativeDir);
    log(`removed ${relativeDir}`);
  }
  log(`clean: removed ${removed.length} build output ${removed.length === 1 ? "directory" : "directories"}`);
  return removed;
}

function removeRetiredOutputFromBoundParent(inspected, childEnvironment) {
  const parent = inspected.identities.at(-2);
  const target = inspected.identities.at(-1);
  const quarantine = `.${path.basename(inspected.outputDir)}.cleaning-${randomUUID()}`;
  const quarantinePath = path.join(parent.candidate, quarantine);
  const parentInspection = {
    status: "ready",
    outputDir: parent.candidate,
    identities: inspected.identities.slice(0, -1),
  };
  // The child binds its cwd to the checked parent inode, rechecks that canonical location, then
  // renames the final entry to a random sibling and verifies that sibling's identity. Concurrent
  // same-UID mutation after that final identity check and before rmSync is unsupported: pure Node
  // has no descriptor-relative recursive deletion, and a process with such write access already
  // controls this repository parent. The relative operation cannot escape the validated parent.
  const result = spawnSync(process.execPath, [
    "--input-type=commonjs",
    "-e",
    RETIRED_OUTPUT_REMOVER_SOURCE,
    JSON.stringify({
      entry: path.basename(inspected.outputDir),
      quarantine,
      parent: {
        canonical: parent.candidate,
        dev: String(parent.dev),
        ino: String(parent.ino),
      },
      target: { dev: String(target.dev), ino: String(target.ino) },
    }),
  ], {
    cwd: parent.candidate,
    encoding: "utf8",
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw retiredRemovalProtocolError(result, parentInspection, target, quarantinePath);
  }
  const childResult = parseRetiredRemovalResult(result.stdout);
  if (result.status === 0 && childResult?.status === "removed") {
    return { removed: true };
  }
  if (result.status === RETIRED_REMOVAL_REFUSED && childResult !== undefined) {
    if (childResult.status === "initial-check-failed"
      || childResult.status === "initial-identity-mismatch") {
      return { removed: false, reason: "path identity changed during deletion" };
    }
    const refusal = formatRetiredRemovalStatus(childResult);
    if (childResult.quarantineState === "retained") {
      return {
        removed: false,
        reason: `pending deletion was refused (${refusal}) and remains at ${quarantinePath}`,
      };
    }
    if (childResult.quarantineState === "indeterminate") {
      return {
        removed: false,
        reason: `pending deletion was refused (${refusal}); inspect ${quarantinePath} before retrying`,
      };
    }
    return { removed: false, reason: `pending deletion was refused (${refusal})` };
  }
  if (result.status === RETIRED_REMOVAL_FAILED
    && childResult?.status === "quarantine-cleanup-failed") {
    const quarantineState = childResult.quarantineState ?? "indeterminate";
    const stateMessage = quarantineState === "retained"
      ? `the pending deletion remains at ${quarantinePath}`
      : quarantineState === "absent"
        ? `the pending deletion is absent after the remover anomaly at ${quarantinePath}`
        : `the pending deletion state is indeterminate; inspect ${quarantinePath}`;
    const cleanupError = new Error(
      `Retired output quarantine cleanup failed (${childResult.code ?? "UNKNOWN"}); ${stateMessage}`,
    );
    cleanupError.code = "RETIRED_OUTPUT_QUARANTINE_CLEANUP_FAILED";
    cleanupError.quarantinePath = quarantinePath;
    cleanupError.quarantineState = quarantineState;
    throw cleanupError;
  }
  throw retiredRemovalProtocolError(result, parentInspection, target, quarantinePath);
}

function formatRetiredRemovalStatus(result) {
  const status = typeof result.status === "string"
    ? result.status.replaceAll("-", " ")
    : "unknown refusal";
  return typeof result.code === "string" ? `${status}: ${result.code}` : status;
}

function parseRetiredRemovalResult(stdout) {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line.startsWith(RETIRED_REMOVAL_RESULT_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(RETIRED_REMOVAL_RESULT_PREFIX.length));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function retiredRemovalProtocolError(result, parentInspection, target, quarantinePath) {
  const quarantineState = classifyRetiredRemovalQuarantine(
    parentInspection,
    target,
    quarantinePath,
  );
  const outcome = result.error instanceof Error
    ? `failed to start (${"code" in result.error ? result.error.code : result.error.message})`
    : typeof result.signal === "string"
      ? `terminated by signal ${result.signal}`
      : `exited with code ${result.status}`;
  const error = new Error(
    `Retired output remover ${outcome} without a valid protocol result; `
      + `quarantine state is ${quarantineState} at ${quarantinePath}`,
    result.error instanceof Error ? { cause: result.error } : undefined,
  );
  error.code = "RETIRED_OUTPUT_REMOVAL_PROTOCOL_FAILED";
  error.quarantinePath = quarantinePath;
  error.quarantineState = quarantineState;
  error.signal = result.signal;
  error.exitCode = result.status;
  return error;
}

function classifyRetiredRemovalQuarantine(parentInspection, target, quarantinePath) {
  if (!retiredOutputIdentityIsStable(parentInspection)) return "indeterminate";
  let details;
  try {
    // lstat is deliberate: an untrusted pending symlink must never be followed.
    details = fs.lstatSync(quarantinePath);
  } catch (error) {
    return isMissingPathError(error) && retiredOutputIdentityIsStable(parentInspection)
      ? "absent"
      : "indeterminate";
  }
  if (!retiredOutputIdentityIsStable(parentInspection)) return "indeterminate";
  return !details.isSymbolicLink()
    && details.isDirectory()
    && details.dev === target.dev
    && details.ino === target.ino
    ? "retained"
    : "indeterminate";
}

function inspectPendingRetiredOutputs(parentInspection) {
  if (!retiredOutputIdentityIsStable(parentInspection)) {
    return {
      status: "unsafe",
      reason: "parent identity changed before pending-deletion inspection",
    };
  }
  let entries;
  try {
    entries = fs.readdirSync(parentInspection.outputDir, { withFileTypes: true });
  } catch {
    return {
      status: "unsafe",
      reason: "pending-deletion entries could not be inspected safely",
    };
  }
  if (!retiredOutputIdentityIsStable(parentInspection)) {
    return {
      status: "unsafe",
      reason: "parent identity changed during pending-deletion inspection",
    };
  }
  return {
    status: "ready",
    paths: entries
      .map((entry) => entry.name)
      .filter((name) => RETIRED_PENDING_OUTPUT_NAME_PATTERN.test(name))
      .sort()
      .map((name) => path.join(parentInspection.outputDir, name)),
  };
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

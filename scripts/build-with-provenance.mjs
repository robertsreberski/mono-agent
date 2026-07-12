#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
} from "node:fs";
import { delimiter, dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_LOCK_FILENAME,
  BUILD_MARKER_FILENAME,
  acquireBuildLock,
  clearBuildMarker,
  computeBuildOutputDigest,
  computeDeploymentStateFingerprint,
  computeRuntimeDependencyDigest,
  publishBuildMarker,
  releaseBuildLock,
} from "./lib/build-provenance.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRUSTED_GIT = "/usr/bin/git";
const GIT_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
const BUILD_COMMANDS = Object.freeze([
  ["pnpm", ["-r", "--sort", "run", "build"]],
  ["pnpm", ["run", "build:demo"]],
]);
const WINDOWS_PNPM_ARGUMENTS = new Set([
  JSON.stringify(["-r", "--sort", "run", "build"]),
  JSON.stringify(["run", "build:demo"]),
]);
const REQUIRED_EXECUTABLES = Object.freeze([
  "packages/agent-app/dist/cli.js",
  "packages/tui/dist/bin/mono-agent-tui.js",
]);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function finalizeRequiredExecutables(repo) {
  const expectedUid = BigInt(process.getuid());
  const executableBits = (0o111 & ~process.umask()) | 0o100;
  for (const relativePath of REQUIRED_EXECUTABLES) {
    const path = resolve(repo, relativePath);
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
      const before = fstatSync(fd, { bigint: true });
      const currentBefore = lstatSync(path, { bigint: true });
      if (!before.isFile()
        || before.nlink !== 1n
        || before.uid !== expectedUid
        || (before.mode & 0o7022n) !== 0n
        || !currentBefore.isFile()
        || !sameFileIdentity(before, currentBefore)) {
        throw new Error("unsafe required executable");
      }
      const executableMode = Number(before.mode & 0o666n) | executableBits;
      fchmodSync(fd, executableMode);
      fsyncSync(fd);
      const after = fstatSync(fd, { bigint: true });
      const currentAfter = lstatSync(path, { bigint: true });
      if (!after.isFile()
        || after.nlink !== 1n
        || after.uid !== expectedUid
        || (after.mode & 0o7777n) !== BigInt(executableMode)
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || !currentAfter.isFile()
        || !sameFileIdentity(before, after)
        || !sameFileIdentity(after, currentAfter)
        || (currentAfter.mode & 0o7777n) !== BigInt(executableMode)) {
        throw new Error("required executable changed during mode finalization");
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

export function prependNodeToPath(nodeBin, currentPath, platform = process.platform) {
  const separator = platform === "win32" ? ";" : delimiter;
  return typeof currentPath === "string" && currentPath.length > 0
    ? `${nodeBin}${separator}${currentPath}`
    : nodeBin;
}

function isSafeWindowsExecutable(path, basenamePattern) {
  return typeof path === "string"
    && win32.isAbsolute(path)
    && !/[\0\r\n]/u.test(path)
    && !path.split(/[\\/]/u).includes("..")
    && basenamePattern.test(win32.basename(path));
}

function isWindowsDescendant(parent, candidate) {
  const relativePath = win32.relative(parent, candidate);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${win32.sep}`)
    && !win32.isAbsolute(relativePath);
}

/**
 * Resolve only the two fixed internal pnpm build commands. Windows executes
 * the exact pnpm JS entrypoint from the current Node installation, without a
 * shell or PATH lookup. Missing or outside-install environment claims fail
 * closed instead of selecting an ambient pnpm.cmd/cmd.exe.
 */
export function selectBuildInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || command !== "pnpm") {
    return { command, args: [...args] };
  }

  if (!WINDOWS_PNPM_ARGUMENTS.has(JSON.stringify(args))) {
    throw new Error("unsafe Windows pnpm build command");
  }

  const nodePath = options.nodePath ?? process.execPath;
  const npmExecPath = Object.hasOwn(options, "npmExecPath")
    ? options.npmExecPath
    : process.env.npm_execpath;
  if (isSafeWindowsExecutable(nodePath, /^node\.exe$/iu)
    && isSafeWindowsExecutable(npmExecPath, /^pnpm\.(?:cjs|mjs|js)$/iu)
    && isWindowsDescendant(win32.dirname(nodePath), npmExecPath)) {
    return { command: nodePath, args: [npmExecPath, ...args] };
  }
  throw new Error("trusted Windows pnpm entrypoint unavailable");
}

function run(command, args, options = {}) {
  const nodeBin = dirname(process.execPath);
  let invocation;
  let result;
  try {
    invocation = selectBuildInvocation(command, args);
    result = spawnSync(invocation.command, invocation.args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: options.stdio ?? "pipe",
      env: options.env ?? {
        ...process.env,
        // Keep every package build on the exact Node that will be recorded in
        // the marker, even if the invoking shell resolves another Node first.
        PATH: prependNodeToPath(nodeBin, process.env.PATH),
      },
    });
  } catch {
    return { status: 127, stdout: "" };
  }
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
  };
}

function runTrustedGit(repo, args, runCommand) {
  return runCommand(TRUSTED_GIT, ["-C", repo, ...args], { cwd: repo, env: GIT_ENV });
}

function readSourceState(repo, runCommand) {
  const shaResult = runTrustedGit(repo, ["rev-parse", "HEAD"], runCommand);
  const gitSha = shaResult.status === 0 ? shaResult.stdout.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/u.test(gitSha)) return null;

  const statusResult = runTrustedGit(
    repo,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    runCommand,
  );
  if (statusResult.status !== 0) return null;
  return { gitSha, sourceState: statusResult.stdout.length === 0 ? "clean" : "dirty" };
}

function markerFilesAreIgnored(repo, runCommand) {
  for (const filename of [
    BUILD_MARKER_FILENAME,
    `${BUILD_MARKER_FILENAME}.tmp-probe`,
    BUILD_LOCK_FILENAME,
  ]) {
    const result = runTrustedGit(repo, ["check-ignore", "-q", "--", filename], runCommand);
    if (result.status !== 0) return false;
  }
  return true;
}

function runBuildCommands(repo, runCommand, commands) {
  for (const [command, args] of commands) {
    const result = runCommand(command, args, { cwd: repo, stdio: "inherit" });
    if (result.status !== 0) {
      return { exitCode: result.status, error: "workspace build failed" };
    }
  }
  return { exitCode: 0 };
}

export function supportsStrictBuildProvenance(platform) {
  return platform === "darwin" || platform === "linux";
}

function runPortableBuild(repo, runCommand, commands) {
  // A build on an unsupported host cannot retain a prior POSIX durability
  // claim after changing outputs. It deliberately publishes no replacement.
  try {
    clearBuildMarker(repo, { syncDirectory: false });
  } catch {
    return { exitCode: 1, error: "stale build marker could not be cleared" };
  }
  return runBuildCommands(repo, runCommand, commands);
}

export function runBuildWithProvenance(options = {}) {
  const repo = options.repo ?? REPO;
  const runCommand = options.runCommand ?? run;
  const commands = options.commands ?? BUILD_COMMANDS;
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;

  if (!supportsStrictBuildProvenance(platform)) {
    return runPortableBuild(repo, runCommand, commands);
  }

  let lock;
  try {
    // The lock is acquired before invalidating any prior marker and remains
    // held through output synchronization and marker publication.
    lock = acquireBuildLock(repo);
  } catch {
    return { exitCode: 1, error: "build already in progress or lock is unsafe" };
  }

  let result;
  try {
    clearBuildMarker(repo);
    if (!markerFilesAreIgnored(repo, runCommand)) {
      result = { exitCode: 1, error: "build provenance files are not ignored" };
    } else {
      const before = readSourceState(repo, runCommand);
      if (before === null) {
        result = { exitCode: 1, error: "build source state unavailable" };
      } else {
        result = runBuildCommands(repo, runCommand, commands);
        if (result.exitCode === 0) {
          try {
            // The executable modes are part of the dependency/workspace
            // digest. Finalize them while the build lock is held and before
            // any terminal source or deployment-state attestation.
            finalizeRequiredExecutables(repo);
          } catch {
            result = { exitCode: 1, error: "required build entrypoints unavailable or unsafe" };
          }
          if (result.exitCode === 0) {
            const after = readSourceState(repo, runCommand);
            if (after === null
              || after.gitSha !== before.gitSha
              || after.sourceState !== before.sourceState) {
              result = { exitCode: 1, error: "build source changed during build" };
            } else {
              let outputDigest;
              let dependencyDigest;
              let deploymentStateBefore;
              try {
                deploymentStateBefore = computeDeploymentStateFingerprint(repo);
                outputDigest = computeBuildOutputDigest(repo, { sync: true });
                dependencyDigest = computeRuntimeDependencyDigest(repo);
                options.afterDeploymentDigests?.();
              } catch {
                result = { exitCode: 1, error: "build outputs or runtime dependencies unavailable or unstable" };
              }
              if (result.exitCode === 0
                && deploymentStateBefore !== undefined
                && outputDigest !== undefined
                && dependencyDigest !== undefined) {
                const finalSource = readSourceState(repo, runCommand);
                if (finalSource === null
                  || finalSource.gitSha !== before.gitSha
                  || finalSource.sourceState !== before.sourceState) {
                  result = { exitCode: 1, error: "build source changed during build" };
                } else {
                  let marker;
                  try {
                    marker = {
                      schemaVersion: 2,
                      gitSha: finalSource.gitSha,
                      completedAt: now().toISOString(),
                      nodeVersion: process.versions.node,
                      nodeAbi: process.versions.modules,
                      sourceState: finalSource.sourceState,
                      outputDigest,
                      dependencyDigest,
                    };
                  } catch {
                    result = { exitCode: 1, error: "build marker publication failed" };
                  }
                  if (marker !== undefined) {
                    let deploymentStateAfter;
                    try {
                      deploymentStateAfter = computeDeploymentStateFingerprint(repo);
                    } catch {
                      result = {
                        exitCode: 1,
                        error: "build outputs or runtime dependencies unavailable or unstable",
                      };
                    }
                    if (deploymentStateAfter !== undefined) {
                      if (deploymentStateAfter !== deploymentStateBefore) {
                        result = {
                          exitCode: 1,
                          error: "build deployment state changed during attestation",
                        };
                      } else {
                        try {
                          publishBuildMarker(repo, marker);
                          result = { exitCode: 0 };
                        } catch {
                          result = { exitCode: 1, error: "build marker publication failed" };
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    result = { exitCode: 1, error: "build provenance lifecycle failed" };
  }

  try {
    releaseBuildLock(repo, lock);
  } catch {
    try {
      clearBuildMarker(repo);
    } catch {
      // The lock remains a fail-closed probe signal if cleanup itself failed.
    }
    return { exitCode: 1, error: "build lock cleanup failed" };
  }
  return result;
}

function main() {
  const result = runBuildWithProvenance();
  if (result.error !== undefined) {
    process.stderr.write(`Build provenance failed: ${result.error}.\n`);
  }
  process.exitCode = result.exitCode;
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) main();

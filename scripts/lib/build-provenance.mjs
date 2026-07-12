import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

export const BUILD_MARKER_FILENAME = ".mono-agent-build.json";
export const BUILD_LOCK_FILENAME = ".mono-agent-build.lock";
export const BUILD_MARKER_SCHEMA_VERSION = 1;

const BUILD_MARKER_KEYS = Object.freeze([
  "schemaVersion",
  "gitSha",
  "completedAt",
  "nodeVersion",
  "nodeAbi",
  "sourceState",
  "outputDigest",
]);
const MAX_BUILD_MARKER_BYTES = 4_096;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const NODE_ABI_PATTERN = /^\d+$/u;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record, expectedKeys) {
  const actualKeys = Object.keys(record);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(record, key));
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error("unsafe build directory");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function bestEffortSyncDirectory(path) {
  try {
    syncDirectory(path);
  } catch {
    // Preserve the original operation error.
  }
}

function unlinkAndSync(path, directory, options = {}) {
  let removed = false;
  try {
    unlinkSync(path);
    removed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (removed && options.syncDirectory !== false) syncDirectory(directory);
  return removed;
}

export function parseBuildMarker(value) {
  if (!isRecord(value)
    || !hasExactKeys(value, BUILD_MARKER_KEYS)
    || value.schemaVersion !== BUILD_MARKER_SCHEMA_VERSION
    || typeof value.gitSha !== "string"
    || !SHA_PATTERN.test(value.gitSha)
    || !isCanonicalInstant(value.completedAt)
    || typeof value.nodeVersion !== "string"
    || !NODE_VERSION_PATTERN.test(value.nodeVersion)
    || typeof value.nodeAbi !== "string"
    || !NODE_ABI_PATTERN.test(value.nodeAbi)
    || (value.sourceState !== "clean" && value.sourceState !== "dirty")
    || typeof value.outputDigest !== "string"
    || !DIGEST_PATTERN.test(value.outputDigest)) {
    return null;
  }
  return {
    schemaVersion: BUILD_MARKER_SCHEMA_VERSION,
    gitSha: value.gitSha,
    completedAt: value.completedAt,
    nodeVersion: value.nodeVersion,
    nodeAbi: value.nodeAbi,
    sourceState: value.sourceState,
    outputDigest: value.outputDigest,
  };
}

export function parseBuildMarkerText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BUILD_MARKER_BYTES) {
    return null;
  }
  try {
    const marker = parseBuildMarker(JSON.parse(text));
    if (marker === null || text !== `${JSON.stringify(marker)}\n`) return null;
    return marker;
  } catch {
    return null;
  }
}

export function buildMarkerPath(repo) {
  return join(repo, BUILD_MARKER_FILENAME);
}

export function buildLockPath(repo) {
  return join(repo, BUILD_LOCK_FILENAME);
}

export function clearBuildMarker(repo, options = {}) {
  unlinkAndSync(buildMarkerPath(repo), repo, options);
}

export function acquireBuildLock(repo) {
  const path = buildLockPath(repo);
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`, "utf8");
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) {
      throw new Error("unsafe build lock");
    }
    syncDirectory(repo);
    return { fd, path, dev: stat.dev, ino: stat.ino, released: false };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original lock error.
      }
      try {
        unlinkSync(path);
        bestEffortSyncDirectory(repo);
      } catch {
        // Preserve the original lock error.
      }
    }
    throw error;
  }
}

export function releaseBuildLock(repo, lock) {
  if (!isRecord(lock) || lock.released === true || typeof lock.fd !== "number") {
    throw new Error("invalid build lock handle");
  }
  lock.released = true;
  let releaseError;
  try {
    const openStat = fstatSync(lock.fd, { bigint: true });
    const pathStat = lstatOrNull(lock.path);
    if (pathStat === null
      || !pathStat.isFile()
      || !sameIdentity(openStat, pathStat)
      || openStat.dev !== lock.dev
      || openStat.ino !== lock.ino) {
      throw new Error("build lock identity changed");
    }
    unlinkSync(lock.path);
    syncDirectory(repo);
  } catch (error) {
    releaseError = error;
  } finally {
    try {
      closeSync(lock.fd);
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError !== undefined) throw releaseError;
}

export function publishBuildMarker(repo, marker, options = {}) {
  const parsed = parseBuildMarker(marker);
  if (parsed === null) {
    throw new Error("refusing to publish an invalid build marker");
  }

  const destination = buildMarkerPath(repo);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(parsed)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    renamed = true;
    options.afterRename?.();
    syncDirectory(repo);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original publication error.
      }
    }
    if (renamed) {
      try {
        unlinkSync(destination);
      } catch {
        // The renamed marker may already have been removed.
      }
      bestEffortSyncDirectory(repo);
    } else {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary marker may never have been created.
      }
      bestEffortSyncDirectory(repo);
    }
    throw error;
  }
}

function buildLockIsAbsent(repo) {
  try {
    const stat = lstatSync(buildLockPath(repo));
    return stat === undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

/**
 * Read through one no-follow file descriptor so permissions, bytes, and the
 * returned fingerprint all describe the same inode. Only closed statuses and
 * a validated marker leave this boundary.
 */
export function readBuildMarker(repo, options = {}) {
  if (!buildLockIsAbsent(repo)) return { status: "unsafe" };

  const markerPath = buildMarkerPath(repo);
  let fd;
  try {
    fd = openSync(markerPath, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unsafe" };
  }

  try {
    const stat = fstatSync(fd, { bigint: true });
    const expectedUidValue = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const expectedUid = expectedUidValue === undefined ? undefined : BigInt(expectedUidValue);
    if (!stat.isFile()
      || stat.nlink !== 1n
      || stat.size <= 0n
      || stat.size > BigInt(MAX_BUILD_MARKER_BYTES)
      || (stat.mode & 0o077n) !== 0n
      || (expectedUid !== undefined && stat.uid !== expectedUid)) {
      return { status: "unsafe" };
    }
    const text = readFileSync(fd, "utf8");
    // Test seam for proving that a replaced or unlinked pathname cannot bless
    // bytes read from a now-stale file descriptor. Production leaves it unset.
    options.afterRead?.();
    const after = fstatSync(fd, { bigint: true });
    const current = lstatOrNull(markerPath);
    if (current === null
      || !current.isFile()
      || after.nlink !== 1n
      || current.nlink !== 1n
      || !sameFileState(stat, after)
      || !sameFileState(after, current)
      || (after.mode & 0o077n) !== 0n
      || (current.mode & 0o077n) !== 0n
      || (expectedUid !== undefined && (after.uid !== expectedUid || current.uid !== expectedUid))) {
      return { status: "unsafe" };
    }
    const marker = parseBuildMarkerText(text);
    if (marker === null) {
      return { status: "malformed" };
    }
    if (!buildLockIsAbsent(repo)) return { status: "unsafe" };
    return {
      status: "ok",
      marker,
      fingerprint: createHash("sha256").update(text).digest("hex"),
    };
  } catch {
    return { status: "unsafe" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The report is already closed; never replace it with a raw fs error.
    }
  }
}

function assertDirectory(path) {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isDirectory()) throw new Error("build output directory unavailable");
  return stat;
}

function outputRoots(repo) {
  const roots = new Set();
  for (const parentName of ["packages", "extras"]) {
    const parent = join(repo, parentName);
    assertDirectory(parent);
    const names = readdirSync(parent).sort(compareUtf8);
    for (const name of names) {
      const packageDirectory = join(parent, name);
      const packageStat = lstatOrNull(packageDirectory);
      if (packageStat === null) continue;
      if (packageStat.isSymbolicLink()) throw new Error("unsafe package directory");
      if (!packageStat.isDirectory()) continue;
      const manifest = lstatOrNull(join(packageDirectory, "package.json"));
      if (manifest === null) continue;
      if (!manifest.isFile()) throw new Error("unsafe package manifest");
      const dist = join(packageDirectory, "dist");
      const distStat = lstatOrNull(dist);
      if (distStat === null) continue;
      if (!distStat.isDirectory()) throw new Error("unsafe build output root");
      roots.add(dist);
    }
  }

  for (const required of [
    join(repo, "packages", "session-web", "webapp", "dist"),
    join(repo, "demos", "final-agent", "dist"),
  ]) {
    assertDirectory(required);
    roots.add(required);
  }
  return [...roots].sort((left, right) => compareUtf8(toRepoPath(repo, left), toRepoPath(repo, right)));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function toRepoPath(repo, path) {
  const value = relative(repo, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../") || value.includes("\0")) {
    throw new Error("unsafe build output path");
  }
  return value;
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function collectOutputTree(repo, roots) {
  const files = new Map();
  const directories = new Map();

  function visitDirectory(path) {
    const before = assertDirectory(path);
    const repoPath = toRepoPath(repo, path);
    if (directories.has(repoPath)) throw new Error("overlapping build output roots");
    directories.set(repoPath, statSignature(before));
    const names = readdirSync(path).sort(compareUtf8);
    for (const name of names) {
      const child = join(path, name);
      const stat = lstatSync(child, { bigint: true });
      if (stat.isDirectory()) {
        visitDirectory(child);
      } else if (stat.isFile()) {
        const childPath = toRepoPath(repo, child);
        if (files.has(childPath)) throw new Error("duplicate build output path");
        files.set(childPath, { path: child, signature: statSignature(stat) });
      } else {
        throw new Error("unsafe build output entry");
      }
    }
    const after = lstatSync(path, { bigint: true });
    if (!after.isDirectory() || !sameFileState(before, after)) {
      throw new Error("build output changed during traversal");
    }
  }

  for (const root of roots) visitDirectory(root);
  if (files.size === 0) throw new Error("build outputs are empty");
  return { files, directories };
}

function readStableOutputFile(path, expectedSignature, sync) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || statSignature(before) !== expectedSignature) {
      throw new Error("build output file changed");
    }
    const bytes = readFileSync(fd);
    if (sync) fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!after.isFile()
      || !current.isFile()
      || !sameFileState(before, after)
      || !sameFileState(after, current)) {
      throw new Error("build output file changed");
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function updateFramed(hash, bytes) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

export function computeBuildOutputDigest(repo, options = {}) {
  const sync = options.sync === true;
  const roots = outputRoots(repo);
  const initial = collectOutputTree(repo, roots);
  const hash = createHash("sha256");
  hash.update("mono-agent-build-output-v1\0", "utf8");

  const filePaths = [...initial.files.keys()].sort(compareUtf8);
  for (const repoPath of filePaths) {
    const entry = initial.files.get(repoPath);
    const bytes = readStableOutputFile(entry.path, entry.signature, sync);
    updateFramed(hash, Buffer.from(repoPath, "utf8"));
    updateFramed(hash, bytes);
  }

  if (sync) {
    const directoryPaths = [...initial.directories.keys()]
      .sort((left, right) => right.split("/").length - left.split("/").length || compareUtf8(left, right));
    for (const repoPath of directoryPaths) {
      const path = join(repo, ...repoPath.split("/"));
      syncDirectory(path);
      options.onDirectorySync?.(path);
    }

    // Fsyncing a new dist directory does not itself make the directory entry
    // durable. Flush every unique ancestor bottom-up through the repo root so
    // the complete output-root path is on stable storage before publication.
    const ancestors = new Set();
    for (const root of roots) {
      let current = dirname(root);
      while (true) {
        const repoPath = relative(repo, current);
        if (repoPath === ".." || repoPath.startsWith(`..${sep}`)) {
          throw new Error("unsafe build output ancestor");
        }
        ancestors.add(current);
        if (current === repo) break;
        current = dirname(current);
      }
    }
    const ancestorPaths = [...ancestors].sort((left, right) => {
      const leftDepth = toRepoPathOrRoot(repo, left).split("/").filter(Boolean).length;
      const rightDepth = toRepoPathOrRoot(repo, right).split("/").filter(Boolean).length;
      return rightDepth - leftDepth || compareUtf8(toRepoPathOrRoot(repo, left), toRepoPathOrRoot(repo, right));
    });
    for (const path of ancestorPaths) {
      syncDirectory(path);
      options.onDirectorySync?.(path);
    }
  }

  const finalRoots = outputRoots(repo);
  if (roots.length !== finalRoots.length
    || roots.some((root, index) => root !== finalRoots[index])) {
    throw new Error("build output roots changed during digest");
  }
  const final = collectOutputTree(repo, finalRoots);
  if (final.files.size !== initial.files.size || final.directories.size !== initial.directories.size) {
    throw new Error("build outputs changed during digest");
  }
  for (const [repoPath, entry] of initial.files) {
    if (final.files.get(repoPath)?.signature !== entry.signature) {
      throw new Error("build outputs changed during digest");
    }
  }
  for (const [repoPath, signature] of initial.directories) {
    if (final.directories.get(repoPath) !== signature) {
      throw new Error("build outputs changed during digest");
    }
  }
  return hash.digest("hex");
}

function toRepoPathOrRoot(repo, path) {
  return path === repo ? "" : toRepoPath(repo, path);
}

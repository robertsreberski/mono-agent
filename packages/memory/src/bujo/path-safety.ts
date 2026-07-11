import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const DEFAULT_DIRECTORY_MODE = 0o700;
const DEFAULT_FILE_MODE = 0o600;
const ROOT_CACHE = new Map<string, { readonly canonical: string; readonly dev: number; readonly ino: number }>();

export interface CanonicalFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
}

export interface CanonicalFileSnapshot {
  readonly content: string;
  readonly identity: CanonicalFileIdentity;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface CanonicalLocation {
  readonly path: string;
  readonly parent: string;
  readonly directories: readonly DirectoryIdentity[];
}

/**
 * Resolve the configured memory root without accepting a symlink as the root
 * itself. Descendant helpers additionally validate every directory component
 * below this root before opening a canonical file.
 */
export function canonicalMemoryRootPath(root: string, create: boolean): string {
  const absolute = resolve(root);
  let stat = optionalLstat(absolute);
  const cached = stat === undefined ? undefined : ROOT_CACHE.get(absolute);
  assertNoRootSymlinkAncestors(absolute);
  if (cached !== undefined && cached.dev === stat!.dev && cached.ino === stat!.ino) return cached.canonical;
  if (stat === undefined && create) {
    mkdirSync(absolute, { recursive: true, mode: DEFAULT_DIRECTORY_MODE });
    stat = lstatSync(absolute);
  }
  if (stat === undefined) {
    // Preserve a normal ENOENT for optional read callers.
    lstatSync(absolute);
  }
  if (stat!.isSymbolicLink() || !stat!.isDirectory()) {
    throw new Error("memory-bujo: memory root must be a real directory and not a symlink.");
  }
  const canonical = realpathSync(absolute);
  const canonicalStat = lstatSync(canonical);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) {
    throw new Error("memory-bujo: memory root must resolve to a real directory.");
  }
  if (canonicalStat.dev !== stat!.dev || canonicalStat.ino !== stat!.ino) {
    throw new Error("memory-bujo: memory root identity changed during resolution.");
  }
  ROOT_CACHE.set(absolute, { canonical, dev: canonicalStat.dev, ino: canonicalStat.ino });
  return canonical;
}

function assertNoRootSymlinkAncestors(absolute: string): void {
  const parsed = parse(absolute);
  const components = absolute.slice(parsed.root.length).split(sep).filter((component) => component.length > 0);
  let current = parsed.root;
  for (const component of components) {
    current = join(current, component);
    const stat = optionalLstat(current);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      if (isDarwinSystemAlias(current)) continue;
      throw new Error(`memory-bujo: memory root ancestor "${current}" must not be a symlink.`);
    }
  }
}

function isDarwinSystemAlias(path: string): boolean {
  if (process.platform !== "darwin" || (path !== "/var" && path !== "/tmp" && path !== "/etc")) return false;
  try {
    return realpathSync(path) === `/private${path}`;
  } catch {
    return false;
  }
}

/** Reject traversal, absolute paths, alternate separators, and empty components. */
export function assertCanonicalRelativePath(path: string): void {
  if (
    path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || isAbsolute(path)
    || /^[A-Za-z]:/u.test(path)
  ) {
    throw new Error(`memory-bujo: unsafe canonical relative path "${path}".`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`memory-bujo: unsafe canonical relative path "${path}".`);
  }
}

/** Accept only canonical daily sources, including the supported root legacy layout. */
export function assertCanonicalDailySourcePath(path: string): void {
  assertCanonicalRelativePath(path);
  const match = /^(?:daily\/)?(\d{4}-\d{2}-\d{2})\.md$/u.exec(path);
  if (match === null || !isCanonicalIsoDay(match[1]!)) {
    throw new Error(
      `memory-bujo: rewrite source must be daily/YYYY-MM-DD.md or a root legacy YYYY-MM-DD.md, got "${path}".`,
    );
  }
}

/** Read one identity-stable, no-follow canonical file. */
export function readCanonicalFileSnapshot(
  root: string,
  relativePath: string,
  options: { readonly allowMissing?: boolean; readonly maxBytes?: number } = {},
): CanonicalFileSnapshot | undefined {
  let location: CanonicalLocation;
  try {
    location = canonicalLocation(root, relativePath, false, false);
  } catch (error) {
    if (options.allowMissing === true && isMissing(error)) return undefined;
    throw error;
  }

  let before: Stats;
  try {
    before = lstatSync(location.path);
  } catch (error) {
    if (options.allowMissing === true && isMissing(error)) return undefined;
    throw error;
  }
  assertSafeRegularFile(before, relativePath);
  if (options.maxBytes !== undefined && before.size > options.maxBytes) {
    throw new Error(`memory-bujo: canonical file "${relativePath}" exceeds ${options.maxBytes} bytes.`);
  }

  assertStableDirectories(location.directories);
  const fd = openSync(location.path, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fstatSync(fd);
    assertSafeRegularFile(opened, relativePath);
    assertSameNode(before, opened, relativePath);
    if (options.maxBytes !== undefined && opened.size > options.maxBytes) {
      throw new Error(`memory-bujo: canonical file "${relativePath}" exceeds ${options.maxBytes} bytes.`);
    }
    assertStableDirectories(location.directories);
    assertPathMatchesFd(location.path, opened, relativePath);
    const content = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (!sameFileSnapshot(opened, after)) {
      throw new Error(`memory-bujo: canonical file "${relativePath}" changed while it was read.`);
    }
    return { content, identity: identityOf(after) };
  } finally {
    closeSync(fd);
  }
}

/**
 * List regular, single-link files from one canonical directory.
 *
 * Directory enumeration itself cannot be performed through an fd with Node's
 * synchronous API, so the directory identity is pinned with a no-follow fd
 * before and after `readdirSync`, and every selected child must be a regular,
 * single-link file at enumeration time. Callers read a selected name through
 * `readCanonicalFileSnapshot`, which re-validates the complete chain and child
 * identity. A name observed through a transient replacement can therefore
 * never make that later snapshot read outside the configured root.
 */
export function listCanonicalFileNames(
  root: string,
  relativeDirectory: string,
  options: {
    readonly allowMissing?: boolean;
    readonly include?: (name: string) => boolean;
  } = {},
): string[] {
  assertCanonicalRelativePath(relativeDirectory);
  const canonicalRoot = canonicalMemoryRootPath(root, false);
  const directoryPath = join(canonicalRoot, ...relativeDirectory.split("/"));
  assertInside(canonicalRoot, directoryPath);

  let before: Stats;
  try {
    before = lstatSync(directoryPath);
  } catch (error) {
    if (options.allowMissing === true && isMissing(error)) return [];
    throw error;
  }
  assertSafeDirectory(before, relativeDirectory);

  const fd = openSync(directoryPath, constants.O_RDONLY | directoryFlag() | noFollowFlag());
  let names: string[];
  try {
    const opened = fstatSync(fd);
    assertSafeDirectory(opened, relativeDirectory);
    assertSameNode(before, opened, relativeDirectory);
    assertPathMatchesDirectoryFd(directoryPath, opened, relativeDirectory);
    names = readdirSync(directoryPath, { encoding: "utf8" }).sort();
    assertPathMatchesDirectoryFd(directoryPath, opened, relativeDirectory);
  } finally {
    closeSync(fd);
  }

  const selected: string[] = [];
  for (const name of names) {
    if (options.include !== undefined && !options.include(name)) continue;
    // `readdir` returns one basename, but keep this validation explicit so a
    // future caller cannot turn directory enumeration into path traversal.
    if (name.length === 0 || name === "." || name === ".." || basename(name) !== name) {
      throw new Error(`memory-bujo: unsafe canonical directory entry "${name}".`);
    }
    const relativePath = `${relativeDirectory}/${name}`;
    assertCanonicalRelativePath(relativePath);
    assertSafeRegularFile(lstatSync(join(directoryPath, name)), relativePath);
    selected.push(name);
  }

  // Detect a directory replacement that happened while entries were inspected.
  assertPathMatchesDirectoryIdentity(directoryPath, before, relativeDirectory);
  return selected;
}

/** Append through a no-follow descriptor after validating the complete directory chain. */
export function appendCanonicalFile(
  root: string,
  relativePath: string,
  content: string | ((existingSize: number) => string),
): void {
  const location = canonicalLocation(root, relativePath, true, true);
  const existing = optionalLstat(location.path);
  if (existing !== undefined) assertSafeRegularFile(existing, relativePath);
  assertStableDirectories(location.directories);
  const fd = openSync(
    location.path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollowFlag(),
    DEFAULT_FILE_MODE,
  );
  const created = existing === undefined;
  try {
    const opened = fstatSync(fd);
    assertSafeRegularFile(opened, relativePath);
    if (existing !== undefined) assertSameNode(existing, opened, relativePath);
    assertStableDirectories(location.directories);
    assertPathMatchesFd(location.path, opened, relativePath);
    const data = typeof content === "function" ? content(opened.size) : content;
    if (data.length > 0) writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The file fsync makes appended bytes durable; the directory fsync makes a
  // newly-created canonical name durable before a later intent is completed.
  if (created) fsyncDirectory(location.parent);
}

/**
 * Atomically replace a canonical file using a same-directory, no-follow temp.
 * An expected identity turns an earlier safe read into a compare-and-swap.
 */
export function writeCanonicalFileAtomic(
  root: string,
  relativePath: string,
  content: string,
  expectedIdentity?: CanonicalFileIdentity,
): void {
  const location = canonicalLocation(root, relativePath, true, true);
  const existing = optionalLstat(location.path);
  if (existing !== undefined) assertSafeRegularFile(existing, relativePath);
  if (expectedIdentity !== undefined) {
    if (existing === undefined || !sameIdentity(existing, expectedIdentity)) {
      throw new Error(`memory-bujo: canonical file "${relativePath}" was replaced before rewrite.`);
    }
  }

  const temp = join(location.parent, `.${basename(location.path)}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let renamed = false;
  try {
    assertStableDirectories(location.directories);
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      DEFAULT_FILE_MODE,
    );
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    const tempIdentity = fstatSync(fd);
    assertSafeRegularFile(tempIdentity, `${relativePath} temporary file`);
    closeSync(fd);
    fd = undefined;

    assertStableDirectories(location.directories);
    assertTargetUnchanged(location.path, relativePath, existing);
    renameSync(temp, location.path);
    renamed = true;
    assertStableDirectories(location.directories);
    assertPathMatchesFd(location.path, tempIdentity, relativePath);
    fsyncDirectory(location.parent);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    if (!renamed) {
      try { unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
    }
  }
}

/** Remove one identity-stable canonical file and durably publish the deletion. */
export function removeCanonicalFile(
  root: string,
  relativePath: string,
  expectedIdentity?: CanonicalFileIdentity,
): void {
  const location = canonicalLocation(root, relativePath, false, false);
  const current = lstatSync(location.path);
  assertSafeRegularFile(current, relativePath);
  if (expectedIdentity !== undefined && !sameIdentity(current, expectedIdentity)) {
    throw new Error(`memory-bujo: canonical file "${relativePath}" changed before removal.`);
  }
  assertStableDirectories(location.directories);
  unlinkSync(location.path);
  fsyncDirectory(location.parent);
}

function canonicalLocation(
  root: string,
  relativePath: string,
  createRoot: boolean,
  createParents: boolean,
): CanonicalLocation {
  assertCanonicalRelativePath(relativePath);
  const canonicalRoot = canonicalMemoryRootPath(root, createRoot);
  const rootStat = lstatSync(canonicalRoot);
  const directories: DirectoryIdentity[] = [{
    path: canonicalRoot,
    dev: rootStat.dev,
    ino: rootStat.ino,
  }];
  const parts = relativePath.split("/");
  const fileName = parts.pop()!;
  let parent = canonicalRoot;
  for (const component of parts) {
    parent = join(parent, component);
    let stat = optionalLstat(parent);
    if (stat === undefined && createParents) {
      try {
        mkdirSync(parent, { mode: DEFAULT_DIRECTORY_MODE });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      stat = lstatSync(parent);
    }
    if (stat === undefined) lstatSync(parent);
    if (stat!.isSymbolicLink() || !stat!.isDirectory()) {
      throw new Error(`memory-bujo: canonical directory "${component}" must not be a symlink.`);
    }
    directories.push({ path: parent, dev: stat!.dev, ino: stat!.ino });
  }
  const path = join(parent, fileName);
  assertInside(canonicalRoot, path);
  return { path, parent, directories };
}

function assertStableDirectories(directories: readonly DirectoryIdentity[]): void {
  for (const expected of directories) {
    const current = lstatSync(expected.path);
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
    ) {
      throw new Error("memory-bujo: canonical directory identity changed during file access.");
    }
  }
}

function assertTargetUnchanged(path: string, label: string, expected: Stats | undefined): void {
  const current = optionalLstat(path);
  if (expected === undefined) {
    if (current !== undefined) throw new Error(`memory-bujo: canonical file "${label}" appeared during write.`);
    return;
  }
  if (current === undefined || !sameFileSnapshot(expected, current)) {
    throw new Error(`memory-bujo: canonical file "${label}" changed during write.`);
  }
}

function assertPathMatchesFd(path: string, opened: Stats, label: string): void {
  const current = lstatSync(path);
  assertSafeRegularFile(current, label);
  assertSameNode(current, opened, label);
}

function assertPathMatchesDirectoryFd(path: string, opened: Stats, label: string): void {
  const current = lstatSync(path);
  assertSafeDirectory(current, label);
  assertSameNode(current, opened, label);
}

function assertPathMatchesDirectoryIdentity(path: string, expected: Stats, label: string): void {
  const current = lstatSync(path);
  assertSafeDirectory(current, label);
  assertSameNode(current, expected, label);
}

function assertSafeRegularFile(stat: Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`memory-bujo: canonical file "${label}" must be regular, single-link, and not a symlink.`);
  }
}

function assertSafeDirectory(stat: Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`memory-bujo: canonical directory "${label}" must be a real directory and not a symlink.`);
  }
}

function assertSameNode(left: Stats, right: Stats, label: string): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error(`memory-bujo: canonical file "${label}" was replaced during access.`);
  }
}

function sameIdentity(stat: Stats, identity: CanonicalFileIdentity): boolean {
  return stat.dev === identity.dev
    && stat.ino === identity.ino
    && stat.size === identity.size
    && stat.mtimeMs === identity.mtimeMs
    && stat.ctimeMs === identity.ctimeMs;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function identityOf(stat: Stats): CanonicalFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("memory-bujo: canonical path escapes the configured memory root.");
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error("memory-bujo: fsync target is not a directory.");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function directoryFlag(): number {
  return constants.O_DIRECTORY ?? 0;
}

function optionalLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isCanonicalIsoDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

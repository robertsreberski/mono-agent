import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, opendir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { MANAGED_SRT_TREE_EXCLUSIONS } from "./managed-identity.js";

// Read-only mechanics. Callers retain expected-digest policy and validation order.
export class ManagedSrtCorruptError extends Error {
  readonly installRoot: string;

  constructor(installRoot: string, message: string) {
    super(`Managed SRT install at ${installRoot} is unsafe or corrupt: ${message}`);
    this.name = "ManagedSrtCorruptError";
    this.installRoot = installRoot;
  }
}

export async function assertManagedSrtDirectory(path: string, label: string, installRoot: string, policy: "runtime" | "installer" = "runtime"): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (policy === "installer") throw error;
    throw corrupt(installRoot, `${label} is unavailable (${errorMessage(error)})`);
  }
  if (policy === "installer") {
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
      || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error(`${path} must be a real owner-only directory owned by the current user`);
    }
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw corrupt(installRoot, `${label} is not a real directory`);
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    throw corrupt(installRoot, `${label} is not owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw corrupt(installRoot, `${label} grants access to group or other users`);
  }
}

export async function assertManagedSrtRegularFile(
  path: string,
  requirePrivate: boolean,
  label: string,
  installRoot = path,
  requireExecutable = false,
  policy: "runtime" | "installer" = "runtime",
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (policy === "installer") throw error;
    throw corrupt(installRoot, `${label} is unavailable (${errorMessage(error)})`);
  }
  if (policy === "installer") {
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
      || (requirePrivate && (stat.mode & 0o077) !== 0)) {
      throw new Error(`${path} must be a ${requirePrivate ? "private " : ""}single-link regular file`);
    }
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw corrupt(installRoot, `${label} is not a regular non-symbolic file`);
  }
  // The launcher path is checked against sandbox writable roots later, but a
  // second hardlink could name the same owner-writable inode from inside one of
  // those roots. There is no portable way to enumerate every alias, so retain
  // the single-link invariant for launchers as well as private managed files.
  if (stat.nlink !== 1) {
    throw corrupt(
      installRoot,
      `${label} has ${stat.nlink} hard links; expected exactly one so no writable-root alias can modify it`,
    );
  }
  if (requireExecutable && process.getuid === undefined) {
    throw corrupt(installRoot, `${label} ownership cannot be verified on this platform`);
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid() && stat.uid !== 0) {
    throw corrupt(installRoot, `${label} has an unexpected owner`);
  }
  if (requirePrivate && (stat.mode & 0o077) !== 0) {
    throw corrupt(installRoot, `${label} grants access to group or other users`);
  }
  if (!requirePrivate && (stat.mode & 0o022) !== 0) {
    throw corrupt(installRoot, `${label} is writable by group or other users`);
  }
  if (requireExecutable && (stat.mode & 0o6000) !== 0) {
    throw corrupt(installRoot, `${label} has setuid or setgid privilege bits`);
  }
  if (requireExecutable) {
    try {
      await access(path, fsConstants.X_OK);
    } catch (error) {
      throw corrupt(installRoot, `${label} is not executable by the current user (${errorMessage(error)})`);
    }
  }
}

export async function hashManagedSrtFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function hashPrivateManagedSrtTree(installRoot: string, policy: "runtime" | "installer" = "runtime"): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directoryPath: string): Promise<void> {
    const directory = await opendir(directoryPath);
    const entries = [];
    for await (const entry of directory) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      const relativePath = relative(installRoot, path);
      if (MANAGED_SRT_TREE_EXCLUSIONS.includes(relativePath)) {
        continue;
      }
      const entryStat = await lstat(path);
      if (policy === "installer" && (entryStat.isSymbolicLink()
        || (process.getuid !== undefined && entryStat.uid !== process.getuid())
        || (entryStat.mode & 0o077) !== 0)) {
        throw new Error(`unsafe managed dependency tree entry: ${relativePath}`);
      }
      if (entryStat.isSymbolicLink()) {
        throw corrupt(installRoot, `managed dependency tree contains a symbolic link: ${relativePath}`);
      }
      if (process.getuid !== undefined && entryStat.uid !== process.getuid()) {
        throw corrupt(installRoot, `managed dependency tree has an unexpected owner: ${relativePath}`);
      }
      if ((entryStat.mode & 0o077) !== 0) {
        throw corrupt(installRoot, `managed dependency tree is not owner-only: ${relativePath}`);
      }
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(path);
      } else if (entryStat.isFile() && entryStat.nlink === 1) {
        hash.update(`F\0${relativePath}\0${entryStat.size}\0`);
        hash.update(await readFile(path));
      } else {
        if (policy === "installer") throw new Error(`unsupported managed dependency tree entry: ${relativePath}`);
        throw corrupt(installRoot, `managed dependency tree contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  await walk(installRoot);
  return hash.digest("hex");
}

function corrupt(installRoot: string, reason: string): ManagedSrtCorruptError {
  return new ManagedSrtCorruptError(installRoot, reason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


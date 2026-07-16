import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

interface SecureFileIdentity { readonly dev: number | bigint; readonly ino: number | bigint }

interface SecureFileReplaceOptions {
  readonly path: string;
  readonly contents: string | Buffer;
  readonly mode: number;
  readonly temporaryPath?: string;
  /** Additional caller-specific validation for the durable temporary inode. */
  readonly validateTemporary?: (details: Stats, path: string) => void;
  /** Compare-and-swap checks which may yield before the final commit. */
  readonly beforeCommit?: (temporaryPath: string) => void | Promise<void>;
  /** Caller-owned atomic publication step. */
  readonly commit: (temporaryPath: string) => void | Promise<void>;
}

/** Stage a durable secure inode, then let the caller choose its atomic commit semantics. */
export async function secureFileReplace(options: SecureFileReplaceOptions): Promise<void> {
  const temporaryPath = options.temporaryPath
    ?? join(dirname(options.path), `.${basename(options.path)}.mono-agent-${randomUUID()}.tmp`);
  const expectedContents = typeof options.contents === "string"
    ? Buffer.from(options.contents, "utf8") : Buffer.from(options.contents);
  let handle: FileHandle | undefined;
  let identity: SecureFileIdentity | undefined;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await open(temporaryPath, flags, options.mode);
    identity = fileIdentity(await handle.stat());
    await handle.writeFile(expectedContents);
    await handle.chmod(options.mode);
    const details = await handle.stat();
    assertSecureTemporary(details, temporaryPath, options.mode);
    options.validateTemporary?.(details, temporaryPath);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await options.beforeCommit?.(temporaryPath);
    await assertExactTemporary(temporaryPath, identity, options.mode, expectedContents);
    await options.commit(temporaryPath);
  } catch (error) {
    const failures: unknown[] = [error];
    try { await handle?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try {
      if (identity !== undefined) await removeExactTemporary(temporaryPath, identity);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Secure replacement failed (${errorMessage(error)}) and its exact temporary cleanup also failed.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (identity !== undefined) await removeExactTemporary(temporaryPath, identity);
}

async function assertExactTemporary(
  path: string, identity: SecureFileIdentity, mode: number, expectedContents: Buffer,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    assertSecureTemporary(before, path, mode);
    if (!sameFileIdentity(before, identity)) throw changedTemporary(path);
    const contents = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(path);
    assertSecureTemporary(after, path, mode);
    assertSecureTemporary(named, path, mode);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, named)) throw changedTemporary(path);
    if (!contents.equals(expectedContents)) {
      throw new Error(`Secure replacement temporary ${path} contents changed before commit and were left untouched.`);
    }
  } finally {
    await handle.close();
  }
}

function assertSecureTemporary(details: Stats, path: string, mode: number): void {
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error(`Secure replacement temporary ${path} must be a single-link regular file.`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`Secure replacement temporary ${path} is not owned by the current user.`);
  }
  if ((details.mode & 0o777) !== mode) {
    throw new Error(
      `Secure replacement temporary ${path} has mode ${(details.mode & 0o777).toString(8)}; expected ${mode.toString(8)}.`,
    );
  }
}

function fileIdentity(details: { readonly dev: number | bigint; readonly ino: number | bigint }): SecureFileIdentity {
  return { dev: details.dev, ino: details.ino };
}
function sameFileIdentity(details: SecureFileIdentity, identity: SecureFileIdentity): boolean {
  return details.dev === identity.dev && details.ino === identity.ino;
}
function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function changedTemporary(path: string): Error { return new Error(`Secure replacement temporary ${path} changed before commit and was left untouched.`); }

async function removeExactTemporary(path: string, identity: SecureFileIdentity): Promise<void> {
  let details: Stats;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sameFileIdentity(details, identity)) {
    throw new Error(`Secure replacement temporary ${path} changed unexpectedly and was left untouched.`);
  }
  await unlink(path);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

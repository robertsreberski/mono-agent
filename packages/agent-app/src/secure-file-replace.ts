import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

interface SecureFileIdentity { readonly dev: bigint; readonly ino: bigint }

interface SecureFileCommitProof {
  /** Re-prove that a publication path still names the staged inode and bytes. */
  readonly assertPath: (path: string, allowedLinkCounts?: readonly number[]) => Promise<void>;
}

interface SecureFileReplaceOptions {
  readonly path: string;
  readonly contents: string | Buffer;
  readonly mode: number;
  readonly temporaryPath?: string;
  /** Additional caller-specific validation for the durable temporary inode. */
  readonly validateTemporary?: (details: BigIntStats, path: string) => void;
  /** Compare-and-swap checks which may yield before the final commit. */
  readonly beforeCommit?: (temporaryPath: string) => void | Promise<void>;
  /** Caller-owned atomic publication step. */
  readonly commit: (temporaryPath: string, proof: SecureFileCommitProof) => void | Promise<void>;
}

/** Stage a durable secure inode, then let the caller choose its atomic commit semantics. */
export async function secureFileReplace(options: SecureFileReplaceOptions): Promise<void> {
  const temporaryPath = options.temporaryPath
    ?? join(dirname(options.path), `.${basename(options.path)}.mono-agent-${randomUUID()}.tmp`);
  const expectedContents = typeof options.contents === "string"
    ? Buffer.from(options.contents, "utf8") : Buffer.from(options.contents);
  let handle: FileHandle | undefined;
  let identity: SecureFileIdentity | undefined;
  let temporaryCleanupPending = false;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await open(temporaryPath, flags, options.mode);
    identity = fileIdentity(await handle.stat({ bigint: true }));
    temporaryCleanupPending = true;
    await handle.writeFile(expectedContents);
    await handle.chmod(options.mode);
    const details = await handle.stat({ bigint: true });
    assertSecureFile(details, temporaryPath, options.mode, [1]);
    options.validateTemporary?.(details, temporaryPath);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await options.beforeCommit?.(temporaryPath);
    const proof: SecureFileCommitProof = {
      assertPath: (path, allowedLinkCounts) => assertExactFile(
        path,
        identity!,
        options.mode,
        expectedContents,
        allowedLinkCounts,
      ),
    };
    await proof.assertPath(temporaryPath);
    await options.commit(temporaryPath, proof);
    // Hard-link publication temporarily gives the staged inode two names.
    // Consume our private name before requiring the final path to be single-link.
    temporaryCleanupPending = false;
    await removeExactTemporary(temporaryPath, identity);
    await proof.assertPath(options.path);
  } catch (error) {
    const failures: unknown[] = [error];
    try { await handle?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try {
      if (identity !== undefined && temporaryCleanupPending) {
        await removeExactTemporary(temporaryPath, identity);
      }
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
}

async function assertExactFile(
  path: string,
  identity: SecureFileIdentity,
  mode: number,
  expectedContents: Buffer,
  allowedLinkCounts: readonly number[] = [1],
): Promise<void> {
  // O_NONBLOCK matters before fstat: a same-user pathname swap to a FIFO must
  // fail closed instead of hanging the security check while opening it.
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertSecureFile(before, path, mode, allowedLinkCounts);
    if (!sameFileIdentity(before, identity)) throw changedFile(path);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    assertSecureFile(after, path, mode, allowedLinkCounts);
    assertSecureFile(named, path, mode, allowedLinkCounts);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, named)) throw changedFile(path);
    if (!contents.equals(expectedContents)) {
      throw new Error(`Secure replacement file ${path} contents changed during publication and was left untouched.`);
    }
  } finally {
    await handle.close();
  }
}

function assertSecureFile(
  details: BigIntStats,
  path: string,
  mode: number,
  allowedLinkCounts: readonly number[],
): void {
  if (!details.isFile() || details.isSymbolicLink()
    || !allowedLinkCounts.some((linkCount) => details.nlink === BigInt(linkCount))) {
    throw new Error(`Secure replacement file ${path} has an unexpected type or link count.`);
  }
  if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
    throw new Error(`Secure replacement file ${path} is not owned by the current user.`);
  }
  if ((details.mode & 0o777n) !== BigInt(mode)) {
    throw new Error(
      `Secure replacement file ${path} has mode ${(details.mode & 0o777n).toString(8)}; expected ${mode.toString(8)}.`,
    );
  }
}

function fileIdentity(details: { readonly dev: bigint; readonly ino: bigint }): SecureFileIdentity {
  return { dev: details.dev, ino: details.ino };
}
function sameFileIdentity(details: SecureFileIdentity, identity: SecureFileIdentity): boolean {
  return details.dev === identity.dev && details.ino === identity.ino;
}
function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function changedFile(path: string): Error {
  return new Error(`Secure replacement file ${path} changed during publication and was left untouched.`);
}

async function removeExactTemporary(path: string, identity: SecureFileIdentity): Promise<void> {
  let details: BigIntStats;
  try {
    details = await lstat(path, { bigint: true });
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

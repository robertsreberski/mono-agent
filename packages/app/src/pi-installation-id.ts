import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA = "mono-agent.pi-installation-id.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 256;

/** Safe operator-facing failure; never includes the installation UUID or filesystem error text. */
export class PiInstallationIdError extends Error {
  readonly code = "installation_id_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PiInstallationIdError";
  }
}

/** Installation identity is scoped to the owner-only Pi auth directory, not a staged login store. */
export async function getOrCreatePiInstallationId(authPath: string): Promise<string> {
  try {
    return await getOrCreatePiInstallationIdFile(authPath);
  } catch (error) {
    if (error instanceof PiInstallationIdError) throw error;
    throw new PiInstallationIdError("ChatGPT installation ID could not be securely read or created; inspect its owner-only auth directory before retrying.");
  }
}

async function getOrCreatePiInstallationIdFile(authPath: string): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === "win32") {
    throw new PiInstallationIdError("ChatGPT sign-in requires owner-only installation ID files on a supported POSIX host.");
  }
  const requestedParent = dirname(authPath);
  await mkdir(requestedParent, { recursive: true, mode: 0o700 });
  const parent = await realpath(requestedParent);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== uid || (parentStat.mode & 0o022) !== 0) {
    throw new PiInstallationIdError("ChatGPT installation ID directory must be owned by the current user and not group/world-writable.");
  }
  await assertOutsideGitWorktree(parent);
  const target = join(parent, "mono-agent-installation-id.json");
  try {
    const id = await readInstallationId(target, uid);
    await cleanupStaleInstallationLinks(parent, target, uid);
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(parent, `.installation-id-${process.pid}-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify({ schema: SCHEMA, id: randomUUID() })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const id = await readInstallationId(target, uid);
      await cleanupStaleInstallationLinks(parent, target, uid);
      return id;
    }
    await syncDirectory(parent);
    return await readInstallationId(target, uid);
  } finally {
    if (created) {
      await unlink(temporary);
      await syncDirectory(parent);
    } else {
      await rm(temporary, { force: true });
    }
  }
}

async function readInstallationId(path: string, uid: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const pathStat = await lstat(path);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600
      || stat.size > MAX_BYTES
      || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new PiInstallationIdError("ChatGPT installation ID file is unsafe; inspect it before signing in again.");
    }
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value as { schema?: unknown }).schema !== SCHEMA
      || typeof (value as { id?: unknown }).id !== "string"
      || !UUID.test((value as { id: string }).id)) {
      throw new PiInstallationIdError("ChatGPT installation ID file is invalid; inspect it before signing in again.");
    }
    return (value as { id: string }).id;
  } catch (error) {
    if (error instanceof SyntaxError) throw new PiInstallationIdError("ChatGPT installation ID file is invalid; inspect it before signing in again.");
    throw error;
  } finally {
    await handle.close();
  }
}

// A crashed publisher may leave a second hard link to the already complete ID.
// Never touch a live writer: only reclaim own-prefix links older than one day.
async function cleanupStaleInstallationLinks(parent: string, target: string, uid: number): Promise<void> {
  try {
    const winner = await lstat(target);
    if (winner.nlink < 2) return;
    for (const name of await readdir(parent)) {
      if (!/^\.installation-id-\d+-[0-9a-f-]+\.tmp$/u.test(name)) continue;
      const path = join(parent, name);
      const entry = await lstat(path);
      if (!entry.isFile() || entry.uid !== uid || entry.dev !== winner.dev || entry.ino !== winner.ino
        || Date.now() - entry.mtimeMs < 86_400_000) continue;
      await unlink(path);
      await syncDirectory(parent);
    }
  } catch { /* Best-effort orphan cleanup must not block a valid existing ID. */ }
}

async function syncDirectory(parent: string): Promise<void> {
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertOutsideGitWorktree(parent: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["-C", parent, "rev-parse", "--show-toplevel"], (error) => {
      if (error === null) reject(new PiInstallationIdError("Refusing to write a ChatGPT installation ID inside a Git worktree."));
      else resolve();
    });
  });
  // A failed git invocation must not allow an unrecognized repository directory.
  let current = parent;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      throw new PiInstallationIdError("Refusing to write a ChatGPT installation ID inside a Git worktree.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = dirname(current);
    if (next === current) return;
    current = next;
  }
}

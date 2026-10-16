import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat,open } from "node:fs/promises";
import { parseEnv } from "node:util";
export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface CliDotenvSnapshot {
  readonly env: Readonly<Record<string, string>>;
  /** Opaque content + mode fingerprint; never contains a plaintext dotenv value. */
  readonly fingerprint: string;
}

export interface CliConfigSnapshot {
  /** Exact UTF-8 bytes read from the regular config file. Config never contains persisted secrets. */
  readonly contents: string;
  readonly digest: string;
  /** Content plus file identity/mode fingerprint used to detect edits and replacement. */
  readonly fingerprint: string;
}

/** Read and fingerprint dotenv without changing process.env. A missing file is empty. */
export async function readCliDotenvSnapshot(path: string): Promise<CliDotenvSnapshot> {
  let handle;
  try {
    // O_NONBLOCK matters before fstat: opening a FIFO read-only can otherwise
    // wait forever for a writer, preventing us from reaching the regular-file
    // check. It is a no-op for ordinary files.
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { env: {}, fingerprint: "missing" };
    }
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read dotenv path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to read dotenv path ${path} because it is not a regular file.`);
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const mode = fileStat.mode & 0o777;
    const env = Object.fromEntries(
      Object.entries(parseEnv(contents)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const digest = createHash("sha256").update(contents).digest("hex");
    return { env, fingerprint: `file:${mode.toString(8)}:${digest}` };
  } finally {
    await handle.close();
  }
}

/** Read a dotenv file without changing process.env. A missing file is empty. */
export async function readCliDotenvFile(path: string): Promise<Record<string, string>> {
  return { ...(await readCliDotenvSnapshot(path)).env };
}

/** Read one exact config snapshot without following the final path component. */
export async function readCliConfigSnapshot(path: string): Promise<CliConfigSnapshot> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read config path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to read config path ${path} because it is not a regular file.`);
    }
    const bytes = await handle.readFile();
    const pathStat = await lstat(path);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== fileStat.dev ||
      pathStat.ino !== fileStat.ino
    ) {
      throw new Error(`Refusing to read config path ${path} because it changed during setup.`);
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Refusing to read config path ${path} because it is not valid UTF-8.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mode = fileStat.mode & 0o777;
    return {
      contents,
      digest,
      fingerprint: [
        "file",
        fileStat.dev,
        fileStat.ino,
        fileStat.size,
        fileStat.mtimeMs,
        fileStat.ctimeMs,
        mode.toString(8),
        digest,
      ].join(":"),
    };
  } finally {
    await handle.close();
  }
}

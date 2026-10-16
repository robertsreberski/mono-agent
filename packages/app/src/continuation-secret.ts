import { randomBytes } from "node:crypto";
import { lstat,readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureOwnerOnlyDirectory } from "./durable-state/private-files.js";
import { isMissing,isObject } from "./continuation-store-policy.js";
export async function loadOrCreateContinuationSecret(stateDir: string): Promise<Buffer> {
  await ensureOwnerOnlyDirectory(stateDir);
  const path = join(stateDir, "continuation-secret");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Continuation secret is not a regular file: ${path}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`Continuation secret is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`Continuation secret permissions are not owner-only: ${path}`);
    }
    const encoded = (await readFile(path, "utf8")).trim();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length !== 32) throw new Error(`Continuation secret has invalid contents: ${path}`);
    return secret;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const secret = randomBytes(32);
  try {
    await writeFile(path, `${secret.toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if (!isObject(error) || error.code !== "EEXIST") throw error;
    return await loadOrCreateContinuationSecret(stateDir);
  }
}

import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { fileIdentity, sameFileIdentity, type FileIdentity } from "./file-identity.js";

const SAFE_ADAPTER_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export async function ensureAdapterRunOutputDir(
  root: string,
  runId: string,
): Promise<{ readonly path: string; readonly identity: FileIdentity }> {
  if (!SAFE_ADAPTER_RUN_ID.test(runId)) {
    throw new Error("adapter-send-tools: run id is unsafe for the run output directory.");
  }
  const outputRoot = resolvePath(root);
  const runOutputDir = join(outputRoot, runId);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(runOutputDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await lstat(runOutputDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("adapter-send-tools: run output path is not a real directory.");
    }
  }
  const current = await lstat(runOutputDir);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error("adapter-send-tools: run output path is not a real directory.");
  }
  return { path: runOutputDir, identity: fileIdentity(current) };
}

export async function removeOwnedDirectory(path: string, expected: FileIdentity): Promise<void> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) return;
  await rm(path, { recursive: true, force: true });
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import type { WizardPlan } from "./wizard-types.js";
import { syncDirectoryBestEffort } from "./file-sync.js";

export async function createMonoAgentConfigExclusively(
  path: string,
  config: WizardPlan["configJson"],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.mono-agent-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link is an atomic create-if-absent operation. Unlike rename it cannot
    // replace a config another process created while the wizard was running.
    await link(temporaryPath, path);
    await syncDirectoryBestEffort(dirname(path));
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

export async function removeCreatedConfigIfUnchanged(
  path: string,
  expectedIdentity: { readonly dev: number; readonly ino: number },
  expectedContents: string,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(opened, expectedIdentity)) return false;
    if (await handle.readFile({ encoding: "utf8" }) !== expectedContents) return false;
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameFileIdentity(named, expectedIdentity)) {
      return false;
    }
    await unlink(path);
    await syncDirectoryBestEffort(dirname(path));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(
  value: { readonly dev: number; readonly ino: number },
  expected: { readonly dev: number; readonly ino: number },
): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}

export function identityTemplate(
  dir: string,
  agentName: string,
  purpose: string,
  knowledgeFiles: readonly string[],
): string {
  const knowledgeSection = knowledgeFiles.length === 0
    ? "No existing project knowledge files were detected. Add references to authoritative knowledge here when available."
    : [
        "This folder already carries knowledge the agent must read and respect:",
        "",
        ...knowledgeFiles.map((file) => `- \`${file}\``),
      ].join("\n");

  return `# Identity

You are ${agentName}, a mono agent constructed in \`${basename(dir)}\`.

## Role

${purpose}

## Knowledge

${knowledgeSection}

## Boundaries

- Work inside this folder unless the user explicitly widens the workspace.
- Confirm before destructive changes.
- Fail honestly: report runtime or tool errors instead of inventing results.
`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function scaffoldPathEscapesRoot(pathRelative: string): boolean {
  return pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative);
}

/**
 * Refuse generated scaffold artifacts whose parent chain escapes through a
 * symlink. This protects ordinary and save-incomplete init alike; staging is a
 * validation boundary, not authorization to weaken the eventual write path.
 */
export async function ensureSafeScaffoldParent(
  root: string,
  filePath: string,
  createMissing: boolean,
): Promise<void> {
  const pathRelative = relative(root, filePath);
  if (pathRelative.length === 0 || scaffoldPathEscapesRoot(pathRelative)) {
    throw new Error(`Refusing to create scaffold artifact outside the agent directory: ${filePath}`);
  }
  const parentRelative = dirname(pathRelative);
  if (parentRelative === ".") return;

  let current = root;
  for (const segment of parentRelative.split(sep).filter((part) => part.length > 0)) {
    const next = join(current, segment);
    let entry;
    try {
      entry = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createMissing) return;
      try {
        await mkdir(next);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      entry = await lstat(next);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to create scaffold artifact through symbolic-link parent: ${next}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`Refusing to create scaffold artifact through non-directory parent: ${next}`);
    }
    current = next;
  }
}

export async function assertSafeScaffoldTarget(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic-link scaffold ${label}: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createSafeScaffoldDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Refusing non-directory scaffold working path: ${path}`);
  }
}

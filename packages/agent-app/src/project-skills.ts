import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { lstat, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { GeneratedFile } from "./modules/types.js";

export const PROJECT_SKILL_VERSION = "1.0.0";
export const PROJECT_SKILL_MANIFEST_PATH = "skills/.mono-agent-managed.json";

export const PROJECT_SKILL_NAMES = [
  "mono-agent-configure",
  "mono-agent-memory",
] as const;

export type ProjectSkillName = (typeof PROJECT_SKILL_NAMES)[number];

interface BundledProjectSkill {
  readonly name: ProjectSkillName;
  readonly contents: string;
}

const CONFIGURE_SKILL = `---
name: mono-agent-configure
description: Safely refine this agent's identity and config from the local mono-agent TUI.
version: ${PROJECT_SKILL_VERSION}
---

# Configure this agent

Use this skill when the operator asks to configure, tune, or change this agent.

1. Treat the current resolved config, IDENTITY.md, and validation output as operational truth. Memory may recall preferences, but never use memory as proof that a change is active.
2. Ask at most one focused question at a time. If the operator gives an ordinary task instead of configuration intent, perform that task and stop the configuration flow.
3. Never ask for API keys, OAuth tokens, passwords, bot tokens, or other secrets in chat. Explain the exact masked mono-agent auth or owner-only .env flow instead.
4. For a safe local change, call ProposeAgentConfiguration with a short rationale, an RFC 6902 JSON Patch against mono-agent.config.json, and optionally a replacement body for the existing ## Role section in IDENTITY.md.
5. Do not claim the proposal was applied. The host validates it, shows an out-of-band diff, and requires the operator to approve it.
6. Keep config proposals to the host's documented low-risk allowlist: public name; effort, turn/session UX; selected project skills and disclosure; memory size or MemoryRecall enablement; and tool-policy tightening. Paths, memory tier/capture behavior, external MCP servers, plugins, channels or cron/proactive jobs, tool/runtime permissions, model-route or provider posture, embeddings/LLM endpoints, exporters, sandboxing, and network exposure require the explicit guided flow named by the host.

Keep proposals minimal. Preserve unrelated config, existing knowledge references, and every identity section except the optional Role body.
`;

const MEMORY_SKILL = `---
name: mono-agent-memory
description: Choose, inspect, and tune mono-agent's built-in memory without guessing about stored state.
version: ${PROJECT_SKILL_VERSION}
---

# Configure memory

Use this skill when the operator asks how this agent should remember information.

- No memory: conversations do not create durable cross-session memory.
- Lite: deterministic lexical recall with the smallest dependency and operating surface.
- Journal: deterministic semantic recall and background indexing, without capture-model calls.
- BuJo: curated capture plus entity relationships; use it only when the extra model work and graph behavior are valuable.

MemoryRecall is a read-only tool and is enabled by default whenever a memory tier is configured. Use it to recover prior preferences, but inspect the current config and memory audit before describing what is active.

Never paste remembered private content into a config proposal. Never request embedding or provider secrets in chat. Hand credential setup to the masked guided flow.

Use ProposeAgentConfiguration only to adjust memory.maxBytes or memory.recallTool.enabled. Memory tier, path, write/capture behavior, consolidation, embeddings, LLM, provider, endpoint, and credential changes belong in the explicit guided flow. Explain prerequisite services and expected indexing/capture cost before handing Journal or BuJo setup to that flow. The host, not this skill, decides whether a candidate validates and can be applied.
`;

export const BUNDLED_PROJECT_SKILLS: readonly BundledProjectSkill[] = [
  { name: "mono-agent-configure", contents: CONFIGURE_SKILL },
  { name: "mono-agent-memory", contents: MEMORY_SKILL },
];

interface ManagedSkillManifest {
  readonly schema: "mono-agent.managed-project-skills.v1";
  readonly version: string;
  readonly skills: Readonly<Record<ProjectSkillName, { readonly sha256: string }>>;
}

export type ProjectSkillStatusKind = "ready" | "missing" | "stale" | "modified" | "collision";

export interface ProjectSkillStatus {
  readonly name: ProjectSkillName;
  readonly path: string;
  readonly status: ProjectSkillStatusKind;
  readonly installedSha256?: string;
  readonly expectedSha256: string;
}

export interface CheckProjectSkillsResult {
  readonly manifestPath: string;
  readonly manifestVersion?: string;
  readonly statuses: readonly ProjectSkillStatus[];
  readonly ok: boolean;
}

export interface UpdateProjectSkillsResult extends CheckProjectSkillsResult {
  readonly updated: readonly string[];
  readonly backupDir?: string;
}

export interface UpdateManagedProjectSkillsOptions {
  /** Fault-injection seam invoked before the built-in compare-and-swap writer. */
  readonly beforeActivate?: (path: string, contents: string) => Promise<void>;
}

interface ManagedFileSnapshot {
  readonly path: string;
  readonly contents?: string;
  readonly mode?: number;
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function desiredManifest(): ManagedSkillManifest {
  return {
    schema: "mono-agent.managed-project-skills.v1",
    version: PROJECT_SKILL_VERSION,
    skills: Object.fromEntries(BUNDLED_PROJECT_SKILLS.map((skill) => [
      skill.name,
      { sha256: sha256(skill.contents) },
    ])) as ManagedSkillManifest["skills"],
  };
}

export function managedProjectSkillFiles(): readonly GeneratedFile[] {
  const manifest = desiredManifest();
  return [
    ...BUNDLED_PROJECT_SKILLS.map((skill) => ({
      path: `skills/${skill.name}/SKILL.md`,
      contents: skill.contents,
    })),
    {
      path: PROJECT_SKILL_MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
}

export async function checkManagedProjectSkills(cwd: string): Promise<CheckProjectSkillsResult> {
  const root = resolve(cwd);
  const manifestPath = join(root, PROJECT_SKILL_MANIFEST_PATH);
  const manifest = await readManifest(manifestPath);
  const desired = desiredManifest();
  const statuses: ProjectSkillStatus[] = [];

  for (const skill of BUNDLED_PROJECT_SKILLS) {
    const path = join(root, "skills", skill.name, "SKILL.md");
    const expectedSha256 = desired.skills[skill.name].sha256;
    const installed = await readOptional(path);
    if (installed === undefined) {
      statuses.push({ name: skill.name, path, status: "missing", expectedSha256 });
      continue;
    }
    const installedSha256 = sha256(installed);
    const recorded = manifest?.skills[skill.name]?.sha256;
    if (recorded === undefined) {
      statuses.push({ name: skill.name, path, status: "collision", installedSha256, expectedSha256 });
    } else if (installedSha256 !== recorded) {
      statuses.push({ name: skill.name, path, status: "modified", installedSha256, expectedSha256 });
    } else if (installedSha256 !== expectedSha256 || manifest?.version !== PROJECT_SKILL_VERSION) {
      statuses.push({ name: skill.name, path, status: "stale", installedSha256, expectedSha256 });
    } else {
      statuses.push({ name: skill.name, path, status: "ready", installedSha256, expectedSha256 });
    }
  }

  return {
    manifestPath,
    ...(manifest?.version === undefined ? {} : { manifestVersion: manifest.version }),
    statuses,
    ok: statuses.every((status) => status.status === "ready"),
  };
}

/** Fail before init writes anything when an existing skill would be claimed or overwritten. */
export async function assertManagedProjectSkillInitSafe(cwd: string): Promise<void> {
  const check = await checkManagedProjectSkills(cwd);
  const conflicts = check.statuses.filter((entry) => entry.status === "collision" || entry.status === "modified");
  if (conflicts.length === 0) return;
  throw new Error(
    `Project skill collision: ${conflicts.map((entry) => entry.path).join(", ")} contains operator-managed content. ` +
    "Move or rename the colliding skill, or keep it and select a different skill name; mono-agent will not overwrite it.",
  );
}

export async function updateManagedProjectSkills(
  cwd: string,
  options: UpdateManagedProjectSkillsOptions = {},
): Promise<UpdateProjectSkillsResult> {
  return await withManagedProjectSkillLock(cwd, async () =>
    await updateManagedProjectSkillsUnlocked(cwd, options));
}

async function updateManagedProjectSkillsUnlocked(
  cwd: string,
  options: UpdateManagedProjectSkillsOptions,
): Promise<UpdateProjectSkillsResult> {
  const before = await checkManagedProjectSkills(cwd);
  const unsafe = before.statuses.filter((entry) => entry.status === "modified" || entry.status === "collision");
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to update operator-modified project skills: ${unsafe.map((entry) => `${entry.name} (${entry.path})`).join(", ")}. ` +
      "Copy your edits elsewhere or restore the recorded managed version, then retry.",
    );
  }

  const needsUpdate = before.statuses.filter((entry) => entry.status !== "ready");
  if (needsUpdate.length === 0) {
    return { ...before, updated: [] };
  }

  const root = resolve(cwd);
  const changeId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = join(root, "skills", ".mono-agent-backups", changeId);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });

  const skillTargets = BUNDLED_PROJECT_SKILLS.flatMap((skill) => {
    const status = needsUpdate.find((entry) => entry.name === skill.name);
    return status === undefined ? [] : [{ path: status.path, contents: skill.contents, name: skill.name }];
  });
  const manifestPath = join(root, PROJECT_SKILL_MANIFEST_PATH);
  const manifestContents = `${JSON.stringify(desiredManifest(), null, 2)}\n`;
  const snapshots = new Map<string, ManagedFileSnapshot>();
  for (const target of [...skillTargets, { path: manifestPath, contents: manifestContents, name: "manifest" }]) {
    snapshots.set(target.path, await snapshotManagedFile(target.path));
  }
  const afterSnapshots = await checkManagedProjectSkills(root);
  if (!isDeepStrictEqual(afterSnapshots, before)) {
    throw new Error("Managed project skills changed while the update was being prepared. No files were written; retry from the current copies.");
  }

  for (const status of needsUpdate) {
    const snapshot = snapshots.get(status.path)!;
    if (snapshot.contents !== undefined) {
      const backup = join(backupDir, status.name, "SKILL.md");
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await writeFile(backup, snapshot.contents, { flag: "wx", mode: snapshot.mode ?? 0o600 });
    }
  }
  const manifestSnapshot = snapshots.get(manifestPath)!;
  if (manifestSnapshot.contents !== undefined) {
    await writeFile(join(backupDir, ".mono-agent-managed.json"), manifestSnapshot.contents, {
      flag: "wx",
      mode: manifestSnapshot.mode ?? 0o600,
    });
  }

  const updated: string[] = [];
  const activated: Array<{ readonly path: string; readonly contents: string }> = [];
  try {
    for (const target of skillTargets) {
      await mkdir(dirname(target.path), { recursive: true });
      await options.beforeActivate?.(target.path, target.contents);
      const snapshot = snapshots.get(target.path)!;
      await atomicWriteManagedExact(target.path, snapshot.contents, target.contents, snapshot.mode ?? 0o600);
      activated.push({ path: target.path, contents: target.contents });
      updated.push(target.path);
    }
    await options.beforeActivate?.(manifestPath, manifestContents);
    await atomicWriteManagedExact(
      manifestPath,
      manifestSnapshot.contents,
      manifestContents,
      manifestSnapshot.mode ?? 0o600,
    );
    activated.push({ path: manifestPath, contents: manifestContents });

    const after = await checkManagedProjectSkills(root);
    if (!after.ok) {
      throw new Error("Managed project skill update did not verify.");
    }
    return { ...after, updated, backupDir };
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const activatedFile of [...activated].reverse()) {
      const snapshot = snapshots.get(activatedFile.path)!;
      try {
        await restoreManagedFile(snapshot, activatedFile.contents);
      } catch (rollbackError) {
        rollbackFailures.push(`${activatedFile.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Managed skill rollback was incomplete: ` +
        `${rollbackFailures.join("; ")}. Recover from ${backupDir}.`,
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Previous managed skill files were restored; ` +
      `the update remains retryable. Backups: ${backupDir}.`,
    );
  }
}

async function readManifest(path: string): Promise<ManagedSkillManifest | undefined> {
  const contents = await readOptional(path);
  if (contents === undefined) return undefined;
  try {
    const parsed = JSON.parse(contents) as Partial<ManagedSkillManifest>;
    if (parsed.schema !== "mono-agent.managed-project-skills.v1" || typeof parsed.version !== "string") {
      return undefined;
    }
    if (typeof parsed.skills !== "object" || parsed.skills === null) return undefined;
    return parsed as ManagedSkillManifest;
  } catch {
    return undefined;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function snapshotManagedFile(path: string): Promise<ManagedFileSnapshot> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
    throw error;
  }
  assertManagedFileInfo(info, path);
  const contents = await readFile(path, "utf8");
  const after = await lstat(path);
  if (!sameManagedFileMetadata(info, after)) {
    throw new Error(`Managed project skill changed while it was being snapshotted: ${path}`);
  }
  return { path, contents, mode: info.mode & 0o777 };
}

async function restoreManagedFile(snapshot: ManagedFileSnapshot, expectedCurrent: string): Promise<void> {
  if (snapshot.contents === undefined) {
    removeManagedFileExactSync(snapshot.path, expectedCurrent);
    return;
  }
  await atomicWriteManagedExact(
    snapshot.path,
    expectedCurrent,
    snapshot.contents,
    snapshot.mode ?? 0o600,
  );
}

async function atomicWriteManagedExact(
  path: string,
  expected: string | undefined,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.mono-agent-tmp`);
  await mkdir(dirname(path), { recursive: true });
  const initialInfo = await managedFileInfo(path, expected);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    await handle.writeFile(contents, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    commitManagedReplacementSync(path, temporary, expected, initialInfo);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function managedFileInfo(path: string, expected: string | undefined): Promise<Stats | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && expected === undefined) return undefined;
    throw error;
  }
  if (expected === undefined) {
    throw new Error(`Refusing to overwrite a concurrently created managed project skill: ${path}`);
  }
  assertManagedFileInfo(info, path);
  if (await readFile(path, "utf8") !== expected) {
    throw new Error(`Refusing to overwrite a concurrently edited managed project skill: ${path}`);
  }
  return info;
}

function commitManagedReplacementSync(
  path: string,
  temporary: string,
  expected: string | undefined,
  initialInfo: Stats | undefined,
): void {
  if (expected === undefined) {
    try {
      lstatSync(path);
      throw new Error(`Refusing to overwrite a concurrently created managed project skill: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(temporary, path);
    return;
  }

  let sourceHandle: number | undefined;
  try {
    sourceHandle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(sourceHandle);
    assertManagedFileInfo(openedBefore, path);
    const current = readFileSync(sourceHandle, "utf8");
    const openedAfter = fstatSync(sourceHandle);
    const named = lstatSync(path);
    if (
      current !== expected
      || initialInfo === undefined
      || !sameManagedFileMetadata(initialInfo, openedBefore)
      || !sameManagedFileMetadata(openedBefore, openedAfter)
      || !sameManagedFileMetadata(openedAfter, named)
    ) {
      throw new Error(`Refusing to overwrite a concurrently edited managed project skill: ${path}`);
    }
    renameSync(temporary, path);
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
  }
}

function removeManagedFileExactSync(path: string, expected: string): void {
  let sourceHandle: number | undefined;
  try {
    sourceHandle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(sourceHandle);
    assertManagedFileInfo(openedBefore, path);
    const current = readFileSync(sourceHandle, "utf8");
    const openedAfter = fstatSync(sourceHandle);
    const named = lstatSync(path);
    if (
      current !== expected
      || !sameManagedFileMetadata(openedBefore, openedAfter)
      || !sameManagedFileMetadata(openedAfter, named)
    ) {
      throw new Error(`Refusing to remove a concurrently edited managed project skill: ${path}`);
    }
    unlinkSync(path);
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
  }
}

function assertManagedFileInfo(info: Stats, path: string): void {
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error(`Managed project skill must be one regular file with one link: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`Managed project skill must be owned by the current user: ${path}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`Managed project skill must not be group/world writable: ${path}`);
  }
}

function sameManagedFileMetadata(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function withManagedProjectSkillLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const skillsDir = join(resolve(cwd), "skills");
  await mkdir(skillsDir, { recursive: true, mode: 0o700 });
  const lockPath = join(skillsDir, ".mono-agent-managed.lock");
  const contents = `${JSON.stringify({
    schema: "mono-agent.managed-project-skills-lock.v1",
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  })}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Another managed project-skill update owns ${lockPath}. Wait for it to finish.`);
      }
      throw error;
    }
    await handle.writeFile(contents, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    const info = await handle.stat();
    assertManagedFileInfo(info, lockPath);
    identity = { dev: info.dev, ino: info.ino };
    await handle.close();
    handle = undefined;
    return await operation();
  } finally {
    await handle?.close();
    if (identity !== undefined) {
      const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (
        current === undefined
        || current.dev !== identity.dev
        || current.ino !== identity.ino
        || await readFile(lockPath, "utf8") !== contents
      ) {
        throw new Error(`Managed project-skill lock changed unexpectedly and was left untouched: ${lockPath}`);
      }
      await rm(lockPath);
    }
  }
}

export async function managedProjectSkillsExist(cwd: string): Promise<boolean> {
  try {
    return (await stat(join(resolve(cwd), PROJECT_SKILL_MANIFEST_PATH))).isFile();
  } catch {
    return false;
  }
}

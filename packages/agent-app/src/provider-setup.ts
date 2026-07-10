import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

export type ProviderSetupKind = "auth" | "preflight";

export interface ProviderSetupCommandAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiLoginAction extends ProviderSetupCommandAction {
  readonly id: `pi-login:${string}`;
  readonly piAuthPath: string;
}

export interface ProviderSetupHttpAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly url: string;
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiApiKeyAction {
  readonly id: string;
  readonly kind: "auth";
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly provider: string;
  readonly envVar: string;
  readonly piAuthPath: string;
  readonly cwd: string;
  readonly detail: string;
}

export type ProviderSetupAction =
  | ProviderSetupPiLoginAction
  | ProviderSetupCommandAction
  | ProviderSetupHttpAction
  | ProviderSetupPiApiKeyAction;

export interface ProviderSetupPlan {
  readonly actions: readonly ProviderSetupAction[];
}

export type ProviderSetupStatus = "ok" | "failed" | "skipped";

export interface ProviderSetupResult {
  readonly action: ProviderSetupAction;
  readonly status: ProviderSetupStatus;
  readonly detail: string;
}

export interface PlanProviderSetupOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly piAuthPath?: string;
  /** Internal test seam for verifying bundled Pi CLI resolution in packed layouts. */
  readonly piCliPath?: string;
}

export interface ExecuteProviderSetupOptions {
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Bounded only for non-interactive local-provider preflight probes. */
  readonly preflightTimeoutMs?: number;
  /** Test seam; automatic credential persistence fails closed on Windows. */
  readonly platform?: NodeJS.Platform;
  /** Test seam immediately before the target pathname is claimed. */
  readonly beforePiAuthPromotion?: (targetPath: string, stagedPath: string) => void | Promise<void>;
  /** Test seam after exclusive link installation and before immutable-byte verification. */
  readonly afterPiAuthLink?: (targetPath: string, stagedPath: string) => void | Promise<void>;
}

type PiAuthPromotionHooks = Pick<
  ExecuteProviderSetupOptions,
  "beforePiAuthPromotion" | "afterPiAuthLink"
>;

const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const PI_OAUTH_LOGIN_PROVIDERS = new Set(["anthropic", "github-copilot", "openai-codex"]);
const PI_API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};
const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const PI_AI_CLI_PARTS = ["@earendil-works", "pi-ai", "dist", "cli.js"] as const;
const PI_AI_NODE_MODULE_PATHS = createRequire(import.meta.url).resolve.paths(PI_AI_PACKAGE) ?? [];
const DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS = 5_000;

export function resolvePiCliPath(nodeModulePaths: readonly string[] = PI_AI_NODE_MODULE_PATHS): string {
  for (const nodeModulesPath of nodeModulePaths) {
    const cliPath = join(nodeModulesPath, ...PI_AI_CLI_PARTS);
    if (existsSync(cliPath)) {
      return cliPath;
    }
  }
  throw new Error(`Cannot find the bundled Pi CLI for ${PI_AI_PACKAGE}. Reinstall @mono-agent/agent-app.`);
}

export function piLoginCommand(provider: string, piCliPath = resolvePiCliPath()): readonly [string, ...string[]] {
  return [process.execPath, piCliPath, "login", provider];
}

export function piLoginCommandLine(provider: string): string {
  return piAuthRecoveryCommand(provider);
}

export function piAuthRecoveryCommand(provider: string, piAuthPath?: string): string {
  return piAuthPath === undefined
    ? `mono-agent auth login ${shellQuote(provider)}`
    : `mono-agent auth login ${shellQuote(provider)} --pi-auth-path ${shellQuote(piAuthPath)}`;
}

export function piAuthWorkingDirectory(piAuthPath: string | undefined, cwd = process.cwd()): string {
  return dirname(piAuthPathForSetup(piAuthPath, cwd));
}

export function piAuthPathForSetup(piAuthPath: string | undefined, cwd = process.cwd()): string {
  if (piAuthPath === undefined || piAuthPath.trim().length === 0) {
    return DEFAULT_PI_AUTH_PATH;
  }
  const normalized = piAuthPath.trim();
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return resolve(homedir(), normalized.slice(2));
  }
  return resolve(cwd, normalized);
}

export function planProviderSetup(options: PlanProviderSetupOptions): ProviderSetupPlan {
  const piAuthPath = options.piAuthPath ?? DEFAULT_PI_AUTH_PATH;
  const actionsById = new Map<string, ProviderSetupAction>();

  for (const raw of options.modelRefs) {
    let ref;
    try {
      ref = parseMonoRuntimeModelReference(raw);
    } catch {
      continue;
    }

    const refKey = modelReferenceKey(ref);
    const add = (action: ProviderSetupAction) => {
      const existing = actionsById.get(action.id);
      if (existing === undefined) {
        actionsById.set(action.id, action);
        return;
      }
      actionsById.set(action.id, {
        ...existing,
        modelRefs: [...new Set([...existing.modelRefs, ...action.modelRefs])],
      } as ProviderSetupAction);
    };

    if (ref.sdk === "claude") {
      add({
        id: "claude-login",
        kind: "auth",
        label: "Claude login",
        modelRefs: [refKey],
        command: ["claude", "/login"],
        cwd: options.cwd,
        detail: "Runs the Claude Code login flow for Claude model references.",
      });
      continue;
    }

    if (ref.sdk === "codex") {
      add({
        id: "codex-login",
        kind: "auth",
        label: "Codex login",
        modelRefs: [refKey],
        command: ["codex", "login"],
        cwd: options.cwd,
        detail: "Runs the Codex login flow for direct Codex model references.",
      });
      continue;
    }

    if (ref.sdk !== "pi" || typeof ref.provider !== "string") {
      continue;
    }

    if (ref.provider === "ollama") {
      add({
        id: "ollama-list",
        kind: "preflight",
        label: "Ollama model preflight",
        modelRefs: [refKey],
        command: ["ollama", "list"],
        cwd: options.cwd,
        detail: "Checks that the local Ollama server and CLI can list installed models.",
      });
      continue;
    }

    if (ref.provider === "lmstudio") {
      add({
        id: "lmstudio-models",
        kind: "preflight",
        label: "LM Studio model preflight",
        modelRefs: [refKey],
        url: "http://localhost:1234/v1/models",
        cwd: options.cwd,
        detail: "Checks that LM Studio's OpenAI-compatible local server exposes models.",
      });
      continue;
    }

    if (ref.provider === "opencode-go") {
      add({
        id: "pi-api-key:opencode-go",
        kind: "auth",
        label: "OpenCode-Go API key",
        modelRefs: [refKey],
        provider: ref.provider,
        envVar: PI_API_KEY_PROVIDERS[ref.provider] ?? "OPENCODE_API_KEY",
        piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
        cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
        detail: "Stores the OpenCode-Go API key in the Pi auth store used by providers.piAuthPath.",
      });
      continue;
    }

    if (!PI_OAUTH_LOGIN_PROVIDERS.has(ref.provider)) {
      continue;
    }

    add({
      id: `pi-login:${ref.provider}`,
      kind: "auth",
      label: `Pi login for ${ref.provider}`,
      modelRefs: [refKey],
      command: piLoginCommand(ref.provider, options.piCliPath),
      piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
      cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
      detail: `Runs bundled Pi auth for provider \`${ref.provider}\` and securely replaces providers.piAuthPath.`,
    });
  }

  return { actions: [...actionsById.values()] };
}

export function providerSetupActionCommandLine(action: ProviderSetupAction): string {
  if ("command" in action) {
    if (isProviderSetupPiLoginAction(action)) {
      return piAuthRecoveryCommand(action.id.slice("pi-login:".length), action.piAuthPath);
    }
    return action.command.map(shellQuote).join(" ");
  }
  if (isProviderSetupPiApiKeyAction(action)) {
    return `${action.envVar} -> ${action.piAuthPath}`;
  }
  return `GET ${action.url}`;
}

export function isProviderSetupPiApiKeyAction(action: ProviderSetupAction): action is ProviderSetupPiApiKeyAction {
  return "provider" in action && "piAuthPath" in action && "envVar" in action;
}

export function isProviderSetupPiLoginAction(action: ProviderSetupAction): action is ProviderSetupPiLoginAction {
  return action.id.startsWith("pi-login:") && "piAuthPath" in action && "command" in action;
}

export async function executeProviderSetupPlan(
  plan: ProviderSetupPlan,
  options: ExecuteProviderSetupOptions = {},
): Promise<ProviderSetupResult[]> {
  const preflightTimeoutMs = positivePreflightTimeout(options.preflightTimeoutMs);
  const results: ProviderSetupResult[] = [];
  for (const action of plan.actions) {
    const result = isProviderSetupPiApiKeyAction(action)
      ? await runPiApiKeyAction(action, options.apiKeys ?? {}, options.platform ?? process.platform, options)
      : "command" in action
      ? await runCommandAction(action, options.spawn ?? spawn, options.platform ?? process.platform, options, preflightTimeoutMs)
      : await runHttpAction(action, options.fetch ?? fetch, preflightTimeoutMs);
    results.push(result);
    if (result.status === "failed") {
      break;
    }
  }
  return results;
}

async function runPiApiKeyAction(
  action: ProviderSetupPiApiKeyAction,
  apiKeys: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
): Promise<ProviderSetupResult> {
  const raw = apiKeys[action.id] ?? apiKeys[action.provider] ?? process.env[action.envVar];
  const key = raw?.trim();
  if (key === undefined || key.length === 0) {
    return {
      action,
      status: "skipped",
      detail: `${action.envVar} was not provided; skipped saving credentials for ${action.provider}.`,
    };
  }

  try {
    assertOwnerOnlyPersistenceSupported(platform);
    await withPiAuthFileLock(action.piAuthPath, async (authPath, ownerUid, assertLockHeld) => {
      const original = await readPiAuthStore(authPath, piAuthSingleLinkPolicy(ownerUid));
      const next = {
        ...original.auth,
        [action.provider]: { type: "api_key", key },
      };
      await writePiAuthStoreAtomically(authPath, next, original, ownerUid, assertLockHeld, hooks);
    });
    return {
      action,
      status: "ok",
      detail: `Saved API key credentials for ${action.provider} to the Pi auth store.`,
    };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCommandAction(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
  preflightTimeoutMs: number,
): Promise<ProviderSetupResult> {
  if (isProviderSetupPiLoginAction(action)) {
    return await runPiLoginAction(action, spawnImpl, platform, hooks);
  }
  const [file, ...args] = action.command;
  return await runSpawnedCommand(action, spawnImpl, action.cwd, preflightTimeoutMs);
}

async function runPiLoginAction(
  action: ProviderSetupPiLoginAction,
  spawnImpl: typeof spawn,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
): Promise<ProviderSetupResult> {
  try {
    assertOwnerOnlyPersistenceSupported(platform);
    return await withPiAuthFileLock(action.piAuthPath, async (authPath, ownerUid, assertLockHeld) => {
      let stagingDir: string | undefined;
      try {
        const original = await readPiAuthStore(authPath, piAuthSingleLinkPolicy(ownerUid));
        stagingDir = await mkdtemp(join(dirname(authPath), ".mono-agent-pi-auth-"));
        const stagedAuthPath = join(stagingDir, "auth.json");
        if (original.exists) {
          await writeFile(stagedAuthPath, original.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
        const result = await runSpawnedCommand(action, spawnImpl, stagingDir);
        if (result.status !== "ok") {
          return result;
        }

        const staged = await readPiAuthStore(stagedAuthPath, piAuthSingleLinkPolicy(ownerUid));
        if (!staged.exists) {
          throw new Error("Bundled Pi login exited successfully without producing auth.json; the configured store was not changed.");
        }
        const provider = action.id.slice("pi-login:".length);
        assertOAuthCredential(staged.auth[provider], provider);
        assertUnchangedSiblingCredentials(original.auth, staged.auth, provider);
        await assertPiAuthStoreUnchanged(authPath, original, ownerUid);
        await chmod(stagedAuthPath, 0o600);
        await syncFile(stagedAuthPath);
        const hardenedStaged = await readPiAuthStore(stagedAuthPath, piAuthSingleLinkPolicy(ownerUid));
        if (
          !hardenedStaged.exists ||
          hardenedStaged.dev !== staged.dev ||
          hardenedStaged.ino !== staged.ino ||
          hardenedStaged.contents !== staged.contents ||
          ((hardenedStaged.mode ?? 0) & 0o777) !== 0o600
        ) {
          throw new Error("Bundled Pi login output changed while owner-only permissions were applied; the configured store was not changed.");
        }
        await promotePiAuthStoreWithoutClobber(
          stagedAuthPath,
          authPath,
          original,
          ownerUid,
          assertLockHeld,
          hardenedStaged,
          hooks,
        );
        await syncDirectory(dirname(authPath));
        return {
          action,
          status: "ok",
          detail: `${providerSetupActionCommandLine(action)} saved credentials to ${action.piAuthPath}.`,
        };
      } finally {
        if (stagingDir !== undefined) {
          await rm(stagingDir, { recursive: true, force: true });
        }
      }
    });
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

interface PiAuthStoreSnapshot {
  readonly exists: boolean;
  readonly contents: string;
  readonly auth: Readonly<Record<string, unknown>>;
  readonly dev?: number;
  readonly ino?: number;
  readonly uid?: number;
  readonly nlink?: number;
  readonly mode?: number;
  readonly size?: number;
}

interface PiAuthStoreReadPolicy {
  readonly ownerUid: number;
  readonly allowedLinkCounts: readonly number[];
}

interface PiAuthLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly ownerUid: number;
  readonly dev: number;
  readonly ino: number;
  readonly token: string;
  readonly contents: Buffer;
}

type AssertPiAuthLockHeld = () => Promise<void>;

function assertOwnerOnlyPersistenceSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "Automatic Pi credential persistence is unavailable because owner-only file permissions cannot be verified on Windows. Complete authentication manually and rerun validation.",
    );
  }
}

async function withPiAuthFileLock<T>(
  authPath: string,
  task: (
    canonicalAuthPath: string,
    ownerUid: number,
    assertLockHeld: AssertPiAuthLockHeld,
  ) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(dirname(authPath));
  const ownerUid = currentProcessUidForPi(canonicalParent);
  await assertSafePiAuthParent(canonicalParent, ownerUid);
  const canonicalAuthPath = join(canonicalParent, basename(authPath));
  await assertPiAuthPathOutsideGitWorktree(canonicalAuthPath);
  const lockPath = `${canonicalAuthPath}.mono-agent.lock`;
  const token = randomUUID();
  const contents = Buffer.from(`${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerUid,
    token,
  })}\n`, "utf8");
  let handle: FileHandle | undefined;
  let identity: Pick<PiAuthLock, "dev" | "ino" | "ownerUid"> | undefined;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const initialStat = await handle.stat();
    assertPiAuthLockStat(lockPath, initialStat, ownerUid);
    identity = { dev: initialStat.dev, ino: initialStat.ino, ownerUid };
    await handle.writeFile(contents);
    await handle.sync();
    const writtenStat = await handle.stat();
    assertPiAuthLockStat(lockPath, writtenStat, ownerUid);
    if (
      writtenStat.dev !== initialStat.dev ||
      writtenStat.ino !== initialStat.ino ||
      writtenStat.size !== contents.length
    ) {
      throw new Error(`Pi credential lock ${lockPath} changed while its owner record was written.`);
    }
    await syncDirectory(canonicalParent);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      if (identity !== undefined) {
        await removePiAuthLockIfIdentity(lockPath, identity).catch(() => undefined);
      }
    }
    if (isAlreadyExistsError(error)) {
      throw new Error(
        `Pi credential lock ${lockPath} already exists. If no mono-agent authentication is running, remove the stale lock manually and retry.`,
      );
    }
    throw error;
  }
  if (handle === undefined || identity === undefined) {
    throw new Error(`Pi credential lock ${lockPath} could not be established.`);
  }
  const lock: PiAuthLock = {
    path: lockPath,
    handle,
    ownerUid,
    dev: identity.dev,
    ino: identity.ino,
    token,
    contents,
  };
  try {
    return await task(canonicalAuthPath, ownerUid, () => assertPiAuthLockHeld(lock));
  } finally {
    try {
      await lock.handle.close();
    } finally {
      await releasePiAuthLock(lock);
    }
  }
}

function currentProcessUidForPi(path: string): number {
  if (typeof process.getuid !== "function") {
    throw new Error(`Automatic Pi credential persistence cannot verify the current user for ${path}.`);
  }
  return process.getuid();
}

async function assertSafePiAuthParent(path: string, ownerUid: number): Promise<void> {
  const pathStat = await lstat(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const handleStat = await handle.stat();
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !handleStat.isDirectory() ||
      pathStat.dev !== handleStat.dev ||
      pathStat.ino !== handleStat.ino ||
      handleStat.uid !== ownerUid ||
      (handleStat.mode & 0o022) !== 0
    ) {
      throw new Error(
        `Refusing automatic Pi credential persistence because parent directory ${path} must be owned by the current user and not group/world-writable.`,
      );
    }
  } finally {
    await handle?.close();
  }
}

function assertPiAuthLockStat(path: string, value: Stats, ownerUid: number): void {
  if (
    !value.isFile() ||
    value.uid !== ownerUid ||
    (value.mode & 0o777) !== 0o600 ||
    value.nlink !== 1
  ) {
    throw new Error(
      `Refusing to use Pi credential lock ${path} because it is not a current-user, owner-only regular file with one link.`,
    );
  }
}

async function readPiAuthLockPath(
  path: string,
  ownerUid: number,
): Promise<{ readonly dev: number; readonly ino: number; readonly contents: Buffer } | undefined> {
  let pathStat: Stats;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  assertPiAuthLockStat(path, pathStat, ownerUid);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const handleStat = await handle.stat();
    assertPiAuthLockStat(path, handleStat, ownerUid);
    if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) return undefined;
    const contents = await handle.readFile();
    if (contents.length !== handleStat.size || contents.length > 4096) return undefined;
    return { dev: handleStat.dev, ino: handleStat.ino, contents };
  } finally {
    await handle?.close();
  }
}

async function assertPiAuthLockHeld(lock: PiAuthLock): Promise<void> {
  const handleStat = await lock.handle.stat();
  assertPiAuthLockStat(lock.path, handleStat, lock.ownerUid);
  const current = await readPiAuthLockPath(lock.path, lock.ownerUid);
  if (
    current === undefined ||
    handleStat.dev !== lock.dev ||
    handleStat.ino !== lock.ino ||
    current.dev !== lock.dev ||
    current.ino !== lock.ino ||
    !current.contents.equals(lock.contents)
  ) {
    throw new Error(
      `Pi credential lock ${lock.path} changed during credential setup; its replacement was left untouched.`,
    );
  }
}

async function releasePiAuthLock(lock: PiAuthLock): Promise<void> {
  let current;
  try {
    current = await readPiAuthLockPath(lock.path, lock.ownerUid);
  } catch {
    return;
  }
  if (
    current === undefined ||
    current.dev !== lock.dev ||
    current.ino !== lock.ino ||
    !current.contents.equals(lock.contents)
  ) {
    return;
  }
  try {
    await rm(lock.path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await syncDirectory(dirname(lock.path));
}

async function removePiAuthLockIfIdentity(
  path: string,
  expected: Pick<PiAuthLock, "dev" | "ino" | "ownerUid">,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  if (
    !current.isFile() ||
    current.uid !== expected.ownerUid ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600
  ) {
    return;
  }
  await rm(path);
  await syncDirectory(dirname(path));
}

async function readPiAuthStore(
  path: string,
  policy: PiAuthStoreReadPolicy,
): Promise<PiAuthStoreSnapshot> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, contents: "", auth: {} };
    }
    if (isSymlinkOpenError(error)) {
      throw new Error(`Refusing to use Pi auth path ${path} because the final path is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    assertPiAuthStoreStat(path, fileStat, policy);
    const contents = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Unable to parse Pi auth file ${path}; the original file was left unchanged.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Pi auth file ${path} must contain a JSON object; the original file was left unchanged.`);
    }
    const pathStat = await lstat(path);
    assertPiAuthStoreStat(path, pathStat, policy);
    if (pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino) {
      throw new Error(`Pi auth file ${path} changed while it was being read; the newer path was preserved.`);
    }
    return {
      exists: true,
      contents,
      auth: parsed as Record<string, unknown>,
      dev: fileStat.dev,
      ino: fileStat.ino,
      uid: fileStat.uid,
      nlink: fileStat.nlink,
      mode: fileStat.mode,
      size: fileStat.size,
    };
  } finally {
    await handle.close();
  }
}

function assertPiAuthStoreStat(
  path: string,
  value: Stats,
  policy: PiAuthStoreReadPolicy,
): void {
  if (!value.isFile()) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is not a regular file.`);
  }
  if (value.uid !== policy.ownerUid) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is not owned by the current user.`);
  }
  if ((value.mode & 0o022) !== 0) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is writable by another user.`);
  }
  if (!policy.allowedLinkCounts.includes(value.nlink)) {
    throw new Error(`Refusing to use Pi auth path ${path} because its hard-link identity is unsafe.`);
  }
}

async function writePiAuthStoreAtomically(
  path: string,
  auth: Readonly<Record<string, unknown>>,
  original: PiAuthStoreSnapshot,
  ownerUid: number,
  assertLockHeld: AssertPiAuthLockHeld,
  hooks: PiAuthPromotionHooks,
): Promise<void> {
  await assertPiAuthStoreUnchanged(path, original, ownerUid);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(dir, ".mono-agent-pi-auth-write-"));
  const tempPath = join(tempDir, "auth.json");
  try {
    await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await syncFile(tempPath);
    await assertPiAuthStoreUnchanged(path, original, ownerUid);
    await promotePiAuthStoreWithoutClobber(
      tempPath,
      path,
      original,
      ownerUid,
      assertLockHeld,
      undefined,
      hooks,
    );
    await syncDirectory(dir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function assertPiAuthStoreUnchanged(
  path: string,
  original: PiAuthStoreSnapshot,
  ownerUid: number,
): Promise<void> {
  const current = await readPiAuthStore(path, piAuthSingleLinkPolicy(ownerUid));
  if (!samePiAuthStoreSnapshot(current, original)) {
    throw new Error(`Pi auth file ${path} changed during credential setup; the newer file was preserved.`);
  }
}

function samePiAuthStoreSnapshot(left: PiAuthStoreSnapshot, right: PiAuthStoreSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.contents === right.contents;
}

async function promotePiAuthStoreWithoutClobber(
  stagedPath: string,
  targetPath: string,
  expected: PiAuthStoreSnapshot,
  ownerUid: number,
  assertLockHeld: AssertPiAuthLockHeld,
  intendedInput?: PiAuthStoreSnapshot,
  hooks: PiAuthPromotionHooks = {},
): Promise<void> {
  const intended = intendedInput ?? await readPiAuthStore(stagedPath, piAuthSingleLinkPolicy(ownerUid));
  if (!intended.exists) {
    throw new Error(`Pi auth staging file ${stagedPath} disappeared before promotion.`);
  }
  if (!expected.exists) {
    await hooks.beforePiAuthPromotion?.(targetPath, stagedPath);
    await assertLockHeld();
    if (!await linkPiFileIfAbsent(stagedPath, targetPath)) {
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    await hooks.afterPiAuthLink?.(targetPath, stagedPath);
    await assertPromotedPiAuthStore(intended, stagedPath, targetPath, ownerUid);
    return;
  }

  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.mono-agent-${randomUUID()}.backup`);
  let preserveConcurrentBackup = true;
  try {
    await hooks.beforePiAuthPromotion?.(targetPath, stagedPath);
    await assertLockHeld();
    try {
      await rename(targetPath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
      }
      throw error;
    }

    let moved: PiAuthStoreSnapshot;
    try {
      moved = await readPiAuthStore(backupPath, piAuthSingleLinkPolicy(ownerUid));
    } catch {
      if (await linkPiFileIfAbsent(backupPath, targetPath)) {
        await rm(backupPath, { force: true });
        preserveConcurrentBackup = false;
      } else {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      }
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    if (!samePiAuthStoreSnapshotAfterMove(moved, expected)) {
      if (await linkPiFileIfAbsent(backupPath, targetPath)) {
        await rm(backupPath, { force: true });
        preserveConcurrentBackup = false;
      } else {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      }
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }

    if (!await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid)) {
      try {
        if (await linkPiFileIfAbsent(backupPath, targetPath)) {
          preserveConcurrentBackup = false;
        } else {
          await tightenPiFileOwnerOnlyBestEffort(backupPath);
        }
      } catch {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
        throw new Error(`Pi auth promotion failed; credentials were retained at ${backupPath}.`);
      }
      throw new Error(preserveConcurrentBackup
        ? `Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`
        : `Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }

    let installed: boolean;
    try {
      installed = await linkPiFileIfAbsent(stagedPath, targetPath);
    } catch {
      await tightenPiFileOwnerOnlyBestEffort(backupPath);
      throw new Error(`Pi auth promotion failed; the original credentials were retained at ${backupPath}.`);
    }
    if (!installed) {
      preserveConcurrentBackup = false;
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    try {
      await hooks.afterPiAuthLink?.(targetPath, stagedPath);
      await assertPromotedPiAuthStore(intended, stagedPath, targetPath, ownerUid);
    } catch {
      const backupStillExpected = await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid);
      try {
        const restored = await linkPiFileIfAbsent(backupPath, targetPath);
        if (restored || backupStillExpected) {
          preserveConcurrentBackup = false;
        } else {
          await tightenPiFileOwnerOnlyBestEffort(backupPath);
        }
      } catch {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
        throw new Error(`Pi auth promotion failed; credentials were retained at ${backupPath}.`);
      }
      throw new Error(preserveConcurrentBackup
        ? `Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`
        : `Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    if (!await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid)) {
      await tightenPiFileOwnerOnlyBestEffort(backupPath);
      throw new Error(`Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`);
    }
    preserveConcurrentBackup = false;
  } finally {
    if (!preserveConcurrentBackup) await rm(backupPath, { force: true });
    else await tightenPiFileOwnerOnlyBestEffort(backupPath);
  }
}

async function claimedPiAuthBackupStillMatches(
  backupPath: string,
  expected: PiAuthStoreSnapshot,
  ownerUid: number,
): Promise<boolean> {
  try {
    const current = await readPiAuthStore(backupPath, piAuthSingleLinkPolicy(ownerUid));
    return samePiAuthStoreSnapshotAfterMove(current, expected);
  } catch {
    return false;
  }
}

function samePiAuthStoreSnapshotAfterMove(
  current: PiAuthStoreSnapshot,
  expected: PiAuthStoreSnapshot,
): boolean {
  return current.exists && expected.exists &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.uid === expected.uid &&
    current.nlink === expected.nlink &&
    current.mode === expected.mode &&
    current.size === expected.size &&
    current.contents === expected.contents;
}

async function linkPiFileIfAbsent(source: string, target: string): Promise<boolean> {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function assertPromotedPiAuthStore(
  intended: PiAuthStoreSnapshot,
  stagedPath: string,
  targetPath: string,
  ownerUid: number,
): Promise<void> {
  // Exclusive-link installation deliberately gives the same inode two names
  // until the private staging directory is removed. Exactly two links prove
  // that no third alias can retain or mutate credential bytes after cleanup.
  const twoLinkPolicy: PiAuthStoreReadPolicy = { ownerUid, allowedLinkCounts: [2] };
  const staged = await readPiAuthStore(stagedPath, twoLinkPolicy);
  const promoted = await readPiAuthStore(targetPath, twoLinkPolicy);
  if (
    !intended.exists ||
    !staged.exists ||
    !promoted.exists ||
    intended.uid !== ownerUid ||
    intended.nlink !== 1 ||
    staged.dev !== intended.dev ||
    staged.ino !== intended.ino ||
    promoted.dev !== intended.dev ||
    promoted.ino !== intended.ino ||
    staged.contents !== intended.contents ||
    intended.contents !== promoted.contents ||
    ((promoted.mode ?? 0) & 0o777) !== 0o600
  ) {
    throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
  }
}

function piAuthSingleLinkPolicy(ownerUid: number): PiAuthStoreReadPolicy {
  return { ownerUid, allowedLinkCounts: [1] };
}

async function tightenPiFileOwnerOnlyBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if ((await handle.stat()).isFile()) await handle.chmod(0o600);
  } catch {
    // Preserve recovery bytes even if their metadata cannot be tightened.
  } finally {
    await handle?.close();
  }
}

async function assertPiAuthPathOutsideGitWorktree(path: string): Promise<void> {
  const result = await runGitForPi(["-C", dirname(path), "rev-parse", "--show-toplevel"]);
  if (result.ok) {
    throw new Error(
      `Refusing automatic Pi credential persistence inside Git worktree ${result.stdout.trim()}. Choose providers.piAuthPath outside the repository.`,
    );
  }
  if (await hasGitMetadataForPi(dirname(path))) {
    throw new Error(`Cannot prove Git safety for Pi auth path ${path}; choose a credential path outside the repository.`);
  }
}

function runGitForPi(args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { encoding: "utf8" }, (error, stdout) => {
      resolveResult({ ok: error === null, stdout });
    });
  });
}

async function hasGitMetadataForPi(start: string): Promise<boolean> {
  let current = resolve(start);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertOAuthCredential(value: unknown, provider: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Bundled Pi login did not produce credentials for ${provider}; the configured store was not changed.`);
  }
  const credential = value as Record<string, unknown>;
  const access = typeof credential.access === "string" ? credential.access.trim() : "";
  const refresh = typeof credential.refresh === "string" ? credential.refresh.trim() : "";
  if (credential.type !== "oauth" || (access.length === 0 && refresh.length === 0)) {
    throw new Error(`Bundled Pi login produced invalid OAuth credentials for ${provider}; the configured store was not changed.`);
  }
}

function assertUnchangedSiblingCredentials(
  original: Readonly<Record<string, unknown>>,
  staged: Readonly<Record<string, unknown>>,
  provider: string,
): void {
  for (const [name, credential] of Object.entries(original)) {
    if (name !== provider && !isDeepStrictEqual(staged[name], credential)) {
      throw new Error(`Bundled Pi login unexpectedly changed sibling provider ${name}; the configured store was not changed.`);
    }
  }
  for (const name of Object.keys(staged)) {
    if (name !== provider && !Object.hasOwn(original, name)) {
      throw new Error(`Bundled Pi login unexpectedly added sibling provider ${name}; the configured store was not changed.`);
    }
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymlinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runSpawnedCommand(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  cwd: string,
  preflightTimeoutMs = DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS,
): Promise<ProviderSetupResult> {
  const [file, ...args] = action.command;
  return new Promise((resolve) => {
    const child = spawnImpl(file, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ProviderSetupResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    child.once("error", (error) => {
      finish({ action, status: "failed", detail: error.message });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ action, status: "ok", detail: `${providerSetupActionCommandLine(action)} exited 0.` });
        return;
      }
      finish({
        action,
        status: "failed",
        detail: signal === null
          ? `${providerSetupActionCommandLine(action)} exited ${code ?? "unknown"}.`
          : `${providerSetupActionCommandLine(action)} terminated by ${signal}.`,
      });
    });
    if (action.kind === "preflight") {
      timer = setTimeout(() => {
        const detail = `${providerSetupActionCommandLine(action)} timed out after ${preflightTimeoutMs}ms.`;
        finish({ action, status: "failed", detail });
        try { child.kill("SIGKILL"); } catch { /* timeout result remains authoritative */ }
      }, preflightTimeoutMs);
      timer.unref?.();
    }
  });
}

async function runHttpAction(
  action: Extract<ProviderSetupAction, { readonly url: string }>,
  fetchImpl: typeof fetch,
  preflightTimeoutMs: number,
): Promise<ProviderSetupResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const request = Promise.resolve(fetchImpl(action.url, { signal: controller.signal }));
    // An injected/custom fetch may ignore AbortSignal, so the race itself is the
    // bounded contract. Observe the original promise to avoid late rejections.
    void request.catch(() => undefined);
    const timedOut = Symbol("provider-preflight-timeout");
    const response = action.kind === "preflight"
      ? await Promise.race([
          request,
          new Promise<typeof timedOut>((resolveTimeout) => {
            timer = setTimeout(() => {
              resolveTimeout(timedOut);
              controller.abort();
            }, preflightTimeoutMs);
            timer.unref?.();
          }),
        ])
      : await request;
    if (response === timedOut) {
      return {
        action,
        status: "failed",
        detail: `GET ${action.url} timed out after ${preflightTimeoutMs}ms.`,
      };
    }
    if (response.ok) {
      return { action, status: "ok", detail: `GET ${action.url} returned ${response.status}.` };
    }
    return { action, status: "failed", detail: `GET ${action.url} returned ${response.status}.` };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positivePreflightTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS;
}

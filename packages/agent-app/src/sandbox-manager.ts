import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CodedError } from "@mono-agent/agent-contracts";
import {
  createSandboxPolicy,
  createSrtSandboxEngine,
  MANAGED_SRT_TREE_SHA256,
  type PreparedSandboxCommand,
  type SandboxEngine,
  type SandboxPolicy,
} from "@mono-agent/runtime-adapter";

const execFileAsync = promisify(execFile);

export const MANAGED_SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const MANAGED_SRT_VERSION = "0.0.64";
export const MANAGED_SRT_LOCK_SHA256 = "0f34561ddc700ad43c31f254beb0e1e4b87bae61795acac5d7fa890dd5890924";
export const MANAGED_SRT_MARKER = ".mono-agent-srt.json";

const MANAGED_SRT_RESOURCE_ROOT = fileURLToPath(new URL("../resources/srt", import.meta.url));
const INSTALL_LOCK_NAME = ".install.lock";
const INSTALL_LOCK_WAIT_MS = 150_000;

export type SandboxManagerErrorCode =
  | "managed_srt_unsupported"
  | "managed_srt_corrupt"
  | "managed_srt_install_failed"
  | "managed_srt_lock_unsafe"
  | "sandbox_check_failed";

export class SandboxManagerError extends CodedError<SandboxManagerErrorCode> {}

export interface ManagedSrtMarker {
  readonly schemaVersion: 2;
  readonly package: typeof MANAGED_SRT_PACKAGE;
  readonly version: typeof MANAGED_SRT_VERSION;
  readonly lockSha256: typeof MANAGED_SRT_LOCK_SHA256;
  readonly cliSha256: string;
  readonly packageJsonSha256: string;
  readonly treeSha256: string;
}

export interface SandboxRuntimeStatus {
  readonly state: "ready" | "absent" | "corrupt" | "unsupported";
  readonly source: "managed" | "external" | "none";
  readonly version: typeof MANAGED_SRT_VERSION;
  readonly installRoot: string;
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly message: string;
}

export interface SandboxFunctionalCheck {
  readonly id:
    | "engine"
    | "allowed-filesystem"
    | "sibling-read-denied"
    | "env-write-denied"
    | "outside-write-denied"
    | "localhost-allowed"
    | "domain-denied";
  readonly ok: boolean;
  readonly detail: string;
}

export interface SandboxCheckResult {
  readonly status: SandboxRuntimeStatus;
  readonly checks: readonly SandboxFunctionalCheck[];
}

export interface ManagedSrtSetupResult {
  readonly installed: boolean;
  readonly repaired: boolean;
  readonly status: SandboxRuntimeStatus;
  readonly check?: SandboxCheckResult;
}

export interface ManagedSrtHooks {
  readonly installDependencies?: (stagingRoot: string, signal: AbortSignal | undefined) => Promise<void>;
  readonly processIsAlive?: (pid: number) => "alive" | "dead" | "unknown";
  readonly sleep?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Test-only fixture seam; production always uses the independently pinned tree digest. */
  readonly expectedTreeSha256?: (installRoot: string) => Promise<string>;
}

export interface SandboxManagerOptions {
  readonly cacheRoot?: string;
  readonly resourceRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nodePath?: string;
  readonly npmCliPath?: string;
  readonly externalCommand?: string | false;
  readonly signal?: AbortSignal;
  readonly installTimeoutMs?: number;
  readonly hooks?: ManagedSrtHooks;
}

export interface ManagedSrtSetupOptions extends SandboxManagerOptions {
  readonly verify?: boolean;
}

interface InstallLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly uid: number | null;
  readonly token: string;
  readonly startedAt: string;
}

interface HeldInstallLock {
  readonly path: string;
  readonly token: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export function managedSrtInstallRoot(options: SandboxManagerOptions = {}): string {
  return resolve(
    managedSrtVersionRoot(options),
    MANAGED_SRT_LOCK_SHA256,
  );
}

export async function sandboxRuntimeStatus(options: SandboxManagerOptions = {}): Promise<SandboxRuntimeStatus> {
  const installRoot = managedSrtInstallRoot(options);
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" && await pathExists(installRoot)) {
    try {
      await assertTrustedNodeExecutable(resolveNodePath(options));
      const cliPath = await verifyManagedInstall(installRoot, options);
      return {
        state: "ready",
        source: "managed",
        version: MANAGED_SRT_VERSION,
        installRoot,
        nodePath: resolveNodePath(options),
        cliPath,
        message: `Managed SRT ${MANAGED_SRT_VERSION} is installed and integrity-verified.`,
      };
    } catch (error) {
      return {
        state: "corrupt",
        source: "managed",
        version: MANAGED_SRT_VERSION,
        installRoot,
        message: errorMessage(error),
      };
    }
  }

  const externalCommand = options.externalCommand === undefined ? "srt" : options.externalCommand;
  if (externalCommand !== false) {
    const available = await createSrtSandboxEngine({ command: externalCommand }).isAvailable();
    if (available) {
      return {
        state: "ready",
        source: "external",
        version: MANAGED_SRT_VERSION,
        installRoot,
        message: `External SRT at ${externalCommand} passed a functional enforcement proof.`,
      };
    }
  }

  return platform === "darwin"
    ? {
      state: "absent",
      source: "none",
      version: MANAGED_SRT_VERSION,
      installRoot,
      message: "SRT is not installed. Run `mono-agent sandbox setup` to install the pinned user-cache copy.",
    }
    : {
      state: "unsupported",
      source: "none",
      version: MANAGED_SRT_VERSION,
      installRoot,
      message: `Managed SRT setup is currently supported on macOS only (${platform} detected). Install SRT and its platform prerequisites yourself, then rerun the check.`,
    };
}

export async function setupManagedSrt(options: ManagedSrtSetupOptions = {}): Promise<ManagedSrtSetupResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new SandboxManagerError(
      "managed_srt_unsupported",
      `Managed SRT setup is supported on macOS only (${platform} detected). No system packages were changed.`,
      { platform },
    );
  }
  throwIfAborted(options.signal);
  try {
    assertSupportedNodeVersion(process.versions.node);
    await assertTrustedNodeExecutable(resolveNodePath(options));
    await verifyInstallResources(options.resourceRoot ?? MANAGED_SRT_RESOURCE_ROOT);
    await ensurePrivateVersionRoot(options);
  } catch (error) {
    if (error instanceof SandboxManagerError) {
      throw error;
    }
    throw new SandboxManagerError(
      "managed_srt_corrupt",
      `Managed SRT cache or install resources are unsafe: ${errorMessage(error)}`,
      { cause: errorMessage(error) },
    );
  }

  const installRoot = managedSrtInstallRoot(options);
  let initial = await inspectManagedOnly(options);
  if (initial.state === "ready") {
    const check = options.verify === false ? undefined : await checkSandboxRuntime(options);
    return { installed: false, repaired: false, status: initial, ...(check === undefined ? {} : { check }) };
  }

  const heldLock = await acquireInstallLock(options);
  let stagingRoot: string | undefined;
  let repaired = false;
  try {
    throwIfAborted(options.signal);
    await cleanupStaleStaging(managedSrtVersionRoot(options));
    initial = await inspectManagedOnly(options);
    if (initial.state === "ready") {
      const check = options.verify === false ? undefined : await checkSandboxRuntime(options);
      return { installed: false, repaired: false, status: initial, ...(check === undefined ? {} : { check }) };
    }
    if (initial.state === "corrupt") {
      await quarantineManagedInstall(installRoot);
      repaired = true;
    }

    stagingRoot = resolve(
      managedSrtVersionRoot(options),
      `.${MANAGED_SRT_LOCK_SHA256}.staging.${process.pid}.${randomUUID()}`,
    );
    await mkdir(stagingRoot, { mode: 0o700 });
    await stageInstallResources(options.resourceRoot ?? MANAGED_SRT_RESOURCE_ROOT, stagingRoot);
    throwIfAborted(options.signal);

    if (options.hooks?.installDependencies !== undefined) {
      await options.hooks.installDependencies(stagingRoot, options.signal);
    } else {
      await runNpmCi(stagingRoot, options);
    }
    throwIfAborted(options.signal);

    await rm(resolve(stagingRoot, "node_modules", ".bin"), { recursive: true, force: true });
    await makeTreePrivateAndRejectLinks(stagingRoot);
    await writeInstallMarker(stagingRoot, options);
    await verifyManagedInstall(stagingRoot, options);

    try {
      await rename(stagingRoot, installRoot);
      stagingRoot = undefined;
    } catch (error) {
      if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) {
        throw error;
      }
      // Another actor can only win this race by bypassing our lock. Accept its
      // result solely if it independently passes the full integrity check.
      await verifyManagedInstall(installRoot, options);
    }

    const status = await inspectManagedOnly(options);
    if (status.state !== "ready") {
      throw new SandboxManagerError(
        "managed_srt_install_failed",
        `Managed SRT did not validate after atomic installation: ${status.message}`,
        { installRoot },
      );
    }
    const check = options.verify === false ? undefined : await checkSandboxRuntime(options);
    return { installed: true, repaired, status, ...(check === undefined ? {} : { check }) };
  } catch (error) {
    if (error instanceof SandboxManagerError) {
      throw error;
    }
    throw new SandboxManagerError(
      "managed_srt_install_failed",
      `Managed SRT installation failed without changing PATH or system packages: ${errorMessage(error)}`,
      { installRoot, cause: errorMessage(error) },
    );
  } finally {
    try {
      if (stagingRoot !== undefined) {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    } finally {
      await releaseInstallLock(heldLock);
    }
  }
}

export async function checkSandboxRuntime(options: SandboxManagerOptions = {}): Promise<SandboxCheckResult> {
  const status = await sandboxRuntimeStatus(options);
  if (status.state !== "ready") {
    throw new SandboxManagerError(
      status.state === "corrupt" ? "managed_srt_corrupt" : "sandbox_check_failed",
      status.message,
      { status },
    );
  }
  throwIfAborted(options.signal);
  let engine: SandboxEngine;
  if (status.source === "managed") {
    const { nodePath, cliPath } = status;
    if (nodePath === undefined || cliPath === undefined) {
      throw new SandboxManagerError(
        "managed_srt_corrupt",
        "Managed SRT status omitted its absolute Node or CLI path.",
        { status },
      );
    }
    engine = createSrtSandboxEngine({
      platform: options.platform ?? process.platform,
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      managedNodePath: nodePath,
    });
  } else {
    engine = createSrtSandboxEngine({ command: options.externalCommand === undefined ? "srt" : options.externalCommand || "srt" });
  }
  const checks: SandboxFunctionalCheck[] = [];
  if (!(await engine.isAvailable())) {
    throw new SandboxManagerError(
      "sandbox_check_failed",
      "SRT could be resolved but did not pass its initialization and filesystem enforcement proof.",
      { source: status.source },
    );
  }
  checks.push({ id: "engine", ok: true, detail: "SRT initialized and enforced a deny boundary." });

  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "mono-agent-srt-check-"));
  const workspace = resolve(fixtureRoot, "workspace");
  const siblingSecret = resolve(fixtureRoot, "sibling-secret.txt");
  const outsideWrite = resolve(fixtureRoot, "outside-write.txt");
  const envPath = resolve(workspace, ".env");
  const allowedPath = resolve(workspace, "allowed.txt");
  const outputPath = resolve(workspace, "output.txt");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("mono-agent-srt-ok");
  });
  let requestCount = 0;
  server.on("request", () => {
    requestCount += 1;
  });
  try {
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      writePrivateFile(allowedPath, "allowed\n"),
      writePrivateFile(siblingSecret, "secret\n"),
      writePrivateFile(envPath, "KEEP=true\n"),
    ]);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local functional-check server did not expose a TCP port");
    }
    const policy = createSandboxPolicy({
      root: workspace,
      readableRoots: [workspace],
      writableRoots: [workspace],
      denyWrite: [".env", ".env.*"],
      network: { mode: "localhost" },
      fallback: "fail-closed",
    });

    await runPrepared(engine, policy, {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');const [a,o]=process.argv.slice(1);if(fs.readFileSync(a,'utf8').trim()!=='allowed')process.exit(2);fs.writeFileSync(o,'written');",
        allowedPath,
        outputPath,
      ],
      cwd: workspace,
    }, options.signal);
    if (await readFile(outputPath, "utf8") !== "written") {
      throw new Error("allowed write did not persist");
    }
    checks.push({ id: "allowed-filesystem", ok: true, detail: "Allowed workspace read and write succeeded." });

    await expectPreparedDenied(engine, policy, {
      command: process.execPath,
      args: ["-e", "require('node:fs').readFileSync(process.argv[1])", siblingSecret],
      cwd: workspace,
    }, options.signal);
    checks.push({ id: "sibling-read-denied", ok: true, detail: "A sibling secret outside readableRoots was denied." });

    await expectPreparedDenied(engine, policy, {
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", envPath],
      cwd: workspace,
    }, options.signal);
    if (await readFile(envPath, "utf8") !== "KEEP=true\n") {
      throw new Error(".env content changed despite denyWrite");
    }
    checks.push({ id: "env-write-denied", ok: true, detail: ".env mutation was denied and content stayed intact." });

    await expectPreparedDenied(engine, policy, {
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'bad')", outsideWrite],
      cwd: workspace,
    }, options.signal);
    checks.push({ id: "outside-write-denied", ok: true, detail: "A write outside writableRoots was denied." });

    const allowedUrl = `http://127.0.0.1:${address.port}/allowed`;
    const allowedNetwork = await runPrepared(engine, policy, {
      command: "/usr/bin/curl",
      args: ["--fail", "--silent", "--show-error", "--max-time", "5", allowedUrl],
      cwd: workspace,
    }, options.signal);
    if (allowedNetwork.stdout.trim() !== "mono-agent-srt-ok" || requestCount !== 1) {
      throw new Error("localhost request did not reach the deterministic check server exactly once");
    }
    checks.push({ id: "localhost-allowed", ok: true, detail: "127.0.0.1 reached the local check server." });

    await expectPreparedDenied(engine, policy, {
      command: "/usr/bin/curl",
      args: [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "5",
        "--resolve",
        `blocked.test:${address.port}:127.0.0.1`,
        `http://blocked.test:${address.port}/blocked`,
      ],
      cwd: workspace,
    }, options.signal);
    if (requestCount !== 1) {
      throw new Error("blocked.test bypassed domain filtering and reached the local server");
    }
    checks.push({ id: "domain-denied", ok: true, detail: "blocked.test was denied before reaching the same local server." });
    return { status, checks };
  } catch (error) {
    throw new SandboxManagerError(
      "sandbox_check_failed",
      `SRT functional enforcement check failed: ${errorMessage(error)}`,
      { status, completedChecks: checks.map((check) => check.id), cause: errorMessage(error) },
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function inspectManagedOnly(options: SandboxManagerOptions): Promise<SandboxRuntimeStatus> {
  return sandboxRuntimeStatus({ ...options, externalCommand: false });
}

function managedSrtVersionRoot(options: SandboxManagerOptions): string {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(options);
  return resolve(cacheRoot, "mono-agent", "tools", "srt", MANAGED_SRT_VERSION);
}

function defaultCacheRoot(options: SandboxManagerOptions): string {
  const env = options.env ?? process.env;
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return resolve(xdg);
  }
  const home = options.homeDir ?? homedir();
  return (options.platform ?? process.platform) === "darwin"
    ? resolve(home, "Library", "Caches")
    : resolve(home, ".cache");
}

async function ensurePrivateVersionRoot(options: SandboxManagerOptions): Promise<void> {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(options);
  const roots = [
    resolve(cacheRoot, "mono-agent"),
    resolve(cacheRoot, "mono-agent", "tools"),
    resolve(cacheRoot, "mono-agent", "tools", "srt"),
    managedSrtVersionRoot(options),
  ];
  for (const [index, root] of roots.entries()) {
    try {
      await mkdir(root, { mode: 0o700, recursive: index === 0 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }
    await assertPrivateDirectory(root);
  }
}

async function verifyInstallResources(resourceRoot: string): Promise<void> {
  const lockPath = resolve(resourceRoot, "package-lock.json");
  const packagePath = resolve(resourceRoot, "package.json");
  await assertSingleRegularFile(lockPath, false, false);
  await assertSingleRegularFile(packagePath, false, false);
  const [lockContent, packageContent] = await Promise.all([readFile(lockPath), readFile(packagePath, "utf8")]);
  if (sha256(lockContent) !== MANAGED_SRT_LOCK_SHA256) {
    throw new SandboxManagerError(
      "managed_srt_corrupt",
      "Bundled SRT package-lock.json failed its pinned SHA-256 check; refusing network installation.",
      { resourceRoot },
    );
  }
  const manifest = JSON.parse(packageContent) as { dependencies?: Record<string, unknown> };
  if (manifest.dependencies?.[MANAGED_SRT_PACKAGE] !== MANAGED_SRT_VERSION) {
    throw new SandboxManagerError(
      "managed_srt_corrupt",
      "Bundled SRT package.json does not pin the expected exact version.",
      { resourceRoot },
    );
  }
}

async function stageInstallResources(resourceRoot: string, stagingRoot: string): Promise<void> {
  for (const name of ["package.json", "package-lock.json"] as const) {
    const source = resolve(resourceRoot, name);
    const target = resolve(stagingRoot, name);
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    await chmod(target, 0o600);
  }
  await verifyInstallResources(stagingRoot);
}

async function runNpmCi(stagingRoot: string, options: SandboxManagerOptions): Promise<void> {
  const nodePath = resolveNodePath(options);
  const npmCliPath = await resolveNpmCliPath(options);
  const env = options.env ?? process.env;
  await execFileAsync(
    nodePath,
    [npmCliPath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: stagingRoot,
      env: {
        ...env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
        npm_config_package_lock: "true",
      },
      timeout: options.installTimeoutMs ?? 120_000,
      signal: options.signal,
      maxBuffer: 4_000_000,
    },
  );
}

function resolveNodePath(options: SandboxManagerOptions): string {
  const nodePath = options.nodePath ?? process.execPath;
  if (!isAbsolute(nodePath)) {
    throw new SandboxManagerError("managed_srt_install_failed", "Node executable path is not absolute.", { nodePath });
  }
  return nodePath;
}

async function resolveNpmCliPath(options: SandboxManagerOptions): Promise<string> {
  const candidates = [
    options.npmCliPath,
    options.env?.npm_execpath,
    process.env.npm_execpath,
    resolve(dirname(resolveNodePath(options)), "npm"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) {
      continue;
    }
    try {
      const real = await realpath(candidate);
      const candidateStat = await stat(real);
      if (
        candidateStat.isFile()
        && (candidateStat.mode & 0o022) === 0
        && (process.getuid === undefined || candidateStat.uid === process.getuid() || candidateStat.uid === 0)
      ) {
        return real;
      }
    } catch {
      // Try the next deterministic absolute candidate.
    }
  }
  throw new SandboxManagerError(
    "managed_srt_install_failed",
    "Could not resolve a trusted absolute npm CLI next to the running Node installation.",
    { nodePath: resolveNodePath(options) },
  );
}

async function assertTrustedNodeExecutable(nodePath: string): Promise<void> {
  const nodeStat = await lstat(nodePath);
  if (nodeStat.isSymbolicLink() || !nodeStat.isFile()) {
    throw new Error(`Node executable is not a regular non-symbolic file: ${nodePath}`);
  }
  if (nodeStat.nlink !== 1) {
    throw new Error(`Node executable has ${nodeStat.nlink} hard links instead of one: ${nodePath}`);
  }
  if ((nodeStat.mode & 0o022) !== 0) {
    throw new Error(`Node executable is writable by group or other users: ${nodePath}`);
  }
  if (process.getuid !== undefined && nodeStat.uid !== process.getuid() && nodeStat.uid !== 0) {
    throw new Error(`Node executable is not owned by the current user or root: ${nodePath}`);
  }
}

async function writeInstallMarker(stagingRoot: string, options: SandboxManagerOptions): Promise<void> {
  const cliPath = managedCliPath(stagingRoot);
  const packageJsonPath = managedPackageJsonPath(stagingRoot);
  const treeSha256 = await hashPrivateManagedTree(stagingRoot);
  const expectedTreeSha256 = await trustedTreeSha256(stagingRoot, options);
  if (treeSha256 !== expectedTreeSha256) {
    throw new SandboxManagerError(
      "managed_srt_corrupt",
      "Installed SRT dependency tree does not match the independently pinned release manifest.",
      { expectedTreeSha256, treeSha256 },
    );
  }
  const marker: ManagedSrtMarker = {
    schemaVersion: 2,
    package: MANAGED_SRT_PACKAGE,
    version: MANAGED_SRT_VERSION,
    lockSha256: MANAGED_SRT_LOCK_SHA256,
    cliSha256: sha256(await readFile(cliPath)),
    packageJsonSha256: sha256(await readFile(packageJsonPath)),
    treeSha256: expectedTreeSha256,
  };
  const markerPath = resolve(stagingRoot, MANAGED_SRT_MARKER);
  const handle = await open(
    markerPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyManagedInstall(installRoot: string, options: SandboxManagerOptions): Promise<string> {
  try {
    await assertPrivateDirectory(installRoot);
    let ancestor = dirname(installRoot);
    for (let index = 0; index < 4; index += 1) {
      await assertPrivateDirectory(ancestor);
      ancestor = dirname(ancestor);
    }
    const markerPath = resolve(installRoot, MANAGED_SRT_MARKER);
    const lockPath = resolve(installRoot, "package-lock.json");
    const cliPath = managedCliPath(installRoot);
    const packageJsonPath = managedPackageJsonPath(installRoot);
    for (const path of [markerPath, lockPath, cliPath, packageJsonPath]) {
      await assertSingleRegularFile(path, true);
    }
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as ManagedSrtMarker;
    if (
      marker.schemaVersion !== 2
      || marker.package !== MANAGED_SRT_PACKAGE
      || marker.version !== MANAGED_SRT_VERSION
      || marker.lockSha256 !== MANAGED_SRT_LOCK_SHA256
      || !isSha256(marker.cliSha256)
      || !isSha256(marker.packageJsonSha256)
      || marker.treeSha256 !== await trustedTreeSha256(installRoot, options)
    ) {
      throw new Error("install marker identity is invalid");
    }
    const [lockHash, cliHash, packageJsonHash, treeHash] = await Promise.all([
      hashFile(lockPath),
      hashFile(cliPath),
      hashFile(packageJsonPath),
      hashPrivateManagedTree(installRoot),
    ]);
    if (lockHash !== MANAGED_SRT_LOCK_SHA256) {
      throw new Error("installed package-lock.json differs from the pinned lock");
    }
    if (cliHash !== marker.cliSha256 || packageJsonHash !== marker.packageJsonSha256) {
      throw new Error("installed SRT content differs from its marker");
    }
    if (treeHash !== marker.treeSha256 || treeHash !== await trustedTreeSha256(installRoot, options)) {
      throw new Error("installed SRT dependency tree differs from the independently pinned release manifest");
    }
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
    if (packageJson.name !== MANAGED_SRT_PACKAGE || packageJson.version !== MANAGED_SRT_VERSION) {
      throw new Error("installed package name or version is not pinned");
    }
    return cliPath;
  } catch (error) {
    throw new SandboxManagerError(
      "managed_srt_corrupt",
      `Managed SRT install at ${installRoot} is unsafe or corrupt: ${errorMessage(error)}`,
      { installRoot, cause: errorMessage(error) },
    );
  }
}

async function quarantineManagedInstall(installRoot: string): Promise<void> {
  const quarantine = `${installRoot}.corrupt.${Date.now()}.${randomUUID()}`;
  try {
    await rename(installRoot, quarantine);
  } catch (error) {
    throw new SandboxManagerError(
      "managed_srt_corrupt",
      `Could not quarantine corrupt managed SRT safely: ${errorMessage(error)}`,
      { installRoot, quarantine, cause: errorMessage(error) },
    );
  }
}

async function cleanupStaleStaging(versionRoot: string): Promise<void> {
  const directory = await opendir(versionRoot);
  const prefix = `.${MANAGED_SRT_LOCK_SHA256}.staging.`;
  for await (const entry of directory) {
    if (!entry.name.startsWith(prefix)) {
      continue;
    }
    const path = resolve(versionRoot, entry.name);
    const entryStat = await lstat(path);
    if (
      entryStat.isSymbolicLink()
      || !entryStat.isDirectory()
      || (entryStat.mode & 0o077) !== 0
      || (process.getuid !== undefined && entryStat.uid !== process.getuid())
    ) {
      throw new SandboxManagerError(
        "managed_srt_corrupt",
        `Stale SRT staging entry is unsafe and was left untouched: ${path}`,
        { path },
      );
    }
    await rm(path, { recursive: true, force: true });
  }
}

async function acquireInstallLock(options: SandboxManagerOptions): Promise<HeldInstallLock> {
  const lockPath = resolve(managedSrtVersionRoot(options), INSTALL_LOCK_NAME);
  const deadline = Date.now() + INSTALL_LOCK_WAIT_MS;
  while (true) {
    throwIfAborted(options.signal);
    const token = randomUUID();
    let handle;
    try {
      handle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const record: InstallLockRecord = {
        schemaVersion: 1,
        pid: process.pid,
        uid: process.getuid?.() ?? null,
        token,
        startedAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      const lockStat = await handle.stat({ bigint: true });
      await handle.close();
      return { path: lockPath, token, dev: lockStat.dev, ino: lockStat.ino };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }

    let existing: Awaited<ReturnType<typeof readSecureInstallLock>>;
    try {
      existing = await readSecureInstallLock(lockPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const liveness = options.hooks?.processIsAlive?.(existing.record.pid) ?? processLiveness(existing.record.pid);
    if (liveness === "dead") {
      try {
        await unlinkLockIfUnchanged(lockPath, existing);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
      continue;
    }
    if (liveness === "unknown") {
      throw new SandboxManagerError(
        "managed_srt_lock_unsafe",
        `Cannot prove whether SRT install lock owner PID ${existing.record.pid} is alive; refusing to remove it.`,
        { lockPath, pid: existing.record.pid },
      );
    }
    if (Date.now() >= deadline) {
      throw new SandboxManagerError(
        "managed_srt_lock_unsafe",
        `Another live process (PID ${existing.record.pid}) still owns the SRT install lock.`,
        { lockPath, pid: existing.record.pid },
      );
    }
    await (options.hooks?.sleep ?? abortableSleep)(100, options.signal);
  }
}

async function readSecureInstallLock(lockPath: string): Promise<{
  readonly record: InstallLockRecord;
  readonly content: string;
  readonly dev: bigint;
  readonly ino: bigint;
}> {
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const lockStat = await handle.stat({ bigint: true });
    if (!lockStat.isFile() || lockStat.nlink !== 1n || (lockStat.mode & 0o077n) !== 0n) {
      throw new Error("lock is not an owner-only single-link regular file");
    }
    if (process.getuid !== undefined && lockStat.uid !== BigInt(process.getuid())) {
      throw new Error("lock owner differs from the current user");
    }
    const content = await handle.readFile("utf8");
    const record = JSON.parse(content) as InstallLockRecord;
    if (
      record.schemaVersion !== 1
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || typeof record.token !== "string"
      || !/^[a-f0-9-]{36}$/iu.test(record.token)
      || typeof record.startedAt !== "string"
      || (record.uid !== null && !Number.isSafeInteger(record.uid))
      || (process.getuid !== undefined && record.uid !== process.getuid())
    ) {
      throw new Error("lock record is malformed or belongs to another user");
    }
    return { record, content, dev: lockStat.dev, ino: lockStat.ino };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw error;
    }
    throw new SandboxManagerError(
      "managed_srt_lock_unsafe",
      `SRT install lock is unsafe and was left untouched: ${errorMessage(error)}`,
      { lockPath, cause: errorMessage(error) },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function unlinkLockIfUnchanged(
  lockPath: string,
  expected: Awaited<ReturnType<typeof readSecureInstallLock>>,
): Promise<void> {
  const current = await readSecureInstallLock(lockPath);
  if (
    current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.content !== expected.content
    || current.record.token !== expected.record.token
  ) {
    throw new SandboxManagerError(
      "managed_srt_lock_unsafe",
      "SRT install lock changed during stale-lock verification; it was left untouched.",
      { lockPath },
    );
  }
  await unlink(lockPath);
}

async function releaseInstallLock(lock: HeldInstallLock): Promise<void> {
  if (!(await pathExists(lock.path))) {
    return;
  }
  let current: Awaited<ReturnType<typeof readSecureInstallLock>>;
  try {
    current = await readSecureInstallLock(lock.path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (current.dev !== lock.dev || current.ino !== lock.ino || current.record.token !== lock.token) {
    throw new SandboxManagerError(
      "managed_srt_lock_unsafe",
      "SRT install lock identity changed; refusing to remove another process's lock.",
      { lockPath: lock.path },
    );
  }
  await unlink(lock.path);
}

function processLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error, "ESRCH")) {
      return "dead";
    }
    if (isNodeError(error, "EPERM")) {
      return "alive";
    }
    return "unknown";
  }
}

async function makeTreePrivateAndRejectLinks(root: string): Promise<void> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = resolve(root, entry.name);
    const entryStat = await lstat(path);
    if (entryStat.isSymbolicLink()) {
      throw new SandboxManagerError(
        "managed_srt_corrupt",
        `Managed SRT staging tree contains an unexpected symbolic link: ${path}`,
        { path },
      );
    }
    if (entryStat.isDirectory()) {
      await chmod(path, 0o700);
      await makeTreePrivateAndRejectLinks(path);
    } else if (entryStat.isFile() && entryStat.nlink === 1) {
      await chmod(path, 0o600);
    } else {
      throw new SandboxManagerError(
        "managed_srt_corrupt",
        `Managed SRT staging tree contains an unsupported filesystem entry: ${path}`,
        { path },
      );
    }
  }
  await chmod(root, 0o700);
}

async function hashPrivateManagedTree(installRoot: string): Promise<string> {
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
      if (relativePath === MANAGED_SRT_MARKER || relativePath === "node_modules/.package-lock.json") {
        continue;
      }
      const entryStat = await lstat(path);
      if (
        entryStat.isSymbolicLink()
        || (process.getuid !== undefined && entryStat.uid !== process.getuid())
        || (entryStat.mode & 0o077) !== 0
      ) {
        throw new Error(`unsafe managed dependency tree entry: ${relativePath}`);
      }
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(path);
      } else if (entryStat.isFile() && entryStat.nlink === 1) {
        hash.update(`F\0${relativePath}\0${entryStat.size}\0`);
        hash.update(await readFile(path));
      } else {
        throw new Error(`unsupported managed dependency tree entry: ${relativePath}`);
      }
    }
  }
  await walk(installRoot);
  return hash.digest("hex");
}

async function trustedTreeSha256(installRoot: string, options: SandboxManagerOptions): Promise<string> {
  return options.hooks?.expectedTreeSha256 === undefined
    ? MANAGED_SRT_TREE_SHA256
    : await options.hooks.expectedTreeSha256(installRoot);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const pathStat = await lstat(path);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isDirectory()
    || (pathStat.mode & 0o077) !== 0
    || (process.getuid !== undefined && pathStat.uid !== process.getuid())
  ) {
    throw new Error(`${path} must be a real owner-only directory owned by the current user`);
  }
}

async function assertSingleRegularFile(path: string, privateFile: boolean, requireSingleLink = true): Promise<void> {
  const pathStat = await lstat(path);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || (requireSingleLink && pathStat.nlink !== 1)
    || (privateFile && (pathStat.mode & 0o077) !== 0)
  ) {
    throw new Error(`${path} must be a ${privateFile ? "private " : ""}${requireSingleLink ? "single-link " : ""}regular file`);
  }
}

async function runPrepared(
  engine: SandboxEngine,
  policy: SandboxPolicy,
  spec: { readonly command: string; readonly args: readonly string[]; readonly cwd: string },
  signal: AbortSignal | undefined,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  let prepared: PreparedSandboxCommand | undefined;
  try {
    prepared = await engine.prepareCommand(spec, policy);
    const result = await execFileAsync(prepared.command, [...prepared.args], {
      cwd: prepared.cwd,
      env: prepared.env === undefined ? process.env : { ...process.env, ...prepared.env },
      timeout: 15_000,
      signal,
      maxBuffer: 1_000_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    await prepared?.cleanup?.().catch(() => undefined);
  }
}

async function expectPreparedDenied(
  engine: SandboxEngine,
  policy: SandboxPolicy,
  spec: { readonly command: string; readonly args: readonly string[]; readonly cwd: string },
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await runPrepared(engine, policy, spec, signal);
  } catch (error) {
    const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    const evidence = [candidate.message, candidate.stdout, candidate.stderr]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (/operation not permitted|permission denied|eacces|eperm|not allowed|denied|http[^\n]*403|requested url returned error:\s*403/iu.test(evidence)) {
      return;
    }
    throw new Error(`Command failed without sandbox-denial evidence: ${evidence || errorMessage(error)}`);
  }
  throw new Error(`Sandbox unexpectedly allowed: ${spec.command} ${spec.args.join(" ")}`);
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function managedCliPath(installRoot: string): string {
  return resolve(installRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js");
}

function managedPackageJsonPath(installRoot: string): string {
  return resolve(installRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "package.json");
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertSupportedNodeVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) {
    throw new SandboxManagerError("managed_srt_install_failed", `Could not parse Node version ${version}.`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 20 || (major === 20 && minor < 11)) {
    throw new SandboxManagerError(
      "managed_srt_install_failed",
      `Managed SRT requires Node >=20.11.0; current Node is ${version}.`,
      { version },
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function abortableSleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  await delay(milliseconds, undefined, signal === undefined ? undefined : { signal });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

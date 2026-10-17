import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE } from "../../launchd-maintenance-command.js";
import { assertRegularFile, isErrno, lstat, ownedPrivately } from "./inspection-io.js";
import type { RuntimeIdentity, RuntimeLayout } from "./types.js";

export const PACKAGE_NAME = "@mono-agent/app";

export function packageRootForCli(cliPath: string): string {
  return resolve(dirname(cliPath), "..");
}

export async function packageVersionAt(packageRoot: string): Promise<string> {
  const packageJsonPath = resolve(packageRoot, "package.json");
  await assertRegularFile(packageJsonPath, "mono-agent package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Invalid package metadata at ${packageJsonPath}.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.name !== PACKAGE_NAME || typeof record.version !== "string") {
    throw new Error(`The executing CLI is not inside a valid ${PACKAGE_NAME} package.`);
  }
  return record.version;
}

export function runtimeLayout(home: string, identity: RuntimeIdentity, id: string, nowMs: number): RuntimeLayout {
  const versionAbiDir = runtimeVersionAbiDir(
    home,
    identity.packageVersion,
    identity.nodeAbi,
    identity.platform,
    identity.arch,
  );
  const closureId = `${identity.cliSha256}-${identity.sourceClosureSha256}`;
  const installRoot = join(versionAbiDir, closureId);
  const suffix = `${Math.max(0, Math.floor(nowMs))}-${id}`;
  return {
    versionAbiDir,
    installRoot,
    cliPath: join(installRoot, "node_modules", "@mono-agent", "app", "dist", "cli.js"),
    maintenanceEntryPath: join(
      installRoot,
      "node_modules",
      "@mono-agent",
      "app",
      "dist",
      MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE,
    ),
    packageJsonPath: join(installRoot, "node_modules", "@mono-agent", "app", "package.json"),
    packageLockPath: join(installRoot, "package-lock.json"),
    closureManifestPath: join(installRoot, ".mono-agent-closure.json"),
    markerPath: join(installRoot, ".mono-agent-runtime.json"),
    reuseProofDir: join(versionAbiDir, ".reuse-proofs"),
    reuseProofPath: join(versionAbiDir, ".reuse-proofs", `${closureId}.json`),
    lockDir: join(versionAbiDir, `.${closureId}.lock`),
    stagingDir: join(versionAbiDir, `.${closureId}.staging-${suffix}`),
    quarantineDir: join(versionAbiDir, "quarantine", `${closureId}-${suffix}`),
  };
}

export function runtimeVersionAbiDir(
  home: string,
  packageVersion: string,
  nodeAbi: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const platformAbi = `${safeSegment(platform)}-${safeSegment(arch)}-abi-${safeSegment(nodeAbi)}`;
  return join(home, ".mono-agent", "runtimes", "agent-app", packageVersion, platformAbi);
}

export function runtimeLayoutForRoot(layout: RuntimeLayout, root: string): RuntimeLayout {
  return {
    ...layout,
    installRoot: root,
    cliPath: join(root, "node_modules", "@mono-agent", "app", "dist", "cli.js"),
    maintenanceEntryPath: join(
      root,
      "node_modules",
      "@mono-agent",
      "app",
      "dist",
      MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE,
    ),
    packageJsonPath: join(root, "node_modules", "@mono-agent", "app", "package.json"),
    packageLockPath: join(root, "package-lock.json"),
    closureManifestPath: join(root, ".mono-agent-closure.json"),
    markerPath: join(root, ".mono-agent-runtime.json"),
  };
}

export async function ensurePrivateRuntimeAncestors(home: string, versionAbiDir: string): Promise<void> {
  const base = join(home, ".mono-agent");
  const relative = versionAbiDir.slice(base.length).split(/[\\/]/u).filter(Boolean);
  const paths = [base];
  for (const segment of relative) paths.push(join(paths.at(-1)!, segment));
  for (const path of paths) {
    await mkdir(path, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
      if (!isErrno(error, "EEXIST")) throw error;
    });
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Managed runtime ancestor ${path} must be a real directory.`);
    }
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw new Error(`Managed runtime ancestor ${path} is not owned by the current user.`);
    }
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if (!ownedPrivately(secured)) {
      throw new Error(`Managed runtime ancestor ${path} could not be secured to mode 0700.`);
    }
  }
}

export async function verifyPrivateRuntimeAncestors(home: string, versionAbiDir: string): Promise<boolean> {
  const base = join(home, ".mono-agent");
  const pathRelative = relative(base, versionAbiDir);
  if (pathRelative === "" || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    return false;
  }
  const paths = [base];
  for (const segment of pathRelative.split(/[\\/]/u).filter(Boolean)) {
    paths.push(join(paths.at(-1)!, segment));
  }
  try {
    for (const path of paths) {
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink() || !ownedPrivately(details)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function requiredNodeAbi(): string {
  const abi = process.versions.modules;
  if (abi === undefined || abi.trim().length === 0) {
    throw new Error("Node did not report a module ABI; refusing to create a managed runtime.");
  }
  return abi;
}

export function isExactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

export function safeSegment(value: string): string {
  const normalized = value.replace(/[^0-9A-Za-z._-]/gu, "-").replace(/-+/gu, "-");
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw new Error(`Cannot use ${JSON.stringify(value)} as a managed runtime path segment.`);
  }
  return normalized;
}

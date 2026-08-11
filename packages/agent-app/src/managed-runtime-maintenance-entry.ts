import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { accountHomeDirectory } from "./account-home.js";
import { MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE } from "./launchd-maintenance-command.js";
import { decodeManagedRuntimeLaunchProof } from "./managed-runtime-launch-proof.js";

const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_CLOSURE_MANIFEST_BYTES = 64 * 1024 * 1024;

interface MaintenanceRuntimeMarker {
  readonly schema: "mono-agent.managed-runtime.v4" | "mono-agent.managed-runtime.v5";
  readonly packageName: "@mono-agent/agent-app";
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly sourceClosureSha256: string;
  readonly nodeAbi: string;
  readonly platform: string;
  readonly arch: string;
  readonly closureManifestSha256: string;
  readonly executionProofSha256: string;
  readonly reuseProofSha256?: string;
  readonly installedAt: string;
}

/**
 * Verify the lightweight executable against the same path-free launch proof
 * and private managed-runtime marker carried by the main worker definition.
 */
export async function verifyManagedRuntimeMaintenanceEntrypoint(input: {
  readonly currentEntrypointPath: string;
  readonly launchProof: string;
  readonly homeDir?: string;
}): Promise<void> {
  const proof = decodeManagedRuntimeLaunchProof(input.launchProof);
  const entryPath = resolve(input.currentEntrypointPath);
  const home = resolve(input.homeDir ?? accountHomeDirectory());
  const packageRoot = dirname(dirname(entryPath));
  const installRoot = dirname(dirname(dirname(packageRoot)));
  const expectedPackageRoot = join(installRoot, "node_modules", "@mono-agent", "agent-app");
  if (!isAbsolute(input.currentEntrypointPath)
    || entryPath !== join(expectedPackageRoot, "dist", MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE)
    || packageRoot !== expectedPackageRoot) {
    throw new Error("The launchd maintenance entry is outside its canonical managed runtime closure.");
  }

  const runtimeRoot = join(home, ".mono-agent", "runtimes", "agent-app");
  const installRelative = relative(runtimeRoot, installRoot);
  const segments = installRelative.split(sep);
  if (installRelative.length === 0
    || installRelative === ".."
    || installRelative.startsWith(`..${sep}`)
    || isAbsolute(installRelative)
    || segments.length !== 3
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(segments[0] ?? "")
    || !/^[0-9A-Za-z._-]+$/u.test(segments[1] ?? "")
    || !/^[0-9a-f]{64}-[0-9a-f]{64}$/u.test(segments[2] ?? "")) {
    throw new Error("The launchd maintenance entry has an invalid managed runtime layout.");
  }
  await verifyPrivateAncestors(home, installRoot);
  await verifyManagedPackageDirectories(installRoot, packageRoot);

  const markerPath = join(installRoot, ".mono-agent-runtime.json");
  const markerInitial = await readStableFile(markerPath, MAX_MARKER_BYTES, true);
  const entryInitial = await readStableFile(entryPath, MAX_ENTRY_BYTES, false);
  if (sha256(markerInitial.bytes) !== proof.markerSha256
    || sha256(entryInitial.bytes) !== proof.maintenanceEntrySha256) {
    throw new Error("The launchd maintenance entry does not match its managed runtime launch proof.");
  }
  let markerValue: unknown;
  try {
    markerValue = JSON.parse(markerInitial.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("The managed runtime marker is not valid JSON.");
  }
  const marker = maintenanceRuntimeMarkerFromJson(markerValue);
  if (marker === undefined || marker.installedAt !== proof.installedAt) {
    throw new Error("The launchd maintenance entry proof does not match its runtime marker.");
  }
  const expectedInstallRoot = join(
    runtimeRoot,
    marker.packageVersion,
    `${safeSegment(marker.platform)}-${safeSegment(marker.arch)}-abi-${safeSegment(marker.nodeAbi)}`,
    `${marker.cliSha256}-${marker.sourceClosureSha256}`,
  );
  if (installRoot !== expectedInstallRoot) {
    throw new Error("The launchd maintenance entry does not match its marker's canonical runtime identity.");
  }

  const cliPath = join(packageRoot, "dist", "cli.js");
  const manifestPath = join(installRoot, ".mono-agent-closure.json");
  const [cliInitial, manifestInitial] = await Promise.all([
    readStableFile(cliPath, MAX_ENTRY_BYTES, false),
    readStableFile(manifestPath, MAX_CLOSURE_MANIFEST_BYTES, true),
  ]);
  if (sha256(cliInitial.bytes) !== marker.cliSha256
    || sha256(manifestInitial.bytes) !== marker.closureManifestSha256) {
    throw new Error("The launchd maintenance entry closure fingerprints do not match its runtime marker.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestInitial.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("The managed runtime closure manifest is not valid JSON.");
  }
  if (!isRecord(manifest)
    || manifest.schema !== "mono-agent.execution-closure.v1"
    || !Array.isArray(manifest.entries)) {
    throw new Error("The managed runtime closure manifest is malformed.");
  }

  const [markerFinal, entryFinal, cliFinal, manifestFinal] = await Promise.all([
    readStableFile(markerPath, MAX_MARKER_BYTES, true),
    readStableFile(entryPath, MAX_ENTRY_BYTES, false),
    readStableFile(cliPath, MAX_ENTRY_BYTES, false),
    readStableFile(manifestPath, MAX_CLOSURE_MANIFEST_BYTES, true),
  ]);
  if (!markerFinal.bytes.equals(markerInitial.bytes)
    || !entryFinal.bytes.equals(entryInitial.bytes)
    || !cliFinal.bytes.equals(cliInitial.bytes)
    || !manifestFinal.bytes.equals(manifestInitial.bytes)
    || !sameStats(markerFinal.stats, markerInitial.stats)
    || !sameStats(entryFinal.stats, entryInitial.stats)
    || !sameStats(cliFinal.stats, cliInitial.stats)
    || !sameStats(manifestFinal.stats, manifestInitial.stats)) {
    throw new Error("The managed runtime maintenance entry changed during launch attestation.");
  }
}

async function verifyManagedPackageDirectories(installRoot: string, packageRoot: string): Promise<void> {
  for (const path of [
    join(installRoot, "node_modules"),
    join(installRoot, "node_modules", "@mono-agent"),
    packageRoot,
    join(packageRoot, "dist"),
  ]) {
    const details = await lstat(path, { bigint: true });
    if (!details.isDirectory() || details.isSymbolicLink() || !currentUserOwns(details)) {
      throw new Error(`Managed runtime package ancestor ${path} is unsafe.`);
    }
  }
}

async function verifyPrivateAncestors(home: string, installRoot: string): Promise<void> {
  const base = join(home, ".mono-agent");
  const pathRelative = relative(base, installRoot);
  if (pathRelative.length === 0
    || pathRelative === ".."
    || pathRelative.startsWith(`..${sep}`)
    || isAbsolute(pathRelative)) {
    throw new Error("The managed runtime maintenance entry has unsafe ancestry.");
  }
  const paths = [base];
  for (const segment of pathRelative.split(sep)) paths.push(join(paths.at(-1)!, segment));
  for (const path of paths) {
    const details = await lstat(path, { bigint: true });
    if (!details.isDirectory()
      || details.isSymbolicLink()
      || !currentUserOwns(details)
      || (details.mode & 0o077n) !== 0n) {
      throw new Error(`Managed runtime ancestor ${path} is not owner-private.`);
    }
  }
}

async function readStableFile(
  path: string,
  maxBytes: number,
  ownerOnly: boolean,
): Promise<{ readonly bytes: Buffer; readonly stats: BigIntStats }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    assertSafeFile(before, path, maxBytes, ownerOnly);
    const bytes = await handle.readFile();
    const [after, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    assertSafeFile(after, path, maxBytes, ownerOnly);
    assertSafeFile(named, path, maxBytes, ownerOnly);
    if (!sameStats(before, after) || !sameStats(before, named) || bytes.length !== Number(before.size)) {
      throw new Error(`Managed runtime file ${path} changed while it was read.`);
    }
    return { bytes, stats: before };
  } finally {
    await handle.close();
  }
}

function assertSafeFile(details: BigIntStats, path: string, maxBytes: number, ownerOnly: boolean): void {
  if (!details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1n
    || details.size < 1n
    || details.size > BigInt(maxBytes)
    || !currentUserOwns(details)
    || (ownerOnly && (details.mode & 0o077n) !== 0n)) {
    throw new Error(`Managed runtime file ${path} is unsafe.`);
  }
}

function currentUserOwns(details: BigIntStats): boolean {
  return typeof process.getuid !== "function" || details.uid === BigInt(process.getuid());
}

function sameStats(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function maintenanceRuntimeMarkerFromJson(value: unknown): MaintenanceRuntimeMarker | undefined {
  if (!isRecord(value)) return undefined;
  const commonKeys = [
    "schema",
    "packageName",
    "packageVersion",
    "cliSha256",
    "sourceClosureSha256",
    "nodeAbi",
    "platform",
    "arch",
    "closureManifestSha256",
    "executionProofSha256",
    "installedAt",
  ];
  const exactKeys = value.schema === "mono-agent.managed-runtime.v5"
    ? [...commonKeys, "reuseProofSha256"]
    : commonKeys;
  const installedAtMs = typeof value.installedAt === "string" ? Date.parse(value.installedAt) : Number.NaN;
  if (Object.keys(value).length !== exactKeys.length
    || !exactKeys.every((key) => Object.hasOwn(value, key))
    || (value.schema !== "mono-agent.managed-runtime.v4" && value.schema !== "mono-agent.managed-runtime.v5")
    || value.packageName !== "@mono-agent/agent-app"
    || typeof value.packageVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.packageVersion)
    || !isSha256(value.cliSha256)
    || !isSha256(value.sourceClosureSha256)
    || typeof value.nodeAbi !== "string"
    || value.nodeAbi.length === 0
    || typeof value.platform !== "string"
    || value.platform.length === 0
    || typeof value.arch !== "string"
    || value.arch.length === 0
    || !isSha256(value.closureManifestSha256)
    || !isSha256(value.executionProofSha256)
    || (value.schema === "mono-agent.managed-runtime.v5" && !isSha256(value.reuseProofSha256))
    || typeof value.installedAt !== "string"
    || !Number.isFinite(installedAtMs)
    || new Date(installedAtMs).toISOString() !== value.installedAt
    || value.installedAt === "1970-01-01T00:00:00.000Z") {
    return undefined;
  }
  return value as unknown as MaintenanceRuntimeMarker;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^0-9A-Za-z._-]/gu, "-").replace(/-+/gu, "-");
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw new Error("The managed runtime marker contains an invalid path identity.");
  }
  return normalized;
}

import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE } from "../launchd/launchd-maintenance-command.js";
import {
  assertPathInsideRoot,
  assertRegularFile,
  captureFilesystemPathProof,
  compareCodeUnits,
  fileMode,
  isRecord,
  limitRuntimeRead,
  limitRuntimeStat,
  lstat,
  mapWithConcurrency,
  ownedPrivately,
  RUNTIME_FILE_READ_CONCURRENCY,
  RUNTIME_REUSE_STAT_CONCURRENCY,
  sameSourceProofEntry,
  sameSourceStats,
  sha256,
  sourceProofEntry,
} from "./inspection-io.js";
import { PACKAGE_NAME } from "./layout.js";
import { privateJsonContents, readRuntimeMarker } from "./marker.js";
import { captureExecutionClosure, packageNameSegments, portableRelativePath } from "./source-closure.js";
import type {
  ExecutionClosureCapture,
  ExecutionClosureCaptureDeps,
  ManagedRuntimeAdditionalPackage,
  RuntimeClosureEntry,
  RuntimeClosureManifest,
  RuntimeClosureManifestCaptureDeps,
  RuntimeIdentity,
  RuntimeLayout,
  RuntimeMarker,
  SourcePackageProofEntry,
} from "./types.js";

export async function managedRuntimeAdditionalPackages(
  layout: RuntimeLayout,
): Promise<readonly ManagedRuntimeAdditionalPackage[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(layout.packageLockPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.lockfileVersion !== 3 || !isRecord(parsed.packages)) return undefined;
    const byName = new Map<string, string>();
    for (const [path, value] of Object.entries(parsed.packages)) {
      if (!isRecord(value)) return undefined;
      if (value.link !== true) continue;
      const segments = path.split("/");
      if (segments[0] !== "node_modules") return undefined;
      const nameSegments = segments.slice(1);
      const packageName = nameSegments.join("/");
      packageNameSegments(packageName);
      if (
        packageName === PACKAGE_NAME
        || join("node_modules", ...nameSegments).split(sep).join("/") !== path
        || typeof value.resolved !== "string"
      ) {
        return undefined;
      }
      const packageSource = join(layout.installRoot, "node_modules", ...nameSegments);
      const linkDetails = await lstat(packageSource);
      if (!linkDetails.isSymbolicLink()) return undefined;
      const target = await readlink(packageSource);
      if (isAbsolute(target)) return undefined;
      const canonical = await realpath(packageSource);
      assertPathInsideRoot(layout.installRoot, canonical, `additional package ${packageName}`);
      if (portableRelativePath(layout.installRoot, canonical) !== value.resolved) return undefined;
      const existing = byName.get(packageName);
      if (existing !== undefined && existing !== packageSource) return undefined;
      byName.set(packageName, packageSource);
    }
    return [...byName]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([packageName, packageSource]) => ({ packageName, packageSource }));
  } catch {
    return undefined;
  }
}

export async function matchingRuntimeClosureCapture(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  marker: RuntimeMarker,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  deps: ExecutionClosureCaptureDeps = {},
): Promise<ExecutionClosureCapture | undefined> {
  const packageSource = dirname(dirname(layout.cliPath));
  const runtimeAdditionalPackages = additionalPackages.map(({ packageName }) => ({
    packageName,
    packageSource: join(layout.installRoot, "node_modules", ...packageNameSegments(packageName)),
  }));
  const closure = await captureExecutionClosure(packageSource, runtimeAdditionalPackages, layout.installRoot, deps);
  return closure.sourceClosureSha256 === identity.sourceClosureSha256
    && closure.filesystemProofSha256 === marker.executionProofSha256
    ? closure
    : undefined;
}

export async function verifyRuntime(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
): Promise<boolean> {
  const marker = await verifiedRuntimeMarker(layout, identity);
  if (marker === undefined) return false;
  try {
    return await matchingRuntimeClosureCapture(layout, identity, marker, additionalPackages) !== undefined;
  } catch {
    return false;
  }
}

export async function verifiedRuntimeMarker(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
): Promise<RuntimeMarker | undefined> {
  try {
    const root = await lstat(layout.installRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || !ownedPrivately(root)) return undefined;
    if (!(await verifyInstalledPackage(layout, identity))) return undefined;
    const marker = await readRuntimeMarker(layout.markerPath, identity);
    return marker !== undefined && await verifyClosureManifest(layout, marker.closureManifestSha256)
      ? marker
      : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyInstalledPackage(layout: RuntimeLayout, identity: RuntimeIdentity): Promise<boolean> {
  try {
    const packageRoot = dirname(layout.packageJsonPath);
    for (const path of [
      join(layout.installRoot, "node_modules"),
      join(layout.installRoot, "node_modules", "@mono-agent"),
      packageRoot,
      join(packageRoot, "dist"),
    ]) {
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink()) return false;
    }
    await assertRegularFile(layout.packageJsonPath, "installed package.json");
    await assertRegularFile(layout.cliPath, "installed CLI");
    await assertRegularFile(layout.packageLockPath, "managed runtime package-lock.json");
    const pkg = JSON.parse(await readFile(layout.packageJsonPath, "utf8")) as Record<string, unknown>;
    if (pkg.name !== PACKAGE_NAME || pkg.version !== identity.packageVersion) return false;
    const packageLock = JSON.parse(await readFile(layout.packageLockPath, "utf8")) as {
      readonly lockfileVersion?: unknown;
      readonly packages?: Record<string, { readonly name?: unknown; readonly version?: unknown }>;
    };
    const locked = Object.entries(packageLock.packages ?? {}).find(([path]) =>
      path === "node_modules/@mono-agent/app"
      || path.endsWith("/node_modules/@mono-agent/app"))?.[1];
    if (typeof packageLock.lockfileVersion !== "number"
      || locked?.version !== identity.packageVersion) return false;
    const [realRoot, realCli] = await Promise.all([realpath(layout.installRoot), realpath(layout.cliPath)]);
    const cliRelative = relative(realRoot, realCli);
    if (cliRelative === "" || cliRelative === ".." || cliRelative.startsWith(`..${sep}`) || resolve(realCli) !== realCli) {
      return false;
    }
    return sha256(await readFile(layout.cliPath)) === identity.cliSha256;
  } catch {
    return false;
  }
}

export async function writeClosureManifest(layout: RuntimeLayout): Promise<string> {
  const manifest = await captureRuntimeClosureManifest(layout);
  const contents = privateJsonContents(manifest);
  await writeFile(layout.closureManifestPath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(layout.closureManifestPath, 0o600);
  return sha256(Buffer.from(contents, "utf8"));
}

export async function verifyClosureManifest(
  layout: RuntimeLayout,
  expectedSha256: string,
  deps: RuntimeClosureManifestCaptureDeps = {},
): Promise<boolean> {
  try {
    await assertRegularFile(layout.closureManifestPath, "managed runtime closure manifest");
    const stored = await fingerprintClosureFile(
      layout.closureManifestPath,
      ".mono-agent-closure.json",
    );
    if (stored.sha256 !== expectedSha256) return false;
    const parsed = JSON.parse(stored.bytes.toString("utf8")) as Partial<RuntimeClosureManifest>;
    if (parsed.schema !== "mono-agent.execution-closure.v1" || !Array.isArray(parsed.entries)) return false;
    const current = await captureRuntimeClosureManifest(layout, deps);
    const storedAfter = await captureFilesystemPathProof(
      layout.closureManifestPath,
      ".mono-agent-closure.json",
    );
    return sameSourceProofEntry(stored.proof, storedAfter)
      && JSON.stringify(parsed) === JSON.stringify(current);
  } catch {
    return false;
  }
}

export async function verifyClosureManifestFingerprint(
  layout: RuntimeLayout,
  expectedSha256: string,
): Promise<boolean> {
  try {
    await assertRegularFile(layout.closureManifestPath, "managed runtime closure manifest");
    const stored = await fingerprintClosureFile(layout.closureManifestPath, ".mono-agent-closure.json");
    if (stored.sha256 !== expectedSha256) return false;
    const parsed = JSON.parse(stored.bytes.toString("utf8")) as Partial<RuntimeClosureManifest>;
    return parsed.schema === "mono-agent.execution-closure.v1" && Array.isArray(parsed.entries);
  } catch {
    return false;
  }
}

export async function verifyManagedRuntimeCliFingerprint(
  layout: RuntimeLayout,
  expectedSha256: string,
): Promise<boolean> {
  try {
    const captured = await fingerprintClosureFile(
      layout.cliPath,
      "node_modules/@mono-agent/app/dist/cli.js",
    );
    return captured.sha256 === expectedSha256;
  } catch {
    return false;
  }
}

export async function verifyManagedRuntimeMaintenanceEntryFingerprint(
  layout: RuntimeLayout,
  expectedSha256: string,
): Promise<boolean> {
  try {
    const captured = await fingerprintClosureFile(
      layout.maintenanceEntryPath,
      `node_modules/@mono-agent/app/dist/${MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE}`,
    );
    return captured.sha256 === expectedSha256;
  } catch {
    return false;
  }
}

async function captureRuntimeClosureManifest(
  layout: RuntimeLayout,
  deps: RuntimeClosureManifestCaptureDeps = {},
): Promise<RuntimeClosureManifest> {
  const entries: RuntimeClosureEntry[] = [];
  const proofs: Array<{
    readonly path: string;
    readonly logicalPath: string;
    readonly proof: SourcePackageProofEntry;
  }> = [];
  const excluded = new Set([resolve(layout.closureManifestPath), resolve(layout.markerPath)]);

  const visit = async (directory: string, logicalPath: string): Promise<SourcePackageProofEntry> => {
    const before = await captureFilesystemPathProof(directory, logicalPath);
    if (before.type !== "directory") {
      throw new Error(`Managed runtime closure directory ${logicalPath} changed type.`);
    }
    const childNames = (await readdir(directory)).sort(compareCodeUnits);
    await mapWithConcurrency(childNames, RUNTIME_FILE_READ_CONCURRENCY, async (name) => {
      const path = join(directory, name);
      if (excluded.has(resolve(path))) return;
      const pathRelative = portableRelativePath(layout.installRoot, path);
      const initial = await captureFilesystemPathProof(path, pathRelative);
      if (initial.type === "symlink") {
        const target = initial.target;
        if (target === undefined) {
          throw new Error(`Managed runtime symlink ${pathRelative} has no target proof.`);
        }
        if (isAbsolute(target)) {
          throw new Error(`Managed runtime symlink ${pathRelative} has an absolute target.`);
        }
        assertPathInsideRoot(layout.installRoot, resolve(dirname(path), target), `symlink ${pathRelative}`);
        entries.push({
          path: pathRelative,
          type: "symlink",
          mode: fileMode(BigInt(initial.mode)),
          target,
        });
        proofs.push({ path, logicalPath: pathRelative, proof: initial });
        return;
      }
      if (initial.type === "directory") {
        const proof = await visit(path, pathRelative);
        entries.push({ path: pathRelative, type: "directory", mode: fileMode(BigInt(proof.mode)) });
        return;
      }
      if (initial.type === "file") {
        const captured = await fingerprintClosureFile(path, pathRelative);
        entries.push({
          path: pathRelative,
          type: "file",
          mode: fileMode(BigInt(captured.proof.mode)),
          sha256: captured.sha256,
        });
        proofs.push({ path, logicalPath: pathRelative, proof: captured.proof });
        return;
      }
      throw new Error(`Managed runtime closure contains unsupported entry ${pathRelative}.`);
    });

    const [after, childNamesAfter] = await Promise.all([
      captureFilesystemPathProof(directory, logicalPath),
      readdir(directory).then((names) => names.sort(compareCodeUnits)),
    ]);
    if (
      after.type !== "directory"
      || !sameSourceProofEntry(before, after)
      || JSON.stringify(childNames) !== JSON.stringify(childNamesAfter)
    ) {
      throw new Error(`Managed runtime closure directory ${logicalPath} changed while it was inspected.`);
    }
    proofs.push({ path: directory, logicalPath, proof: after });
    return after;
  };

  await visit(layout.installRoot, ".");
  await deps.beforeFinalProof?.();
  await mapWithConcurrency(proofs, RUNTIME_REUSE_STAT_CONCURRENCY, async (expected) => {
    const current = await captureFilesystemPathProof(expected.path, expected.logicalPath);
    if (!sameSourceProofEntry(expected.proof, current)) {
      throw new Error(`Managed runtime closure entry ${expected.logicalPath} changed during closure capture.`);
    }
  });
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return { schema: "mono-agent.execution-closure.v1", entries };
}

export function fingerprintClosureFile(path: string, pathRelative: string): ReturnType<typeof fingerprintClosureFileUnbounded> {
  return limitRuntimeRead(() => fingerprintClosureFileUnbounded(path, pathRelative));
}

async function fingerprintClosureFileUnbounded(
  path: string,
  pathRelative: string,
): Promise<{
  readonly sha256: string;
  readonly proof: SourcePackageProofEntry;
  readonly bytes: Buffer;
}> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Managed runtime file ${pathRelative} changed into a symbolic link.`);
    }
    throw error;
  }
  try {
    const before = await limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true }));
    if (!before.isFile()) throw new Error(`Managed runtime entry ${pathRelative} is not a regular file.`);
    if (before.nlink !== 1n) {
      throw new Error(`Managed runtime file ${pathRelative} must not have additional hard links.`);
    }
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([
      limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true })),
      lstat(path, { bigint: true }),
    ]);
    if (
      !after.isFile()
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || after.nlink !== 1n
      || pathAfter.nlink !== 1n
      || !sameSourceStats(before, after)
      || !sameSourceStats(after, pathAfter)
    ) {
      throw new Error(`Managed runtime file ${pathRelative} changed while it was fingerprinted.`);
    }
    return {
      sha256: sha256(bytes),
      proof: sourceProofEntry(pathRelative, "file", after),
      bytes,
    };
  } finally {
    await handle.close();
  }
}

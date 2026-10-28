import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import {
  assertPathInsideRoot,
  captureFilesystemPathProof,
  compareCodeUnits,
  fileMode,
  isErrno,
  isRecord,
  limitRuntimeStat,
  lstat,
  mapWithConcurrency,
  parseJson,
  privateRuntimeDirectory,
  RUNTIME_REUSE_STAT_CONCURRENCY,
  sameSourceProofEntry,
  sameSourceStats,
  sha256,
} from "./inspection-io.js";
import {
  fingerprintClosureFile,
  verifyClosureManifestFingerprint,
  verifyInstalledPackage,
  verifyManagedRuntimeCliFingerprint,
} from "./installed-closure.js";
import { runtimeLayout, verifyPrivateRuntimeAncestors } from "./layout.js";
import {
  PROVISIONAL_RUNTIME_INSTALLED_AT,
  privateJsonContents,
  readPrivateRuntimeMarkerBytes,
  runtimeMarkerFromJson,
  writeFinalizedRuntimeMarker,
} from "./marker.js";
import { captureExecutionClosure } from "./source-closure.js";
import { MANAGED_RUNTIME_MARKER_PACKAGE, RUNTIME_REUSE_PROOF_SCHEMA } from "./types.js";
import type {
  ExecutionClosureCapture,
  ManagedBackgroundRuntimeDeps,
  ManagedRuntimeAdditionalPackage,
  ManagedRuntimeReuseProof,
  RuntimeClosureEntry,
  RuntimeClosureManifest,
  RuntimeClosureReuseProof,
  RuntimeIdentity,
  RuntimeLayout,
  RuntimeMarker,
  RuntimeMarkerV5,
  SourceClosureReuseProof,
  SourcePackageProofEntry,
} from "./types.js";
const MAX_RUNTIME_REUSE_PROOF_BYTES = 64 * 1024 * 1024;

export async function currentSourceReuseProof(
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  expected: ExecutionClosureCapture,
): Promise<SourceClosureReuseProof> {
  if (await verifySourceReuseProofStats(expected.reuseProof)) return expected.reuseProof;
  const current = await captureExecutionClosure(packageSource, additionalPackages);
  if (current.sourceClosureSha256 !== expected.sourceClosureSha256) {
    throw new Error("The managed runtime source closure changed before warm-proof publication.");
  }
  return current.reuseProof;
}

interface FastRuntimeSearchInput {
  readonly home: string;
  readonly versionAbiDir: string;
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly packageSource: string;
  readonly additionalPackages: readonly ManagedRuntimeAdditionalPackage[];
}

export async function findFastReusableRuntime(
  input: FastRuntimeSearchInput,
): Promise<{ readonly layout: RuntimeLayout; readonly identity: RuntimeIdentity } | undefined> {
  let entries;
  try {
    entries = await readdir(input.versionAbiDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const prefix = `${input.cliSha256}-`;
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const sourceClosureSha256 = entry.name.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/u.test(sourceClosureSha256)) continue;
    const identity: RuntimeIdentity = {
      packageVersion: input.packageVersion,
      cliSha256: input.cliSha256,
      sourceClosureSha256,
      nodeAbi: input.nodeAbi,
      platform: input.platform,
      arch: input.arch,
    };
    const layout = runtimeLayout(input.home, identity, "fast-reuse", 0);
    if (await verifyRuntimeFast(
      layout,
      identity,
      input.packageSource,
      input.additionalPackages,
    )) {
      return { layout, identity };
    }
  }
  return undefined;
}

export async function verifyRuntimeFast(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
): Promise<boolean> {
  try {
    const home = dirname(dirname(dirname(dirname(dirname(layout.versionAbiDir)))));
    if (!(await verifyPrivateRuntimeAncestors(home, layout.versionAbiDir))) return false;
    const [initialRoot, initialProofDir] = await Promise.all([
      lstat(layout.installRoot, { bigint: true }),
      lstat(layout.reuseProofDir, { bigint: true }),
    ]);
    if (!privateRuntimeDirectory(initialRoot) || !privateRuntimeDirectory(initialProofDir)) return false;

    const [markerBytes, proofBytes] = await Promise.all([
      readPrivateRuntimeMarkerBytes(layout.markerPath),
      readPrivateRuntimeReuseProofBytes(layout.reuseProofPath),
    ]);
    if (markerBytes === undefined || proofBytes === undefined) return false;
    const marker = runtimeMarkerFromJson(parseJson(markerBytes, "managed runtime marker"), identity);
    if (
      marker?.schema !== "mono-agent.managed-runtime.v5"
      || marker.reuseProofSha256 !== sha256(proofBytes)
    ) {
      return false;
    }
    const proof = runtimeReuseProofFromJson(
      parseJson(proofBytes, "managed runtime reuse proof"),
      identity,
      packageSource,
      additionalPackages,
      marker,
    );
    if (proof === undefined) return false;

    const [installed, cliStable, manifestStable] = await Promise.all([
      verifyInstalledPackage(layout, identity),
      verifyManagedRuntimeCliFingerprint(layout, identity.cliSha256),
      verifyClosureManifestFingerprint(layout, marker.closureManifestSha256),
    ]);
    if (
      !installed
      || !cliStable
      || !manifestStable
      || !(await runtimeReuseProofMatchesManifest(layout, proof.runtime))
    ) {
      return false;
    }

    if (!(await verifyReuseProofStats(layout, proof))) return false;
    if (!(await verifyReuseProofStats(layout, proof))) return false;

    const [markerBytesAfter, proofBytesAfter, finalRoot, finalProofDir] = await Promise.all([
      readPrivateRuntimeMarkerBytes(layout.markerPath),
      readPrivateRuntimeReuseProofBytes(layout.reuseProofPath),
      lstat(layout.installRoot, { bigint: true }),
      lstat(layout.reuseProofDir, { bigint: true }),
    ]);
    return markerBytesAfter !== undefined
      && proofBytesAfter !== undefined
      && markerBytesAfter.equals(markerBytes)
      && proofBytesAfter.equals(proofBytes)
      && privateRuntimeDirectory(finalRoot)
      && privateRuntimeDirectory(finalProofDir)
      && sameSourceStats(initialRoot, finalRoot)
      && sameSourceStats(initialProofDir, finalProofDir);
  } catch {
    return false;
  }
}

export async function publishRuntimeReuseProof(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  source: SourceClosureReuseProof,
  marker: RuntimeMarker,
  deps: ManagedBackgroundRuntimeDeps,
): Promise<void> {
  if (marker.installedAt !== PROVISIONAL_RUNTIME_INSTALLED_AT) {
    throw new Error("A finalized managed runtime launch marker must not be republished.");
  }
  if (!(await verifySourceReuseProofStats(source))) {
    throw new Error("The managed runtime source closure changed before warm-proof publication.");
  }
  const runtime = await captureRuntimeClosureReuseProof(layout, marker);
  const proof: ManagedRuntimeReuseProof = {
    schema: RUNTIME_REUSE_PROOF_SCHEMA,
    identity,
    packageSource,
    additionalPackages,
    source,
    runtime,
  };
  const contents = privateJsonContents(proof);
  const bytes = Buffer.from(contents, "utf8");
  if (bytes.length > MAX_RUNTIME_REUSE_PROOF_BYTES) {
    throw new Error("The managed runtime warm-reuse proof exceeds its safe size limit.");
  }
  const nextMarker: RuntimeMarkerV5 = {
    schema: "mono-agent.managed-runtime.v5",
    packageName: MANAGED_RUNTIME_MARKER_PACKAGE,
    packageVersion: identity.packageVersion,
    cliSha256: identity.cliSha256,
    sourceClosureSha256: identity.sourceClosureSha256,
    nodeAbi: identity.nodeAbi,
    platform: identity.platform,
    arch: identity.arch,
    closureManifestSha256: marker.closureManifestSha256,
    executionProofSha256: marker.executionProofSha256,
    reuseProofSha256: sha256(bytes),
    installedAt: marker.installedAt,
  };
  if (runtimeReuseProofFromJson(
    parseJson(bytes, "managed runtime reuse proof"),
    identity,
    packageSource,
    additionalPackages,
    nextMarker,
  ) === undefined) {
    throw new Error(
      "The generated managed runtime warm-reuse proof was rejected by its validator. " +
      "No proof was published; reinstall the CLI and report this producer/validator mismatch if it persists.",
    );
  }
  await ensurePrivateReuseProofDirectory(layout.reuseProofDir);
  await writeFile(layout.reuseProofPath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(layout.reuseProofPath, 0o600);
  const stored = await readPrivateRuntimeReuseProofBytes(layout.reuseProofPath);
  if (stored === undefined || !stored.equals(bytes)) {
    throw new Error("The managed runtime warm-reuse proof changed while it was published.");
  }

  await writeFinalizedRuntimeMarker(layout.markerPath, nextMarker, deps);
  if (!(await verifySourceReuseProofStats(source))) {
    throw new Error("The managed runtime source closure changed during warm-proof publication.");
  }
}

async function captureRuntimeClosureReuseProof(
  layout: RuntimeLayout,
  marker: RuntimeMarker,
): Promise<RuntimeClosureReuseProof> {
  const stored = await fingerprintClosureFile(layout.closureManifestPath, ".mono-agent-closure.json");
  if (stored.sha256 !== marker.closureManifestSha256) {
    throw new Error("The managed runtime closure manifest changed before warm-proof capture.");
  }
  const manifest = runtimeClosureManifestFromJson(parseJson(stored.bytes, "managed runtime closure manifest"));
  if (manifest === undefined) throw new Error("The managed runtime closure manifest is malformed.");
  const excludedRootEntries = new Set([".mono-agent-closure.json", ".mono-agent-runtime.json"]);
  const rootEntries = (await readdir(layout.installRoot))
    .filter((name) => !excludedRootEntries.has(name))
    .sort(compareCodeUnits);
  const entries = await mapWithConcurrency(
    manifest.entries,
    RUNTIME_REUSE_STAT_CONCURRENCY,
    async (entry) => ({
      path: entry.path,
      proof: await captureFilesystemPathProof(
        runtimePathFromPortableRelative(layout.installRoot, entry.path),
        entry.path,
      ),
    }),
  );
  const result: RuntimeClosureReuseProof = {
    rootEntries,
    entries,
    closureManifestSha256: marker.closureManifestSha256,
    executionProofSha256: marker.executionProofSha256,
  };
  if (!(await verifyRuntimeReuseProofStats(layout, result))) {
    throw new Error("The managed runtime closure changed during warm-proof capture.");
  }
  return result;
}

async function verifyReuseProofStats(
  layout: RuntimeLayout,
  proof: ManagedRuntimeReuseProof,
): Promise<boolean> {
  const [sourceValid, runtimeValid] = await Promise.all([
    verifySourceReuseProofStats(proof.source),
    verifyRuntimeReuseProofStats(layout, proof.runtime),
  ]);
  return sourceValid && runtimeValid;
}

async function verifySourceReuseProofStats(proof: SourceClosureReuseProof): Promise<boolean> {
  try {
    const targets = [
      ...proof.packages.flatMap((pkg) => pkg.entries.map((entry) => ({
        path: entry.path === "."
          ? pkg.sourceRoot
          : runtimePathFromPortableRelative(pkg.sourceRoot, entry.path),
        logicalPath: entry.path,
        proof: entry,
      }))),
      ...proof.links,
    ];
    const matches = await mapWithConcurrency(targets, RUNTIME_REUSE_STAT_CONCURRENCY, async (target) => {
      const current = await captureFilesystemPathProof(target.path, target.logicalPath);
      return sameSourceProofEntry(target.proof, current);
    });
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

async function verifyRuntimeReuseProofStats(
  layout: RuntimeLayout,
  proof: RuntimeClosureReuseProof,
): Promise<boolean> {
  try {
    const excludedRootEntries = new Set([".mono-agent-closure.json", ".mono-agent-runtime.json"]);
    const rootEntries = (await readdir(layout.installRoot))
      .filter((name) => !excludedRootEntries.has(name))
      .sort(compareCodeUnits);
    if (JSON.stringify(rootEntries) !== JSON.stringify(proof.rootEntries)) return false;
    const matches = await mapWithConcurrency(proof.entries, RUNTIME_REUSE_STAT_CONCURRENCY, async (entry) => {
      const current = await captureFilesystemPathProof(
        runtimePathFromPortableRelative(layout.installRoot, entry.path),
        entry.path,
      );
      return sameSourceProofEntry(entry.proof, current);
    });
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

async function runtimeReuseProofMatchesManifest(
  layout: RuntimeLayout,
  proof: RuntimeClosureReuseProof,
): Promise<boolean> {
  try {
    const bytes = await readFile(layout.closureManifestPath);
    if (sha256(bytes) !== proof.closureManifestSha256) return false;
    const manifest = runtimeClosureManifestFromJson(parseJson(bytes, "managed runtime closure manifest"));
    if (manifest === undefined || manifest.entries.length !== proof.entries.length) return false;
    return manifest.entries.every((entry, index) => {
      const proven = proof.entries[index];
      return proven !== undefined
        && proven.path === entry.path
        && proven.proof.type === entry.type
        && fileMode(BigInt(proven.proof.mode)) === entry.mode
        && (entry.type !== "symlink" || proven.proof.target === entry.target);
    });
  } catch {
    return false;
  }
}

async function ensurePrivateReuseProofDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
    if (!isErrno(error, "EEXIST")) throw error;
  });
  const details = await lstat(path, { bigint: true });
  if (!privateRuntimeDirectory(details)) {
    throw new Error(`Managed runtime reuse-proof directory ${path} must be owner-private.`);
  }
  await chmod(path, 0o700);
}

async function readPrivateRuntimeReuseProofBytes(path: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true }));
    if (!privateRuntimeReuseProofFile(before)) return undefined;
    const bytes = await handle.readFile();
    const [after, named] = await Promise.all([
      limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true })),
      lstat(path, { bigint: true }),
    ]);
    if (
      !privateRuntimeReuseProofFile(after)
      || !privateRuntimeReuseProofFile(named)
      || !sameSourceStats(before, after)
      || !sameSourceStats(before, named)
    ) {
      return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function privateRuntimeReuseProofFile(details: BigIntStats): boolean {
  const owned = typeof process.getuid !== "function" || details.uid === BigInt(process.getuid());
  return details.isFile()
    && !details.isSymbolicLink()
    && details.nlink === 1n
    && details.size <= BigInt(MAX_RUNTIME_REUSE_PROOF_BYTES)
    && (details.mode & 0o077n) === 0n
    && owned;
}

function runtimeReuseProofFromJson(
  value: unknown,
  identity: RuntimeIdentity,
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  marker: RuntimeMarkerV5,
): ManagedRuntimeReuseProof | undefined {
  if (!hasExactKeys(value, ["schema", "identity", "packageSource", "additionalPackages", "source", "runtime"])) {
    return undefined;
  }
  if (
    value.schema !== RUNTIME_REUSE_PROOF_SCHEMA
    || !sameRuntimeIdentityJson(value.identity, identity)
    || value.packageSource !== packageSource
    || !Array.isArray(value.additionalPackages)
    || JSON.stringify(value.additionalPackages) !== JSON.stringify(additionalPackages)
  ) {
    return undefined;
  }
  const source = sourceClosureReuseProofFromJson(value.source, packageSource);
  const runtime = runtimeClosureReuseProofFromJson(value.runtime, marker);
  return source === undefined || runtime === undefined
    ? undefined
    : {
        schema: RUNTIME_REUSE_PROOF_SCHEMA,
        identity,
        packageSource,
        additionalPackages,
        source,
        runtime,
      };
}

function sourceClosureReuseProofFromJson(
  value: unknown,
  packageSource: string,
): SourceClosureReuseProof | undefined {
  if (!hasExactKeys(value, ["sourceProofSha256", "packages", "links"])) return undefined;
  if (
    typeof value.sourceProofSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.sourceProofSha256)
    || !Array.isArray(value.packages)
    || !Array.isArray(value.links)
  ) {
    return undefined;
  }
  const packages: Array<SourceClosureReuseProof["packages"][number]> = [];
  const roots = new Set<string>();
  for (const [index, rawPackage] of value.packages.entries()) {
    if (!hasExactKeys(rawPackage, ["id", "sourceRoot", "entries"])) return undefined;
    if (
      rawPackage.id !== index
      || typeof rawPackage.sourceRoot !== "string"
      || !isCanonicalAbsolutePath(rawPackage.sourceRoot)
      || roots.has(rawPackage.sourceRoot)
      || !Array.isArray(rawPackage.entries)
    ) {
      return undefined;
    }
    const entries = proofEntriesFromJson(rawPackage.entries, true);
    if (entries === undefined || entries[0]?.path !== ".") return undefined;
    roots.add(rawPackage.sourceRoot);
    packages.push({ id: index, sourceRoot: rawPackage.sourceRoot, entries });
  }
  if (packages[0]?.sourceRoot !== packageSource) return undefined;

  const links: Array<SourceClosureReuseProof["links"][number]> = [];
  const linkPaths = new Set<string>();
  for (const rawLink of value.links) {
    if (!hasExactKeys(rawLink, ["path", "logicalPath", "proof"])) return undefined;
    if (
      typeof rawLink.path !== "string"
      || !isCanonicalAbsolutePath(rawLink.path)
      || linkPaths.has(rawLink.path)
      || typeof rawLink.logicalPath !== "string"
      || rawLink.logicalPath.length === 0
    ) {
      return undefined;
    }
    const proof = sourceProofEntryFromJson(rawLink.proof);
    if (proof === undefined || proof.path !== rawLink.logicalPath) return undefined;
    linkPaths.add(rawLink.path);
    links.push({ path: rawLink.path, logicalPath: rawLink.logicalPath, proof });
  }
  return { sourceProofSha256: value.sourceProofSha256, packages, links };
}

function runtimeClosureReuseProofFromJson(
  value: unknown,
  marker: RuntimeMarkerV5,
): RuntimeClosureReuseProof | undefined {
  if (!hasExactKeys(value, [
    "rootEntries",
    "entries",
    "closureManifestSha256",
    "executionProofSha256",
  ])) return undefined;
  if (
    value.closureManifestSha256 !== marker.closureManifestSha256
    || value.executionProofSha256 !== marker.executionProofSha256
    || !Array.isArray(value.rootEntries)
    || !Array.isArray(value.entries)
  ) {
    return undefined;
  }
  const rootEntries: string[] = [];
  const rootNames = new Set<string>();
  for (const name of value.rootEntries) {
    if (
      typeof name !== "string"
      || name.length === 0
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
      || name.includes("\0")
      || rootNames.has(name)
      || name === ".mono-agent-closure.json"
      || name === ".mono-agent-runtime.json"
    ) {
      return undefined;
    }
    rootNames.add(name);
    rootEntries.push(name);
  }
  if (JSON.stringify(rootEntries) !== JSON.stringify([...rootEntries].sort(compareCodeUnits))) return undefined;

  const entries: Array<RuntimeClosureReuseProof["entries"][number]> = [];
  const entryPaths = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!hasExactKeys(rawEntry, ["path", "proof"])) return undefined;
    if (
      typeof rawEntry.path !== "string"
      || !isSafePortableRelativePath(rawEntry.path)
      || entryPaths.has(rawEntry.path)
    ) {
      return undefined;
    }
    const proof = sourceProofEntryFromJson(rawEntry.proof);
    if (proof === undefined || proof.path !== rawEntry.path) return undefined;
    entryPaths.add(rawEntry.path);
    entries.push({ path: rawEntry.path, proof });
  }
  return {
    rootEntries,
    entries,
    closureManifestSha256: marker.closureManifestSha256,
    executionProofSha256: marker.executionProofSha256,
  };
}

function runtimeClosureManifestFromJson(value: unknown): RuntimeClosureManifest | undefined {
  if (!hasExactKeys(value, ["schema", "entries"]) || value.schema !== "mono-agent.execution-closure.v1") {
    return undefined;
  }
  if (!Array.isArray(value.entries)) return undefined;
  const entries: RuntimeClosureEntry[] = [];
  const paths = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!isRecord(rawEntry) || typeof rawEntry.type !== "string") return undefined;
    const expectedKeys = rawEntry.type === "file"
      ? ["path", "type", "mode", "sha256"]
      : rawEntry.type === "symlink"
        ? ["path", "type", "mode", "target"]
        : ["path", "type", "mode"];
    if (
      !hasExactKeys(rawEntry, expectedKeys)
      || typeof rawEntry.path !== "string"
      || !isSafePortableRelativePath(rawEntry.path)
      || paths.has(rawEntry.path)
      || typeof rawEntry.mode !== "string"
      || !/^0[0-7]{3}$/u.test(rawEntry.mode)
    ) {
      return undefined;
    }
    if (rawEntry.type === "file") {
      if (typeof rawEntry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(rawEntry.sha256)) return undefined;
      entries.push({ path: rawEntry.path, type: "file", mode: rawEntry.mode, sha256: rawEntry.sha256 });
    } else if (rawEntry.type === "symlink") {
      if (typeof rawEntry.target !== "string" || rawEntry.target.includes("\0")) return undefined;
      entries.push({ path: rawEntry.path, type: "symlink", mode: rawEntry.mode, target: rawEntry.target });
    } else if (rawEntry.type === "directory") {
      entries.push({ path: rawEntry.path, type: "directory", mode: rawEntry.mode });
    } else {
      return undefined;
    }
    paths.add(rawEntry.path);
  }
  return { schema: "mono-agent.execution-closure.v1", entries };
}

function proofEntriesFromJson(
  values: readonly unknown[],
  allowRoot: boolean,
): readonly SourcePackageProofEntry[] | undefined {
  const entries: SourcePackageProofEntry[] = [];
  const paths = new Set<string>();
  for (const value of values) {
    const entry = sourceProofEntryFromJson(value);
    if (
      entry === undefined
      || (entry.path !== "." && !isSafePortableRelativePath(entry.path))
      || (!allowRoot && entry.path === ".")
      || paths.has(entry.path)
    ) {
      return undefined;
    }
    paths.add(entry.path);
    entries.push(entry);
  }
  return entries;
}

function sourceProofEntryFromJson(value: unknown): SourcePackageProofEntry | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type;
  const expectedKeys = type === "symlink"
    ? ["path", "type", "dev", "ino", "nlink", "mode", "size", "mtimeNs", "ctimeNs", "target"]
    : ["path", "type", "dev", "ino", "nlink", "mode", "size", "mtimeNs", "ctimeNs"];
  if (
    !hasExactKeys(value, expectedKeys)
    || typeof value.path !== "string"
    || (type !== "directory" && type !== "file" && type !== "symlink")
    || ![value.dev, value.ino, value.nlink, value.mode, value.size, value.mtimeNs, value.ctimeNs]
      .every((entry) => typeof entry === "string" && /^-?\d+$/u.test(entry))
    || (type === "symlink" && (typeof value.target !== "string" || value.target.includes("\0")))
  ) {
    return undefined;
  }
  return value as unknown as SourcePackageProofEntry;
}

function sameRuntimeIdentityJson(value: unknown, identity: RuntimeIdentity): boolean {
  return hasExactKeys(value, ["packageVersion", "cliSha256", "sourceClosureSha256", "nodeAbi", "platform", "arch"])
    && value.packageVersion === identity.packageVersion
    && value.cliSha256 === identity.cliSha256
    && value.sourceClosureSha256 === identity.sourceClosureSha256
    && value.nodeAbi === identity.nodeAbi
    && value.platform === identity.platform
    && value.arch === identity.arch;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !path.includes("\0");
}

function isSafePortableRelativePath(path: string): boolean {
  if (path.length === 0 || path === "." || path.includes("\\") || path.includes("\0") || isAbsolute(path)) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function runtimePathFromPortableRelative(root: string, path: string): string {
  if (!isSafePortableRelativePath(path)) {
    throw new Error(`Managed runtime proof path ${JSON.stringify(path)} is unsafe.`);
  }
  const target = join(root, ...path.split("/"));
  assertPathInsideRoot(root, target, `proof path ${path}`);
  return target;
}

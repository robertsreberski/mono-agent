import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { accountHomeDirectory } from "./account-home.js";
import { isBackgroundOperationalEnvName } from "./background-environment.js";
import {
  currentProcessIncarnation,
  isSameProcessIncarnation as matchesProcessIncarnation,
  processIncarnationFromJson,
} from "./process-incarnation.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";

const PACKAGE_NAME = "@mono-agent/agent-app";
export const MANAGED_BACKGROUND_WORKER_ENV = "MONO_AGENT_MANAGED_WORKER";
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_STALE_AFTER_MS = 5 * 60_000;
const LOCK_POLL_INTERVAL_MS = 200;

export interface ManagedBackgroundRuntime {
  readonly cliPath: string;
  readonly nodePath: string;
  readonly installRoot: string;
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly nodeAbi: string;
}

/** One config-selected package that is loaded dynamically rather than declared by agent-app. */
export interface ManagedRuntimeAdditionalPackage {
  readonly packageName: string;
  /** Resolved package root containing package.json (not a node_modules symlink). */
  readonly packageSource: string;
}

export interface ManagedBackgroundRuntimeInput {
  /** The CLI currently executing. Its exact bytes are the trust anchor. */
  readonly currentCliPath: string;
  readonly nodePath: string;
  readonly homeDir?: string;
  readonly packageVersion?: string;
  readonly nodeAbi?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Test/packaging seam; defaults to the package root containing currentCliPath. */
  readonly packageSource?: string;
  /** Config-selected channel/memory plugin packages that must survive outside the caller's install tree. */
  readonly additionalPackages?: readonly ManagedRuntimeAdditionalPackage[];
}

export interface ManagedRuntimeInstallInput {
  readonly stagingDir: string;
  readonly packageVersion: string;
  readonly packageSource: string;
  readonly nodePath: string;
  readonly additionalPackages: readonly ManagedRuntimeAdditionalPackage[];
  readonly expectedSourceClosureSha256: string;
}

export interface ManagedBackgroundRuntimeDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly randomId: () => string;
  readonly installPackage: (input: ManagedRuntimeInstallInput) => Promise<void>;
  /** Test/embed seams for persistent install-lock ownership. */
  readonly currentProcessIncarnation?: () => Promise<ProcessIncarnation>;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
}

interface RuntimeIdentity {
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly sourceClosureSha256: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

interface RuntimeLayout {
  readonly versionAbiDir: string;
  readonly installRoot: string;
  readonly cliPath: string;
  readonly packageJsonPath: string;
  readonly packageLockPath: string;
  readonly closureManifestPath: string;
  readonly markerPath: string;
  readonly lockDir: string;
  readonly stagingDir: string;
  readonly quarantineDir: string;
}

interface RuntimeLockIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface RuntimeMarker extends RuntimeIdentity {
  readonly schema: "mono-agent.managed-runtime.v3";
  readonly packageName: typeof PACKAGE_NAME;
  readonly closureManifestSha256: string;
  readonly installedAt: string;
}

interface RuntimeClosureManifest {
  readonly schema: "mono-agent.execution-closure.v1";
  readonly entries: readonly RuntimeClosureEntry[];
}

type RuntimeClosureEntry =
  | { readonly path: string; readonly type: "directory"; readonly mode: string }
  | { readonly path: string; readonly type: "file"; readonly mode: string; readonly sha256: string }
  | { readonly path: string; readonly type: "symlink"; readonly mode: string; readonly target: string };

interface InstalledPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: ReadonlySet<string>;
}

interface ExecutionClosureNode {
  readonly id: number;
  readonly sourceRoot: string;
  readonly metadata: InstalledPackageMetadata;
  readonly dependencies: ReadonlyMap<string, number>;
  readonly sourcePackage: SourcePackageManifest;
}

interface MutableExecutionClosureNode {
  readonly id: number;
  readonly sourceRoot: string;
  readonly metadata: InstalledPackageMetadata;
  readonly dependencies: Map<string, number>;
  readonly sourcePackage: SourcePackageManifest;
}

interface ExecutionClosureCapture {
  readonly nodes: readonly ExecutionClosureNode[];
  readonly additionalRoots: readonly { readonly packageName: string; readonly nodeId: number }[];
  readonly sourceClosureSha256: string;
  readonly sourceProofSha256: string;
}

interface SourcePackageManifest {
  readonly schema: "mono-agent.source-package.v1";
  readonly entries: readonly SourcePackageEntry[];
}

type SourcePackageEntry =
  | { readonly path: string; readonly type: "directory"; readonly mode: string }
  | { readonly path: string; readonly type: "file"; readonly mode: string; readonly sha256: string }
  | { readonly path: string; readonly type: "symlink"; readonly mode: string; readonly target: string };

interface SourcePackageCapture {
  readonly manifest: SourcePackageManifest;
  readonly proof: readonly SourcePackageProofEntry[];
  readonly packageJson: Buffer;
}

interface SourcePackageProofEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly target?: string;
}

export function defaultManagedBackgroundRuntimeDeps(): ManagedBackgroundRuntimeDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    randomId: () => randomUUID(),
    installPackage: materializeExactExecutionClosure,
    currentProcessIncarnation,
    isSameProcessIncarnation: matchesProcessIncarnation,
  };
}

/**
 * launchd can retain a user's historical environment independently of the
 * plist. Strip it before dotenv loading so the worker observes only the
 * reviewed operational allowlist plus the selected dotenv file.
 */
export function sanitizeManagedBackgroundWorkerEnvironment(
  env: Record<string, string | undefined>,
): void {
  if (env[MANAGED_BACKGROUND_WORKER_ENV] !== "1") return;
  for (const name of Object.keys(env)) {
    if (name !== MANAGED_BACKGROUND_WORKER_ENV && !isBackgroundOperationalEnvName(name)) {
      delete env[name];
    }
  }
  // The marker has served its only purpose and must not enter config loading as
  // an apparent MONO_AGENT_* override.
  delete env[MANAGED_BACKGROUND_WORKER_ENV];
}

/**
 * Materialize the currently executing published CLI into a private, immutable
 * runtime outside npm/npx's disposable cache. A runtime is accepted only when
 * the exact installed CLI bytes match the caller, not merely when its package
 * version matches.
 */
export async function ensureManagedBackgroundRuntime(
  input: ManagedBackgroundRuntimeInput,
  deps: ManagedBackgroundRuntimeDeps = defaultManagedBackgroundRuntimeDeps(),
): Promise<ManagedBackgroundRuntime> {
  const currentCliPath = resolve(input.currentCliPath);
  await assertRegularFile(currentCliPath, "current mono-agent CLI");
  await assertRegularFile(resolve(input.nodePath), "managed runtime Node executable");
  const currentCli = await readFile(currentCliPath);
  const packageSource = resolve(input.packageSource ?? packageRootForCli(currentCliPath));
  const sourceDetails = await lstat(packageSource);
  if (!sourceDetails.isDirectory() || sourceDetails.isSymbolicLink()) {
    throw new Error(`Managed runtime package source ${packageSource} must be a real directory.`);
  }
  const additionalPackages = await canonicalAdditionalPackages(input.additionalPackages ?? []);
  const sourceClosure = await captureExecutionClosure(packageSource, additionalPackages);
  const packageVersion = input.packageVersion ?? await packageVersionAt(packageSource);
  if (!isExactVersion(packageVersion)) {
    throw new Error(`Cannot install a durable managed runtime for invalid package version ${JSON.stringify(packageVersion)}.`);
  }
  const identity: RuntimeIdentity = {
    packageVersion,
    cliSha256: sha256(currentCli),
    sourceClosureSha256: sourceClosure.sourceClosureSha256,
    nodeAbi: input.nodeAbi ?? requiredNodeAbi(),
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
  };
  const home = resolve(input.homeDir ?? accountHomeDirectory());
  const id = safeSegment(deps.randomId());
  const layout = runtimeLayout(home, identity, id, deps.now());
  await ensurePrivateRuntimeAncestors(home, layout.versionAbiDir);

  if (await verifyRuntime(layout, identity)) {
    return runtimeResult(layout, identity, input.nodePath);
  }

  const acquired = await acquireRuntimeLock(layout, identity, deps);
  if (!acquired) {
    // Another installer may have completed between the final lock poll and the
    // timeout boundary. Verify one last time before reporting the contention.
    if (await verifyRuntime(layout, identity)) {
      return runtimeResult(layout, identity, input.nodePath);
    }
    throw new Error(`Timed out waiting for the managed runtime installation lock at ${layout.lockDir}.`);
  }

  try {
    if (await verifyRuntime(layout, identity)) {
      return runtimeResult(layout, identity, input.nodePath);
    }
    await assertSourceClosureUnchanged(packageSource, additionalPackages, sourceClosure, "before staging");
    await rm(layout.stagingDir, { recursive: true, force: true });
    await mkdir(layout.stagingDir, { recursive: false, mode: 0o700 });
    await chmod(layout.stagingDir, 0o700);
    await writePrivateJson(join(layout.stagingDir, "package.json"), {
      name: "mono-agent-managed-runtime",
      private: true,
      version: "0.0.0",
    });

    try {
      await deps.installPackage({
        stagingDir: layout.stagingDir,
        packageVersion,
        packageSource,
        nodePath: resolve(input.nodePath),
        additionalPackages,
        expectedSourceClosureSha256: identity.sourceClosureSha256,
      });
      await assertSourceClosureUnchanged(packageSource, additionalPackages, sourceClosure, "while staging");
      const staged = runtimeLayoutForRoot(layout, layout.stagingDir);
      if (!(await verifyInstalledPackage(staged, identity))) {
        throw new Error(
          `Installed ${PACKAGE_NAME}@${packageVersion} does not match the executing CLI SHA-256 ${identity.cliSha256}.`,
        );
      }
      const closureManifestSha256 = await writeClosureManifest(staged);
      const marker: RuntimeMarker = {
        schema: "mono-agent.managed-runtime.v3",
        packageName: PACKAGE_NAME,
        closureManifestSha256,
        ...identity,
        installedAt: new Date(deps.now()).toISOString(),
      };
      await writePrivateJson(staged.markerPath, marker);
      await chmod(layout.stagingDir, 0o700);
      // Build and verify the replacement completely before moving an invalid
      // runtime aside. This is essential when the executing CLI (and therefore
      // packageSource) lives inside that invalid runtime: quarantine must never
      // make the only repair source disappear halfway through installation.
      await quarantineInvalidRuntime(layout, identity, deps);
      await promoteStaging(layout, staged, identity);
    } catch (error) {
      await rm(layout.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    if (!(await verifyRuntime(layout, identity))) {
      throw new Error("The managed runtime failed verification after atomic promotion.");
    }
    return runtimeResult(layout, identity, input.nodePath);
  } finally {
    await removeSameRuntimeLockDirectory(layout.lockDir, acquired).catch(() => undefined);
  }
}

/**
 * Copy the exact package graph the current CLI is already executing.
 *
 * Deliberately do not invoke npm here. A fresh npm install both re-resolves
 * semver ranges (so it is not the executing dependency closure) and runs
 * lifecycle scripts after the CLI has loaded agent dotenv credentials. Direct
 * graph materialisation also understands pnpm's workspace links without ever
 * handing `workspace:` ranges to npm.
 */
async function materializeExactExecutionClosure(input: ManagedRuntimeInstallInput): Promise<void> {
  const captured = await captureExecutionClosure(input.packageSource, input.additionalPackages);
  if (captured.sourceClosureSha256 !== input.expectedSourceClosureSha256) {
    throw new Error("The managed runtime package closure changed before staging began.");
  }
  const closure = captured.nodes;
  const root = closure[0];
  if (root === undefined || root.metadata.name !== PACKAGE_NAME || root.metadata.version !== input.packageVersion) {
    throw new Error(
      `Cannot preserve ${PACKAGE_NAME}@${input.packageVersion}: the executing package closure has an unexpected root.`,
    );
  }

  const destinations = new Map<number, string>();
  for (const node of closure) {
    const destination = executionClosureDestination(input.stagingDir, node);
    destinations.set(node.id, destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(node.sourceRoot, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (source) => shouldCopyPackagePath(node.sourceRoot, source),
    });
  }

  // `cp` is not a transaction: source paths can be replaced while it walks.
  // Compare every copied package against the exact pre-copy package manifest
  // before any staged runtime can receive a marker or be promoted.
  for (const node of closure) {
    const destination = requiredMapValue(destinations, node.id, "package destination");
    const copied = await captureSourcePackage(destination);
    if (JSON.stringify(copied.manifest) !== JSON.stringify(node.sourcePackage)) {
      throw new Error(`Managed runtime source package ${node.metadata.name} changed while it was copied.`);
    }
  }

  for (const node of closure) {
    const destination = requiredMapValue(destinations, node.id, "package destination");
    for (const [dependencyName, dependencyId] of [...node.dependencies].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const dependencyDestination = requiredMapValue(destinations, dependencyId, "dependency destination");
      const linkPath = join(destination, "node_modules", ...packageNameSegments(dependencyName));
      await mkdir(dirname(linkPath), { recursive: true, mode: 0o700 });
      await symlink(relative(dirname(linkPath), dependencyDestination), linkPath, "dir");
    }
  }

  for (const additional of captured.additionalRoots) {
    const destination = requiredMapValue(destinations, additional.nodeId, "additional package destination");
    const linkPath = join(input.stagingDir, "node_modules", ...packageNameSegments(additional.packageName));
    await mkdir(dirname(linkPath), { recursive: true, mode: 0o700 });
    await symlink(relative(dirname(linkPath), destination), linkPath, "dir");
  }

  const packages = Object.fromEntries(closure.map((node) => {
    const destination = requiredMapValue(destinations, node.id, "package destination");
    return [portableRelativePath(input.stagingDir, destination), {
      name: node.metadata.name,
      version: node.metadata.version,
      dependencies: Object.fromEntries([...node.dependencies].sort(([left], [right]) => left.localeCompare(right)).map(
        ([dependencyName, dependencyId]) => [
          dependencyName,
          requiredClosureNode(closure, dependencyId).metadata.version,
        ],
      )),
    }];
  }));
  const additionalLinks = Object.fromEntries(captured.additionalRoots.map((additional) => {
    const destination = requiredMapValue(destinations, additional.nodeId, "additional package destination");
    const linkPath = join(input.stagingDir, "node_modules", ...packageNameSegments(additional.packageName));
    return [portableRelativePath(input.stagingDir, linkPath), {
      link: true,
      resolved: portableRelativePath(input.stagingDir, destination),
    }];
  }));
  await writePrivateJson(join(input.stagingDir, "package-lock.json"), {
    name: "mono-agent-managed-runtime",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "mono-agent-managed-runtime", version: "0.0.0", private: true },
      ...packages,
      ...additionalLinks,
    },
  });

  const after = await captureExecutionClosure(input.packageSource, input.additionalPackages);
  if (
    after.sourceClosureSha256 !== captured.sourceClosureSha256
    || after.sourceProofSha256 !== captured.sourceProofSha256
  ) {
    throw new Error("The managed runtime package closure changed while it was staged.");
  }
}

async function captureExecutionClosure(
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
): Promise<ExecutionClosureCapture> {
  const nodes: MutableExecutionClosureNode[] = [];
  const bySourceRoot = new Map<string, number>();
  const proofs = new Map<number, readonly SourcePackageProofEntry[]>();

  const visit = async (source: string): Promise<number> => {
    const sourceRoot = await realpath(source);
    const existing = bySourceRoot.get(sourceRoot);
    if (existing !== undefined) return existing;

    const sourcePackage = await captureSourcePackage(sourceRoot);
    const metadata = readInstalledPackageMetadata(sourceRoot, sourcePackage.packageJson);
    const id = nodes.length;
    const node: MutableExecutionClosureNode = {
      id,
      sourceRoot,
      metadata,
      dependencies: new Map(),
      sourcePackage: sourcePackage.manifest,
    };
    nodes.push(node);
    proofs.set(id, sourcePackage.proof);
    bySourceRoot.set(sourceRoot, id);

    for (const [dependencyName, optional] of dependencyRequirements(metadata)) {
      const dependencyRoot = await resolveInstalledDependencyPackageRoot(sourceRoot, dependencyName);
      if (dependencyRoot === undefined) {
        if (optional) continue;
        throw new Error(
          `Cannot preserve the executing dependency closure: ${metadata.name}@${metadata.version} ` +
          `cannot resolve required dependency ${dependencyName}. Build or install the package completely before starting it.`,
        );
      }
      node.dependencies.set(dependencyName, await visit(dependencyRoot));
    }
    return id;
  };

  await visit(packageSource);
  const additionalRoots: { packageName: string; nodeId: number }[] = [];
  for (const additional of additionalPackages) {
    const nodeId = await visit(additional.packageSource);
    const node = requiredClosureNode(nodes, nodeId);
    if (node.metadata.name !== additional.packageName) {
      throw new Error(
        `Additional managed runtime package ${additional.packageSource} declares ${node.metadata.name}, ` +
        `expected ${additional.packageName}.`,
      );
    }
    additionalRoots.push({ packageName: additional.packageName, nodeId });
  }

  const closure = nodes as readonly ExecutionClosureNode[];
  const stable = {
    schema: "mono-agent.source-execution-closure.v1",
    roots: {
      agentApp: 0,
      additional: additionalRoots,
    },
    packages: closure.map((node) => ({
      id: node.id,
      name: node.metadata.name,
      version: node.metadata.version,
      dependencies: [...node.dependencies]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, nodeId]) => ({ name, nodeId })),
      sourcePackage: node.sourcePackage,
    })),
  };
  const proof = {
    schema: "mono-agent.source-execution-proof.v1",
    stable,
    packages: closure.map((node) => ({
      id: node.id,
      sourceRoot: node.sourceRoot,
      entries: requiredMapValue(proofs, node.id, "source package proof"),
    })),
  };
  return {
    nodes: closure,
    additionalRoots,
    sourceClosureSha256: sha256(Buffer.from(JSON.stringify(stable), "utf8")),
    sourceProofSha256: sha256(Buffer.from(JSON.stringify(proof), "utf8")),
  };
}

async function canonicalAdditionalPackages(
  packages: readonly ManagedRuntimeAdditionalPackage[],
): Promise<readonly ManagedRuntimeAdditionalPackage[]> {
  const byName = new Map<string, string>();
  for (const entry of packages) {
    packageNameSegments(entry.packageName);
    if (entry.packageName === PACKAGE_NAME) {
      throw new Error(`${PACKAGE_NAME} is already the managed runtime root and cannot be added again.`);
    }
    const lexical = resolve(entry.packageSource);
    const lexicalDetails = await lstat(lexical);
    if (!lexicalDetails.isDirectory() || lexicalDetails.isSymbolicLink()) {
      throw new Error(`Additional managed runtime package source ${lexical} must be a real directory.`);
    }
    const canonical = await realpath(lexical);
    const existing = byName.get(entry.packageName);
    if (existing !== undefined && existing !== canonical) {
      throw new Error(
        `Additional managed runtime package ${entry.packageName} was resolved to two different sources: ` +
        `${existing} and ${canonical}.`,
      );
    }
    byName.set(entry.packageName, canonical);
  }
  return [...byName]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, packageSource]) => ({ packageName, packageSource }));
}

async function assertSourceClosureUnchanged(
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  expected: ExecutionClosureCapture,
  phase: string,
): Promise<void> {
  const current = await captureExecutionClosure(packageSource, additionalPackages);
  if (
    current.sourceClosureSha256 !== expected.sourceClosureSha256
    || current.sourceProofSha256 !== expected.sourceProofSha256
  ) {
    throw new Error(`The managed runtime package closure changed ${phase}; no staged runtime was promoted.`);
  }
}

/**
 * Capture exactly the package-owned files copied by `materializeExactExecutionClosure`.
 * `node_modules`, VCS metadata, and dotenv files are deliberately excluded.
 * Relative in-package symlinks are allowed; absolute, escaping, dangling, or
 * excluded-target links are rejected before `cp` can observe them.
 */
async function captureSourcePackage(packageRoot: string): Promise<SourcePackageCapture> {
  const root = await realpath(packageRoot);
  const rootDetails = await lstat(root, { bigint: true });
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`Managed runtime source package ${root} must be a real directory.`);
  }

  const entries: SourcePackageEntry[] = [];
  const proof: SourcePackageProofEntry[] = [];
  let packageJson: Buffer | undefined;

  const visitDirectory = async (directory: string, pathRelative: string): Promise<void> => {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Managed runtime source package directory ${pathRelative} changed type.`);
    }
    entries.push({ path: pathRelative, type: "directory", mode: fileMode(before.mode) });
    proof.push(sourceProofEntry(pathRelative, "directory", before));

    const childNames = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of childNames) {
      const path = join(directory, name);
      const childRelative = sourcePackageRelativePath(root, path);
      if (isExcludedSourcePackagePath(childRelative)) continue;
      const details = await lstat(path, { bigint: true });
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await visitDirectory(path, childRelative);
        continue;
      }
      if (details.isFile() && !details.isSymbolicLink()) {
        const captured = await captureSourceFile(path, childRelative);
        entries.push(captured.entry);
        proof.push(captured.proof);
        if (childRelative === "package.json") packageJson = captured.bytes;
        continue;
      }
      if (details.isSymbolicLink()) {
        const captured = await captureSourceSymlink(root, path, childRelative, details);
        entries.push(captured.entry);
        proof.push(captured.proof);
        continue;
      }
      throw new Error(`Managed runtime source package contains unsupported entry ${childRelative}.`);
    }

    const [after, childNamesAfter] = await Promise.all([
      lstat(directory, { bigint: true }),
      readdir(directory).then((names) => names.sort((left, right) => left.localeCompare(right))),
    ]);
    if (!sameSourceStats(before, after) || JSON.stringify(childNames) !== JSON.stringify(childNamesAfter)) {
      throw new Error(`Managed runtime source package directory ${pathRelative} changed while it was inspected.`);
    }
  };

  await visitDirectory(root, ".");
  if (packageJson === undefined) {
    throw new Error(`Managed runtime source package ${root} has no regular package.json.`);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  proof.sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest: { schema: "mono-agent.source-package.v1", entries },
    proof,
    packageJson,
  };
}

async function captureSourceFile(
  path: string,
  pathRelative: string,
): Promise<{
  readonly entry: Extract<SourcePackageEntry, { readonly type: "file" }>;
  readonly proof: SourcePackageProofEntry;
  readonly bytes: Buffer;
}> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Managed runtime source file ${pathRelative} changed into a symbolic link.`);
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Managed runtime source entry ${pathRelative} is not a regular file.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || !sameSourceStats(before, after) || !sameSourceIdentity(after, pathAfter)) {
      throw new Error(`Managed runtime source file ${pathRelative} changed while it was inspected.`);
    }
    return {
      entry: {
        path: pathRelative,
        type: "file",
        mode: fileMode(after.mode),
        sha256: sha256(bytes),
      },
      proof: sourceProofEntry(pathRelative, "file", after),
      bytes,
    };
  } finally {
    await handle.close();
  }
}

async function captureSourceSymlink(
  root: string,
  path: string,
  pathRelative: string,
  before: BigIntStats,
): Promise<{
  readonly entry: Extract<SourcePackageEntry, { readonly type: "symlink" }>;
  readonly proof: SourcePackageProofEntry;
}> {
  const target = await readlink(path);
  if (isAbsolute(target)) {
    throw new Error(`Managed runtime source symlink ${pathRelative} has an absolute target.`);
  }
  const lexicalTarget = resolve(dirname(path), target);
  assertSourcePathInsidePackage(root, lexicalTarget, pathRelative);
  const lexicalRelative = sourcePackageRelativePath(root, lexicalTarget);
  if (isExcludedSourcePackagePath(lexicalRelative)) {
    throw new Error(`Managed runtime source symlink ${pathRelative} targets excluded package data.`);
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(path);
  } catch (error) {
    throw new Error(
      `Managed runtime source symlink ${pathRelative} must resolve inside its package: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertSourcePathInsidePackage(root, canonicalTarget, pathRelative);
  const canonicalRelative = sourcePackageRelativePath(root, canonicalTarget);
  if (isExcludedSourcePackagePath(canonicalRelative)) {
    throw new Error(`Managed runtime source symlink ${pathRelative} resolves to excluded package data.`);
  }
  const [after, targetAfter] = await Promise.all([
    lstat(path, { bigint: true }),
    readlink(path),
  ]);
  if (!after.isSymbolicLink() || targetAfter !== target || !sameSourceStats(before, after)) {
    throw new Error(`Managed runtime source symlink ${pathRelative} changed while it was inspected.`);
  }
  const portableTarget = target.split(sep).join("/");
  return {
    entry: {
      path: pathRelative,
      type: "symlink",
      mode: fileMode(after.mode),
      target: portableTarget,
    },
    proof: sourceProofEntry(pathRelative, "symlink", after, portableTarget),
  };
}

function sourceProofEntry(
  path: string,
  type: SourcePackageProofEntry["type"],
  details: BigIntStats,
  target?: string,
): SourcePackageProofEntry {
  return {
    path,
    type,
    dev: details.dev.toString(),
    ino: details.ino.toString(),
    mode: details.mode.toString(),
    size: details.size.toString(),
    mtimeNs: details.mtimeNs.toString(),
    ctimeNs: details.ctimeNs.toString(),
    ...(target === undefined ? {} : { target }),
  };
}

function sameSourceIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSourceStats(left: BigIntStats, right: BigIntStats): boolean {
  return sameSourceIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sourcePackageRelativePath(root: string, path: string): string {
  const pathRelative = relative(root, path);
  if (pathRelative === "" || pathRelative === ".") return ".";
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw new Error(`Managed runtime source path ${path} escapes package root ${root}.`);
  }
  return pathRelative.split(sep).join("/");
}

function assertSourcePathInsidePackage(root: string, path: string, linkPath: string): void {
  const pathRelative = relative(resolve(root), resolve(path));
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw new Error(`Managed runtime source symlink ${linkPath} escapes its package root.`);
  }
}

function isExcludedSourcePackagePath(pathRelative: string): boolean {
  const segments = pathRelative.split("/");
  if (segments.includes("node_modules") || segments.includes(".git")) return true;
  const name = segments.at(-1) ?? "";
  return name === ".npmrc" || name === ".env" || name.startsWith(".env.");
}

function readInstalledPackageMetadata(packageRoot: string, packageJson: Buffer): InstalledPackageMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read installed package metadata at ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`Installed package metadata at ${packageRoot} must declare string name and version fields.`);
  }
  const peerDependenciesMeta = isRecord(parsed.peerDependenciesMeta) ? parsed.peerDependenciesMeta : {};
  const optionalPeers = new Set(Object.entries(peerDependenciesMeta).flatMap(([name, value]) =>
    isRecord(value) && value.optional === true ? [name] : []));
  return {
    name: parsed.name,
    version: parsed.version,
    dependencies: stringRecord(parsed.dependencies, `${parsed.name} dependencies`),
    optionalDependencies: stringRecord(parsed.optionalDependencies, `${parsed.name} optionalDependencies`),
    peerDependencies: stringRecord(parsed.peerDependencies, `${parsed.name} peerDependencies`),
    optionalPeers,
  };
}

function dependencyRequirements(metadata: InstalledPackageMetadata): readonly [string, boolean][] {
  const requirements = new Map<string, boolean>();
  for (const name of Object.keys(metadata.dependencies)) requirements.set(name, false);
  for (const name of Object.keys(metadata.optionalDependencies)) requirements.set(name, true);
  for (const name of Object.keys(metadata.peerDependencies)) {
    if (!requirements.has(name)) requirements.set(name, metadata.optionalPeers.has(name));
  }
  return [...requirements].sort(([left], [right]) => left.localeCompare(right));
}

async function resolveInstalledDependencyPackageRoot(
  packageRoot: string,
  dependencyName: string,
): Promise<string | undefined> {
  const segments = packageNameSegments(dependencyName);
  let cursor = resolve(packageRoot);
  for (;;) {
    const candidate = join(cursor, "node_modules", ...segments);
    try {
      const canonical = await realpath(candidate);
      const details = await lstat(canonical);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error(`Installed dependency ${dependencyName} at ${candidate} must resolve to a real directory.`);
      }
      const metadata = readInstalledPackageMetadata(
        canonical,
        await readFile(join(canonical, "package.json")),
      );
      if (metadata.name !== dependencyName) {
        throw new Error(
          `Installed dependency path ${candidate} declares ${metadata.name}, expected ${dependencyName}.`,
        );
      }
      return canonical;
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function executionClosureDestination(stagingDir: string, node: ExecutionClosureNode): string {
  if (node.id === 0) {
    return join(stagingDir, "node_modules", "@mono-agent", "agent-app");
  }
  const segment = `${String(node.id).padStart(4, "0")}-${safeSegment(node.metadata.name)}-${safeSegment(node.metadata.version)}`;
  return join(stagingDir, "node_modules", ".mono-agent-store", segment, "package");
}

function shouldCopyPackagePath(packageRoot: string, source: string): boolean {
  const pathRelative = sourcePackageRelativePath(packageRoot, source);
  return pathRelative === "." || !isExcludedSourcePackagePath(pathRelative);
}

function packageNameSegments(name: string): readonly string[] {
  const segments = name.split("/");
  const valid = name.startsWith("@")
    ? segments.length === 2 && segments[0]!.length > 1 && segments[1]!.length > 0
    : segments.length === 1 && segments[0]!.length > 0;
  if (!valid || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error(`Invalid installed package name ${JSON.stringify(name)}.`);
  }
  return segments;
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an object of package ranges.`);
  }
  return value as Record<string, string>;
}

function portableRelativePath(root: string, path: string): string {
  const pathRelative = relative(root, path);
  if (pathRelative === "" || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) {
    throw new Error(`Managed runtime package path ${path} escapes ${root}.`);
  }
  return pathRelative.split(sep).join("/");
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing ${label} for ${String(key)}.`);
  return value;
}

function requiredClosureNode(
  closure: readonly ExecutionClosureNode[],
  id: number,
): ExecutionClosureNode {
  const node = closure[id];
  if (node === undefined || node.id !== id) throw new Error(`Missing dependency closure node ${id}.`);
  return node;
}

function packageRootForCli(cliPath: string): string {
  return resolve(dirname(cliPath), "..");
}

async function packageVersionAt(packageRoot: string): Promise<string> {
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

function runtimeLayout(home: string, identity: RuntimeIdentity, id: string, nowMs: number): RuntimeLayout {
  const platformAbi = `${safeSegment(identity.platform)}-${safeSegment(identity.arch)}-abi-${safeSegment(identity.nodeAbi)}`;
  const versionAbiDir = join(home, ".mono-agent", "runtimes", "agent-app", identity.packageVersion, platformAbi);
  const closureId = `${identity.cliSha256}-${identity.sourceClosureSha256}`;
  const installRoot = join(versionAbiDir, closureId);
  const suffix = `${Math.max(0, Math.floor(nowMs))}-${id}`;
  return {
    versionAbiDir,
    installRoot,
    cliPath: join(installRoot, "node_modules", "@mono-agent", "agent-app", "dist", "cli.js"),
    packageJsonPath: join(installRoot, "node_modules", "@mono-agent", "agent-app", "package.json"),
    packageLockPath: join(installRoot, "package-lock.json"),
    closureManifestPath: join(installRoot, ".mono-agent-closure.json"),
    markerPath: join(installRoot, ".mono-agent-runtime.json"),
    lockDir: join(versionAbiDir, `.${closureId}.lock`),
    stagingDir: join(versionAbiDir, `.${closureId}.staging-${suffix}`),
    quarantineDir: join(versionAbiDir, "quarantine", `${closureId}-${suffix}`),
  };
}

function runtimeLayoutForRoot(layout: RuntimeLayout, root: string): RuntimeLayout {
  return {
    ...layout,
    installRoot: root,
    cliPath: join(root, "node_modules", "@mono-agent", "agent-app", "dist", "cli.js"),
    packageJsonPath: join(root, "node_modules", "@mono-agent", "agent-app", "package.json"),
    packageLockPath: join(root, "package-lock.json"),
    closureManifestPath: join(root, ".mono-agent-closure.json"),
    markerPath: join(root, ".mono-agent-runtime.json"),
  };
}

async function acquireRuntimeLock(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  deps: ManagedBackgroundRuntimeDeps,
): Promise<RuntimeLockIdentity | undefined> {
  const deadline = deps.now() + LOCK_WAIT_TIMEOUT_MS;
  const incarnation = await (deps.currentProcessIncarnation ?? currentProcessIncarnation)();
  const isSameProcess = deps.isSameProcessIncarnation ?? matchesProcessIncarnation;
  for (;;) {
    let createdIdentity: RuntimeLockIdentity | undefined;
    try {
      await mkdir(layout.lockDir, { mode: 0o700 });
      createdIdentity = runtimeLockIdentity(await assertPrivateRuntimeLockDirectory(layout.lockDir));
      await writePrivateJson(join(layout.lockDir, "owner.json"), {
        pid: process.pid,
        createdAt: new Date(deps.now()).toISOString(),
        incarnation,
        ...identity,
      });
      if (!(await sameRuntimeLockDirectory(layout.lockDir, createdIdentity))) {
        throw new Error(`Managed runtime lock ${layout.lockDir} changed while its owner record was written.`);
      }
      return createdIdentity;
    } catch (error) {
      if (createdIdentity !== undefined) {
        await removeSameRuntimeLockDirectory(layout.lockDir, createdIdentity).catch(() => undefined);
      }
      if (!isErrno(error, "EEXIST")) throw error;
    }

    if (await verifyRuntime(layout, identity)) return undefined;
    let stale = false;
    try {
      const lockDetails = await assertPrivateRuntimeLockDirectory(layout.lockDir);
      const observedIdentity = runtimeLockIdentity(lockDetails);
      const owner = await runtimeLockOwner(join(layout.lockDir, "owner.json"));
      stale = owner === undefined
        ? deps.now() - (await stat(layout.lockDir)).mtimeMs >= LOCK_STALE_AFTER_MS
        : !(await isSameProcess(owner.pid, owner.incarnation));
      if (!(await sameRuntimeLockDirectory(layout.lockDir, observedIdentity))) continue;
      if (stale) {
        const staleLock = `${layout.quarantineDir}-stale-lock`;
        await mkdir(dirname(staleLock), { recursive: true, mode: 0o700 });
        try {
          await rename(layout.lockDir, staleLock);
        } catch (error) {
          if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) continue;
          throw error;
        }
        const moved = await lstat(staleLock);
        if (!sameRuntimeLockIdentity(moved, observedIdentity)) {
          await rename(staleLock, layout.lockDir).catch(() => undefined);
          return undefined;
        }
        continue;
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (deps.now() >= deadline) return undefined;
    await deps.sleep(LOCK_POLL_INTERVAL_MS);
  }
}

async function runtimeLockOwner(
  path: string,
): Promise<{ readonly pid: number; readonly incarnation: ProcessIncarnation } | undefined> {
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; incarnation?: unknown };
    const incarnation = processIncarnationFromJson(owner.incarnation);
    return typeof owner.pid === "number"
      && Number.isSafeInteger(owner.pid)
      && owner.pid > 0
      && incarnation !== undefined
      ? { pid: owner.pid, incarnation }
      : undefined;
  } catch {
    return undefined;
  }
}

async function assertPrivateRuntimeLockDirectory(path: string) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || !ownedPrivately(details)) {
    throw new Error(`Managed runtime lock ${path} is not a private current-user directory.`);
  }
  return details;
}

function runtimeLockIdentity(
  details: { readonly dev: number | bigint; readonly ino: number | bigint },
): RuntimeLockIdentity {
  return { dev: details.dev, ino: details.ino };
}

function sameRuntimeLockIdentity(
  details: { readonly dev: number | bigint; readonly ino: number | bigint },
  identity: RuntimeLockIdentity,
): boolean {
  return details.dev === identity.dev && details.ino === identity.ino;
}

async function sameRuntimeLockDirectory(path: string, identity: RuntimeLockIdentity): Promise<boolean> {
  try {
    return sameRuntimeLockIdentity(await assertPrivateRuntimeLockDirectory(path), identity);
  } catch {
    return false;
  }
}

async function removeSameRuntimeLockDirectory(path: string, identity: RuntimeLockIdentity): Promise<void> {
  if (!(await sameRuntimeLockDirectory(path, identity))) return;
  const released = `${path}.released-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, released);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  const moved = await lstat(released);
  if (!sameRuntimeLockIdentity(moved, identity)) {
    await rename(released, path).catch(() => undefined);
    throw new Error(`Managed runtime lock ${path} changed while it was released.`);
  }
  await rm(released, { recursive: true, force: true });
}

async function quarantineInvalidRuntime(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  deps: ManagedBackgroundRuntimeDeps,
): Promise<void> {
  try {
    await lstat(layout.installRoot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (await verifyRuntime(layout, identity)) return;
  await mkdir(dirname(layout.quarantineDir), { recursive: true, mode: 0o700 });
  await rename(layout.installRoot, layout.quarantineDir);
  await chmod(layout.quarantineDir, 0o700).catch(() => undefined);
  // Quarantine is deliberately retained: old verified roots and invalid roots
  // are never silently overwritten, while no plist can point at this location.
  void deps;
}

async function promoteStaging(
  layout: RuntimeLayout,
  staged: RuntimeLayout,
  identity: RuntimeIdentity,
): Promise<void> {
  try {
    await rename(staged.installRoot, layout.installRoot);
  } catch (error) {
    // A concurrent installer can win after a stale-lock recovery. Its result is
    // acceptable only if it independently verifies against the same identity.
    if (!(await verifyRuntime(layout, identity))) throw error;
    await rm(staged.installRoot, { recursive: true, force: true });
  }
}

async function verifyRuntime(layout: RuntimeLayout, identity: RuntimeIdentity): Promise<boolean> {
  try {
    const root = await lstat(layout.installRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || !ownedPrivately(root)) return false;
    if (!(await verifyInstalledPackage(layout, identity))) return false;
    await assertRegularFile(layout.markerPath, "managed runtime marker");
    const marker = JSON.parse(await readFile(layout.markerPath, "utf8")) as Partial<RuntimeMarker>;
    return marker.schema === "mono-agent.managed-runtime.v3"
      && marker.packageName === PACKAGE_NAME
      && marker.packageVersion === identity.packageVersion
      && marker.cliSha256 === identity.cliSha256
      && marker.sourceClosureSha256 === identity.sourceClosureSha256
      && marker.nodeAbi === identity.nodeAbi
      && marker.platform === identity.platform
      && marker.arch === identity.arch
      && typeof marker.closureManifestSha256 === "string"
      && await verifyClosureManifest(layout, marker.closureManifestSha256);
  } catch {
    return false;
  }
}

async function verifyInstalledPackage(layout: RuntimeLayout, identity: RuntimeIdentity): Promise<boolean> {
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
      path === "node_modules/@mono-agent/agent-app"
      || path.endsWith("/node_modules/@mono-agent/agent-app"))?.[1];
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

async function writeClosureManifest(layout: RuntimeLayout): Promise<string> {
  const manifest = await captureRuntimeClosureManifest(layout);
  const contents = privateJsonContents(manifest);
  await writeFile(layout.closureManifestPath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(layout.closureManifestPath, 0o600);
  return sha256(Buffer.from(contents, "utf8"));
}

async function verifyClosureManifest(layout: RuntimeLayout, expectedSha256: string): Promise<boolean> {
  try {
    await assertRegularFile(layout.closureManifestPath, "managed runtime closure manifest");
    const contents = await readFile(layout.closureManifestPath);
    if (sha256(contents) !== expectedSha256) return false;
    const parsed = JSON.parse(contents.toString("utf8")) as Partial<RuntimeClosureManifest>;
    if (parsed.schema !== "mono-agent.execution-closure.v1" || !Array.isArray(parsed.entries)) return false;
    const current = await captureRuntimeClosureManifest(layout);
    return JSON.stringify(parsed) === JSON.stringify(current);
  } catch {
    return false;
  }
}

async function captureRuntimeClosureManifest(layout: RuntimeLayout): Promise<RuntimeClosureManifest> {
  const entries: RuntimeClosureEntry[] = [];
  const excluded = new Set([resolve(layout.closureManifestPath), resolve(layout.markerPath)]);

  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      if (excluded.has(resolve(path))) continue;
      const details = await lstat(path);
      const pathRelative = portableRelativePath(layout.installRoot, path);
      const mode = fileMode(details.mode);
      if (details.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target)) {
          throw new Error(`Managed runtime symlink ${pathRelative} has an absolute target.`);
        }
        assertPathInsideRoot(layout.installRoot, resolve(dirname(path), target), `symlink ${pathRelative}`);
        entries.push({
          path: pathRelative,
          type: "symlink",
          mode,
          target: target.split(sep).join("/"),
        });
        continue;
      }
      if (details.isDirectory()) {
        entries.push({ path: pathRelative, type: "directory", mode });
        await visit(path);
        continue;
      }
      if (details.isFile()) {
        entries.push({
          path: pathRelative,
          type: "file",
          mode,
          sha256: await fingerprintClosureFile(path, pathRelative),
        });
        continue;
      }
      throw new Error(`Managed runtime closure contains unsupported entry ${pathRelative}.`);
    }
  };

  await visit(layout.installRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { schema: "mono-agent.execution-closure.v1", entries };
}

async function fingerprintClosureFile(path: string, pathRelative: string): Promise<string> {
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
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Managed runtime entry ${pathRelative} is not a regular file.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !after.isFile()
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
    ) {
      throw new Error(`Managed runtime file ${pathRelative} changed while it was fingerprinted.`);
    }
    return sha256(bytes);
  } finally {
    await handle.close();
  }
}

function assertPathInsideRoot(root: string, path: string, label: string): void {
  const pathRelative = relative(resolve(root), resolve(path));
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw new Error(`Managed runtime ${label} escapes its private root.`);
  }
}

function fileMode(mode: number | bigint): string {
  return (Number(mode) & 0o777).toString(8).padStart(4, "0");
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    throw new Error(`Cannot inspect ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} at ${path} must be a regular, non-symlink file.`);
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, privateJsonContents(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function privateJsonContents(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

async function ensurePrivateRuntimeAncestors(home: string, versionAbiDir: string): Promise<void> {
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

function ownedPrivately(details: Awaited<ReturnType<typeof lstat>>): boolean {
  const owned = typeof process.getuid !== "function" || Number(details.uid) === process.getuid();
  return owned && (Number(details.mode) & 0o077) === 0;
}

function runtimeResult(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  nodePath: string,
): ManagedBackgroundRuntime {
  return {
    cliPath: layout.cliPath,
    nodePath: resolve(nodePath),
    installRoot: layout.installRoot,
    packageVersion: identity.packageVersion,
    cliSha256: identity.cliSha256,
    nodeAbi: identity.nodeAbi,
  };
}

function requiredNodeAbi(): string {
  const abi = process.versions.modules;
  if (abi === undefined || abi.trim().length === 0) {
    throw new Error("Node did not report a module ABI; refusing to create a managed runtime.");
  }
  return abi;
}

function isExactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^0-9A-Za-z._-]/gu, "-").replace(/-+/gu, "-");
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw new Error(`Cannot use ${JSON.stringify(value)} as a managed runtime path segment.`);
  }
  return normalized;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

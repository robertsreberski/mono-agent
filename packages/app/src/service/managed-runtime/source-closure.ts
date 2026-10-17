import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  captureFilesystemPathProof,
  compareCodeUnits,
  fileMode,
  isErrno,
  isRecord,
  limitRuntimeRead,
  limitRuntimeStat,
  lstat,
  mapWithConcurrency,
  RUNTIME_FILE_READ_CONCURRENCY,
  RUNTIME_REUSE_STAT_CONCURRENCY,
  sameSourceIdentity,
  sameSourceProofEntry,
  sameSourceStats,
  sha256,
  sourceProofEntry,
} from "./inspection-io.js";
import { PACKAGE_NAME, safeSegment } from "./layout.js";
import { writePrivateJson } from "./marker.js";
import { reportRuntimePhase, reportRuntimeWork } from "./preparation-progress.js";
import type {
  ExecutionClosureCapture,
  ExecutionClosureCaptureDeps,
  ExecutionClosureNode,
  InstalledPackageMetadata,
  ManagedRuntimeAdditionalPackage,
  ManagedRuntimeInstallInput,
  MutableExecutionClosureNode,
  ResolvedInstalledDependency,
  SourceCaptureCache,
  SourceClosureReuseProof,
  SourcePackageCapture,
  SourcePackageEntry,
  SourcePackageProofEntry,
} from "./types.js";
const RUNTIME_PACKAGE_COPY_CONCURRENCY = 4;

/**
 * Copy the exact package graph the current CLI is already executing.
 *
 * Deliberately do not invoke npm here. A fresh npm install both re-resolves
 * semver ranges (so it is not the executing dependency closure) and runs
 * lifecycle scripts after the CLI has loaded agent dotenv credentials. Direct
 * graph materialisation also understands pnpm's workspace links without ever
 * handing `workspace:` ranges to npm.
 */
export async function materializeExactExecutionClosure(
  input: ManagedRuntimeInstallInput,
  sourceCaptures?: SourceCaptureCache,
): Promise<void> {
  const captureDeps = sourceCaptures === undefined ? {} : { sourceCaptures };
  const captured = await captureExecutionClosure(input.packageSource, input.additionalPackages, undefined, captureDeps);
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
  reportRuntimePhase("copy", closure.length);
  await mapWithConcurrency(closure, RUNTIME_PACKAGE_COPY_CONCURRENCY, async (node) => {
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
    reportRuntimeWork(true);
  });
  reportRuntimePhase("staged-verification");

  // `cp` is not a transaction: source paths can be replaced while it walks.
  // Compare every copied package against the exact pre-copy package manifest
  // before any staged runtime can receive a marker or be promoted.
  await mapWithConcurrency(closure, RUNTIME_PACKAGE_COPY_CONCURRENCY, async (node) => {
    const destination = requiredMapValue(destinations, node.id, "package destination");
    // Never certify destination bytes using the source-content cache.
    const copied = await captureSourcePackage(destination);
    if (JSON.stringify(copied.manifest) !== JSON.stringify(node.sourcePackage)) {
      throw new Error(`Managed runtime source package ${node.metadata.name} changed while it was copied.`);
    }
  });

  for (const node of closure) {
    const destination = requiredMapValue(destinations, node.id, "package destination");
    for (const [dependencyName, dependencyId] of [...node.dependencies].sort(([left], [right]) =>
      compareCodeUnits(left, right))) {
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
      dependencies: Object.fromEntries([...node.dependencies].sort(([left], [right]) => compareCodeUnits(left, right)).map(
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

  const after = await captureExecutionClosure(input.packageSource, input.additionalPackages, undefined, captureDeps);
  if (
    after.sourceClosureSha256 !== captured.sourceClosureSha256
    || after.sourceProofSha256 !== captured.sourceProofSha256
  ) {
    throw new Error("The managed runtime package closure changed while it was staged.");
  }
}

export async function captureExecutionClosure(
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  filesystemProofRoot?: string,
  deps: ExecutionClosureCaptureDeps = {},
): Promise<ExecutionClosureCapture> {
  const nodes: MutableExecutionClosureNode[] = [];
  const bySourceRoot = new Map<string, number>();
  const proofs = new Map<number, readonly SourcePackageProofEntry[]>();
  const dependencyProofs: Array<{
    readonly ownerId: number;
    readonly dependencyName: string;
    readonly proof: SourcePackageProofEntry;
  }> = [];
  const dependencyProofPaths: Array<{
    readonly path: string;
    readonly logicalPath: string;
    readonly proof: SourcePackageProofEntry;
  }> = [];
  const resolutionPathProof = filesystemProofRoot === undefined
    ? undefined
    : await createResolutionPathProof(filesystemProofRoot);

  const visit = async (source: string): Promise<number> => {
    await resolutionPathProof?.captureAncestors(source);
    const sourceRoot = await realpath(source);
    await resolutionPathProof?.captureAncestors(sourceRoot);
    const existing = bySourceRoot.get(sourceRoot);
    if (existing !== undefined) return existing;

    const sourcePackage = await captureSourcePackage(sourceRoot, deps.sourceCaptures);
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
      const dependency = await resolveInstalledDependencyPackageRoot(sourceRoot, dependencyName);
      if (dependency === undefined) {
        if (optional) continue;
        throw new Error(
          `Cannot preserve the executing dependency closure: ${metadata.name}@${metadata.version} ` +
          `cannot resolve required dependency ${dependencyName}. Build or install the package completely before starting it.`,
        );
      }
      await resolutionPathProof?.captureAncestors(dependency.candidatePath);
      const dependencyNodeId = await visit(dependency.packageRoot);
      const [dependencyProofAfter, dependencyRootAfter] = await Promise.all([
        captureFilesystemPathProof(dependency.candidatePath, dependencyName),
        realpath(dependency.candidatePath),
      ]);
      if (
        dependencyRootAfter !== dependency.packageRoot
        || !sameSourceProofEntry(dependency.proof, dependencyProofAfter)
      ) {
        throw new Error(`Installed dependency ${dependencyName} changed while its execution closure was inspected.`);
      }
      dependencyProofs.push({ ownerId: id, dependencyName, proof: dependencyProofAfter });
      dependencyProofPaths.push({
        path: dependency.candidatePath,
        logicalPath: dependencyName,
        proof: dependencyProofAfter,
      });
      node.dependencies.set(dependencyName, dependencyNodeId);
    }
    return id;
  };

  await visit(packageSource);
  await deps.afterRootCapture?.();
  const additionalRoots: { packageName: string; nodeId: number }[] = [];
  const additionalProofs: Array<{ readonly packageName: string; readonly proof: SourcePackageProofEntry }> = [];
  const additionalProofPaths: Array<{
    readonly path: string;
    readonly logicalPath: string;
    readonly proof: SourcePackageProofEntry;
  }> = [];
  for (const additional of additionalPackages) {
    const additionalProof = await captureFilesystemPathProof(additional.packageSource, additional.packageName);
    const nodeId = await visit(additional.packageSource);
    const node = requiredClosureNode(nodes, nodeId);
    if (node.metadata.name !== additional.packageName) {
      throw new Error(
        `Additional managed runtime package ${additional.packageSource} declares ${node.metadata.name}, ` +
        `expected ${additional.packageName}.`,
      );
    }
    const [additionalProofAfter, additionalRootAfter] = await Promise.all([
      captureFilesystemPathProof(additional.packageSource, additional.packageName),
      realpath(additional.packageSource),
    ]);
    if (additionalRootAfter !== node.sourceRoot || !sameSourceProofEntry(additionalProof, additionalProofAfter)) {
      throw new Error(
        `Additional managed runtime package ${additional.packageName} changed while its execution closure was inspected.`,
      );
    }
    additionalProofs.push({ packageName: additional.packageName, proof: additionalProofAfter });
    additionalProofPaths.push({
      path: additional.packageSource,
      logicalPath: additional.packageName,
      proof: additionalProofAfter,
    });
    additionalRoots.push({ packageName: additional.packageName, nodeId });
  }

  const closure = nodes as readonly ExecutionClosureNode[];
  const reuseLinks = deduplicateSourceReuseProofLinks([...dependencyProofPaths, ...additionalProofPaths]);
  await revalidateExecutionClosureProofs(closure, proofs, reuseLinks);
  const resolutionPaths = await resolutionPathProof?.finalize() ?? [];
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
        .sort(([left], [right]) => compareCodeUnits(left, right))
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
    dependencyLinks: dependencyProofs,
    additionalLinks: additionalProofs,
    resolutionPaths,
  };
  const filesystemProof = {
    schema: "mono-agent.source-filesystem-proof.v1",
    packages: closure.map((node) => ({
      id: node.id,
      entries: requiredMapValue(proofs, node.id, "source package proof"),
    })),
    dependencyLinks: dependencyProofs,
    additionalLinks: additionalProofs,
    resolutionPaths,
  };
  return {
    nodes: closure,
    additionalRoots,
    sourceClosureSha256: sha256(Buffer.from(JSON.stringify(stable), "utf8")),
    sourceProofSha256: sha256(Buffer.from(JSON.stringify(proof), "utf8")),
    filesystemProofSha256: sha256(Buffer.from(JSON.stringify(filesystemProof), "utf8")),
    reuseProof: {
      sourceProofSha256: sha256(Buffer.from(JSON.stringify(proof), "utf8")),
      packages: closure.map((node) => ({
        id: node.id,
        sourceRoot: node.sourceRoot,
        entries: requiredMapValue(proofs, node.id, "source package proof"),
      })),
      links: reuseLinks,
    },
  };
}

/** Internal capture helper; per-owner dependency proofs used by identity hashes stay unchanged. */
export function deduplicateSourceReuseProofLinks(
  links: SourceClosureReuseProof["links"],
): SourceClosureReuseProof["links"] {
  const byPath = new Map<string, SourceClosureReuseProof["links"][number]>();
  for (const link of links) {
    const existing = byPath.get(link.path);
    if (existing === undefined) {
      byPath.set(link.path, link);
    } else if (
      existing.logicalPath !== link.logicalPath
      || !sameSourceProofEntry(existing.proof, link.proof)
    ) {
      throw new Error(
        `Conflicting managed runtime source link proofs for ${link.path}. ` +
        "The installed dependency layout changed or resolves one path under different names; reinstall before starting.",
      );
    }
  }
  return [...byPath.values()];
}

/**
 * Final identity pass for every package entry and link captured above. Per-file
 * reads are descriptor-stable, but without this pass an early file could be
 * overwritten while a later large file was still being hashed.
 */
async function revalidateExecutionClosureProofs(
  closure: readonly ExecutionClosureNode[],
  proofs: ReadonlyMap<number, readonly SourcePackageProofEntry[]>,
  links: readonly {
    readonly path: string;
    readonly logicalPath: string;
    readonly proof: SourcePackageProofEntry;
  }[],
): Promise<void> {
  const targets = closure.flatMap((node) =>
    requiredMapValue(proofs, node.id, "source package proof").map((proof) => ({
      path: proof.path === "." ? node.sourceRoot : join(node.sourceRoot, ...proof.path.split("/")),
      logicalPath: proof.path,
      proof,
    })));
  await mapWithConcurrency([...targets, ...links], RUNTIME_REUSE_STAT_CONCURRENCY, async (expected) => {
    const current = await captureFilesystemPathProof(expected.path, expected.logicalPath);
    if (!sameSourceProofEntry(expected.proof, current)) {
      throw new Error(`Managed runtime source entry ${expected.logicalPath} changed during closure capture.`);
    }
  });
}

export async function canonicalAdditionalPackages(
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
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([packageName, packageSource]) => ({ packageName, packageSource }));
}

export async function assertSourceClosureUnchanged(
  packageSource: string,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  expected: ExecutionClosureCapture,
  phase: string,
  sourceCaptures?: SourceCaptureCache,
): Promise<void> {
  // Graph resolution is always repeated: newly shadowing node_modules entries
  // can change resolution without altering the old resolved dependency's inode.
  const current = await captureExecutionClosure(packageSource, additionalPackages, undefined,
    sourceCaptures === undefined ? {} : { sourceCaptures });
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
async function captureSourcePackage(
  packageRoot: string,
  sourceCaptures?: SourceCaptureCache,
): Promise<SourcePackageCapture> {
  const root = await realpath(packageRoot);
  const cached = sourceCaptures?.get(root);
  if (cached !== undefined && await sourcePackageCaptureStillMatches(root, cached)) return cached;
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

    const childNames = (await readdir(directory)).sort(compareCodeUnits);
    await mapWithConcurrency(childNames, RUNTIME_FILE_READ_CONCURRENCY, async (name) => {
      const path = join(directory, name);
      const childRelative = sourcePackageRelativePath(root, path);
      if (isExcludedSourcePackagePath(childRelative)) return;
      const details = await lstat(path, { bigint: true });
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await visitDirectory(path, childRelative);
        return;
      }
      if (details.isFile() && !details.isSymbolicLink()) {
        const captured = await captureSourceFile(path, childRelative);
        entries.push(captured.entry);
        proof.push(captured.proof);
        if (childRelative === "package.json") packageJson = captured.bytes;
        return;
      }
      if (details.isSymbolicLink()) {
        const captured = await captureSourceSymlink(root, path, childRelative, details);
        entries.push(captured.entry);
        proof.push(captured.proof);
        return;
      }
      throw new Error(`Managed runtime source package contains unsupported entry ${childRelative}.`);
    });

    const [after, childNamesAfter] = await Promise.all([
      lstat(directory, { bigint: true }),
      readdir(directory).then((names) => names.sort(compareCodeUnits)),
    ]);
    if (!sameSourceStats(before, after) || JSON.stringify(childNames) !== JSON.stringify(childNamesAfter)) {
      throw new Error(`Managed runtime source package directory ${pathRelative} changed while it was inspected.`);
    }
  };

  await visitDirectory(root, ".");
  if (packageJson === undefined) {
    throw new Error(`Managed runtime source package ${root} has no regular package.json.`);
  }
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  proof.sort((left, right) => compareCodeUnits(left.path, right.path));
  const captured: SourcePackageCapture = {
    manifest: { schema: "mono-agent.source-package.v1", entries },
    proof,
    packageJson,
  };
  sourceCaptures?.set(root, captured);
  return captured;
}

async function sourcePackageCaptureStillMatches(root: string, captured: SourcePackageCapture): Promise<boolean> {
  try {
    const matches = await mapWithConcurrency(captured.proof, RUNTIME_REUSE_STAT_CONCURRENCY, async (expected) => {
      const path = expected.path === "." ? root : join(root, ...expected.path.split("/"));
      return sameSourceProofEntry(expected, await captureFilesystemPathProof(path, expected.path));
    });
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

function captureSourceFile(path: string, pathRelative: string): ReturnType<typeof captureSourceFileUnbounded> {
  return limitRuntimeRead(() => captureSourceFileUnbounded(path, pathRelative));
}

async function captureSourceFileUnbounded(
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
    const before = await limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true }));
    if (!before.isFile()) throw new Error(`Managed runtime source entry ${pathRelative} is not a regular file.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([
      limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true })),
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

async function createResolutionPathProof(filesystemRoot: string): Promise<{
  readonly captureAncestors: (path: string) => Promise<void>;
  readonly finalize: () => Promise<readonly SourcePackageProofEntry[]>;
}> {
  const lexicalRoot = resolve(filesystemRoot);
  const canonicalRoot = await realpath(lexicalRoot);
  const captured = new Map<string, { readonly path: string; readonly proof: SourcePackageProofEntry }>();

  const captureDirectory = async (path: string, logicalPath: string): Promise<void> => {
    const current = await captureFilesystemPathProof(path, logicalPath);
    if (current.type !== "directory") {
      throw new Error(`Managed runtime resolution path ${logicalPath} must be a real directory.`);
    }
    const existing = captured.get(logicalPath);
    if (existing !== undefined && !sameSourceProofEntry(existing.proof, current)) {
      throw new Error(`Managed runtime resolution path ${logicalPath} changed while it was inspected.`);
    }
    if (existing === undefined) captured.set(logicalPath, { path, proof: current });
  };

  const captureAncestors = async (path: string): Promise<void> => {
    const target = resolve(path);
    const root = pathInsideRoot(lexicalRoot, target)
      ? lexicalRoot
      : pathInsideRoot(canonicalRoot, target)
        ? canonicalRoot
        : undefined;
    if (root === undefined) {
      throw new Error("Managed runtime execution closure resolves outside its private install root.");
    }
    await captureDirectory(root, ".");
    const parent = dirname(target);
    const parentRelative = relative(root, parent);
    if (parentRelative === "" || parentRelative === ".") return;
    let cursor = root;
    for (const segment of parentRelative.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      await captureDirectory(cursor, portableResolutionPath(root, cursor));
    }
  };

  await captureDirectory(lexicalRoot, ".");
  return {
    captureAncestors,
    finalize: async () => {
      const final: SourcePackageProofEntry[] = [];
      for (const [logicalPath, initial] of [...captured].sort(([left], [right]) => compareCodeUnits(left, right))) {
        const current = await captureFilesystemPathProof(initial.path, logicalPath);
        if (current.type !== "directory" || !sameSourceProofEntry(initial.proof, current)) {
          throw new Error(`Managed runtime resolution path ${logicalPath} changed while it was inspected.`);
        }
        final.push(current);
      }
      return final;
    },
  };
}

function pathInsideRoot(root: string, path: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative === ""
    || (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative));
}

function portableResolutionPath(root: string, path: string): string {
  const pathRelative = relative(root, path);
  return pathRelative === "" ? "." : pathRelative.split(sep).join("/");
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
  return [...requirements].sort(([left], [right]) => compareCodeUnits(left, right));
}

async function resolveInstalledDependencyPackageRoot(
  packageRoot: string,
  dependencyName: string,
): Promise<ResolvedInstalledDependency | undefined> {
  const segments = packageNameSegments(dependencyName);
  let cursor = resolve(packageRoot);
  for (;;) {
    const candidate = join(cursor, "node_modules", ...segments);
    try {
      const proof = await captureFilesystemPathProof(candidate, dependencyName);
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
      const [proofAfter, canonicalAfter] = await Promise.all([
        captureFilesystemPathProof(candidate, dependencyName),
        realpath(candidate),
      ]);
      if (canonicalAfter !== canonical || !sameSourceProofEntry(proof, proofAfter)) {
        throw new Error(`Installed dependency ${dependencyName} at ${candidate} changed while it was resolved.`);
      }
      return { candidatePath: candidate, packageRoot: canonical, proof: proofAfter };
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
    return join(stagingDir, "node_modules", "@mono-agent", "app");
  }
  const segment = `${String(node.id).padStart(4, "0")}-${safeSegment(node.metadata.name)}-${safeSegment(node.metadata.version)}`;
  return join(stagingDir, "node_modules", ".mono-agent-store", segment, "package");
}

function shouldCopyPackagePath(packageRoot: string, source: string): boolean {
  const pathRelative = sourcePackageRelativePath(packageRoot, source);
  return pathRelative === "." || !isExcludedSourcePackagePath(pathRelative);
}

export function packageNameSegments(name: string): readonly string[] {
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

export function portableRelativePath(root: string, path: string): string {
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

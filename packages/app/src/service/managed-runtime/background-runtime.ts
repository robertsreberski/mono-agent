import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { accountHomeDirectory } from "../../host/account-home.js";
import {
  currentProcessIncarnation,
  isProcessIncarnationLive,
  processIncarnationFromJson,
} from "@mono-agent/conversation/process-incarnation";
import { acquireOwnerPrivateLock, legacyLockHolderMessage, type LegacyLockHolder } from "../../durable-state/owner-private-lock.js";
import { ownerLockMutationGatePath } from "../../durable-state/owner-lock-mutation-gate.js";
import type { OwnerPrivateLock } from "../../durable-state/owner-private-lock.js";
import {
  decodeManagedRuntimeLaunchProof,
  encodeManagedRuntimeLaunchProof,
} from "./managed-runtime-launch-proof.js";
import { MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE } from "../launchd/launchd-maintenance-command.js";
import {
  assertRegularFile,
  compareCodeUnits,
  isErrno,
  lstat,
  parseJson,
  privateRuntimeDirectory,
  sameSourceIdentity,
  sameSourceStats,
  sha256,
} from "./inspection-io.js";
import {
  fingerprintClosureFile,
  managedRuntimeAdditionalPackages,
  matchingRuntimeClosureCapture,
  verifiedRuntimeMarker,
  verifyClosureManifest,
  verifyClosureManifestFingerprint,
  verifyInstalledPackage,
  verifyManagedRuntimeCliFingerprint,
  verifyManagedRuntimeMaintenanceEntryFingerprint,
  verifyRuntime,
  writeClosureManifest,
} from "./installed-closure.js";
import {
  ensurePrivateRuntimeAncestors,
  isExactVersion,
  PACKAGE_NAME,
  packageRootForCli,
  packageVersionAt,
  requiredNodeAbi,
  runtimeLayout,
  runtimeLayoutForRoot,
  runtimeVersionAbiDir,
  safeSegment,
  verifyPrivateRuntimeAncestors,
} from "./layout.js";
import {
  PROVISIONAL_RUNTIME_INSTALLED_AT,
  readPrivateRuntimeMarkerBytes,
  readRuntimeMarker,
  runtimeIdentityFromMarkerJson,
  runtimeMarkerFromJson,
  runtimeMarkerMatchesProvenance,
  sameRuntimeMarker,
  writePrivateJson,
} from "./marker.js";
import {
  preparationProgress,
  reportRuntimePhase,
  runtimePreparationProgress,
} from "./preparation-progress.js";
import {
  currentSourceReuseProof,
  findFastReusableRuntime,
  publishRuntimeReuseProof,
  verifyRuntimeFast,
} from "./reuse-proof.js";
import {
  assertSourceClosureUnchanged,
  canonicalAdditionalPackages,
  captureExecutionClosure,
  materializeExactExecutionClosure,
  packageNameSegments,
} from "./source-closure.js";
import { MANAGED_RUNTIME_MARKER_PACKAGE } from "./types.js";
import type {
  ManagedBackgroundRuntime,
  ManagedBackgroundRuntimeAttestation,
  ManagedBackgroundRuntimeAttestationDeps,
  ManagedBackgroundRuntimeAttestationInput,
  ManagedBackgroundRuntimeDeps,
  ManagedBackgroundRuntimeInput,
  ManagedRuntimeAdditionalPackage,
  ManagedRuntimeInstallInput,
  ManagedRuntimeLaunchVerification,
  ManagedRuntimeLaunchVerificationInput,
  ManagedRuntimeProvenanceVerificationDeps,
  ManagedRuntimeProvenanceVerificationInput,
  ManagedRuntimeSourceIdentity,
  ManagedRuntimeStagingWarning,
  ManagedRuntimeVerificationMode,
  RuntimeIdentity,
  RuntimeLayout,
  RuntimeMarkerV4,
  SourceCaptureCache,
} from "./types.js";
const LOCK_WAIT_TIMEOUT_MS = 30 * 60_000;
const LOCK_WAIT_SLICE_MS = 10_000;
const LOCK_STALE_AFTER_MS = 5 * 60_000;
const LOCK_POLL_INTERVAL_MS = 200;
const MAX_ABANDONED_STAGING_SWEEP = 2;
const MAX_ABANDONED_STAGING_INSPECTIONS = 64;

export function defaultManagedBackgroundRuntimeDeps(): ManagedBackgroundRuntimeDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    randomId: () => randomUUID(),
    installPackage: materializeExactExecutionClosure,
    currentProcessIncarnation,
    isSameProcessIncarnation: isProcessIncarnationLive,
  };
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
  return await runtimePreparationProgress.run(preparationProgress(input, deps), async () => {
    const result = await ensureManagedBackgroundRuntimeInternal(input, deps);
    reportRuntimePhase("ready");
    return result;
  });
}

async function ensureManagedBackgroundRuntimeInternal(
  input: ManagedBackgroundRuntimeInput,
  deps: ManagedBackgroundRuntimeDeps,
): Promise<ManagedBackgroundRuntime> {
  reportRuntimePhase("reuse");
  const currentCliPath = resolve(input.currentCliPath);
  await assertRegularFile(currentCliPath, "current mono-agent CLI");
  await assertRegularFile(resolve(input.nodePath), "managed runtime Node executable");
  const currentCli = await readFile(currentCliPath);
  const packageSourceLexical = resolve(input.packageSource ?? packageRootForCli(currentCliPath));
  const sourceDetails = await lstat(packageSourceLexical);
  if (!sourceDetails.isDirectory() || sourceDetails.isSymbolicLink()) {
    throw new Error(`Managed runtime package source ${packageSourceLexical} must be a real directory.`);
  }
  const packageSource = await realpath(packageSourceLexical);
  const additionalPackages = await canonicalAdditionalPackages(input.additionalPackages ?? []);
  const packageVersion = input.packageVersion ?? await packageVersionAt(packageSource);
  if (!isExactVersion(packageVersion)) {
    throw new Error(`Cannot install a durable managed runtime for invalid package version ${JSON.stringify(packageVersion)}.`);
  }
  const cliSha256 = sha256(currentCli);
  const nodeAbi = input.nodeAbi ?? requiredNodeAbi();
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const home = resolve(input.homeDir ?? accountHomeDirectory());
  const versionAbiDir = runtimeVersionAbiDir(home, packageVersion, nodeAbi, platform, arch);
  await ensurePrivateRuntimeAncestors(home, versionAbiDir);

  const fastRuntime = await findFastReusableRuntime({
    home,
    versionAbiDir,
    packageVersion,
    cliSha256,
    nodeAbi,
    platform,
    arch,
    packageSource,
    additionalPackages,
  });
  if (fastRuntime !== undefined) {
    await waitForManagedRuntimeLaunchBoundary(fastRuntime.layout, fastRuntime.identity, deps);
    return await runtimeResult(fastRuntime.layout, fastRuntime.identity, input.nodePath, "fast-reuse");
  }

  reportRuntimePhase("source");
  const sourceCaptures: SourceCaptureCache | undefined = deps.installPackage === materializeExactExecutionClosure
    ? new Map() : undefined;
  const sourceClosure = await captureExecutionClosure(packageSource, additionalPackages, undefined,
    sourceCaptures === undefined ? {} : { sourceCaptures });
  const identity: RuntimeIdentity = {
    packageVersion,
    cliSha256,
    sourceClosureSha256: sourceClosure.sourceClosureSha256,
    nodeAbi,
    platform,
    arch,
  };
  const id = safeSegment(deps.randomId());
  const layout = runtimeLayout(home, identity, id, deps.now());
  const runtimeWasPresent = await pathExists(layout.installRoot);
  const acquired = await acquireRuntimeLock(
    layout,
    identity,
    additionalPackages,
    deps,
    () => verifyRuntimeFast(layout, identity, packageSource, additionalPackages),
  );
  if (!acquired) {
    if (await verifyRuntimeFast(layout, identity, packageSource, additionalPackages)) {
      await waitForManagedRuntimeLaunchBoundary(layout, identity, deps);
      return await runtimeResult(layout, identity, input.nodePath, "fast-reuse");
    }
    // Preserve compatibility with a finalized v4 runtime when another process
    // released the lock before it could publish the v5 warm proof.
    if (await verifyRuntime(layout, identity, additionalPackages)) {
      await waitForManagedRuntimeLaunchBoundary(layout, identity, deps);
      return await runtimeResult(layout, identity, input.nodePath, "full-reuse");
    }
    throw new Error(`Timed out waiting for the managed runtime installation lock at ${layout.lockDir}.`);
  }

  try {
    await cleanupAbandonedRuntimeStaging(layout, [packageSource, ...additionalPackages.map((entry) => entry.packageSource)]);
    reportRuntimePhase("reuse");
    if (await verifyRuntime(layout, identity, additionalPackages)) {
      const marker = await readRuntimeMarker(layout.markerPath, identity);
      if (marker === undefined) throw new Error("The managed runtime marker changed before warm-proof publication.");
      reportRuntimePhase("proof-publication");
      const sourceReuseProof = await currentSourceReuseProof(
        packageSource,
        additionalPackages,
        sourceClosure,
      );
      await publishRuntimeReuseProof(
        layout,
        identity,
        packageSource,
        additionalPackages,
        sourceReuseProof,
        marker,
        deps,
      );
      if (!(await verifyRuntimeFast(layout, identity, packageSource, additionalPackages))) {
        throw new Error("The managed runtime warm-reuse proof failed verification after publication.");
      }
      await waitForManagedRuntimeLaunchBoundary(layout, identity, deps);
      return await runtimeResult(layout, identity, input.nodePath, "full-reuse");
    }
    reportRuntimePhase("source-verification");
    await assertSourceClosureUnchanged(packageSource, additionalPackages, sourceClosure, "before staging", sourceCaptures);
    await rm(layout.stagingDir, { recursive: true, force: true });
    await mkdir(layout.stagingDir, { recursive: false, mode: 0o700 });
    await chmod(layout.stagingDir, 0o700);
    await writePrivateJson(join(layout.stagingDir, "package.json"), {
      name: "mono-agent-managed-runtime",
      private: true,
      version: "0.0.0",
    });

    try {
      const installInput: ManagedRuntimeInstallInput = {
        stagingDir: layout.stagingDir,
        packageVersion,
        packageSource,
        nodePath: resolve(input.nodePath),
        additionalPackages,
        expectedSourceClosureSha256: identity.sourceClosureSha256,
      };
      // Keep embed/test installers on their ordinary independent verification path.
      if (deps.installPackage === materializeExactExecutionClosure) {
        await materializeExactExecutionClosure(installInput, sourceCaptures);
      } else {
        await deps.installPackage(installInput);
      }
      reportRuntimePhase("source-verification");
      await assertSourceClosureUnchanged(packageSource, additionalPackages, sourceClosure, "while staging", sourceCaptures);
      reportRuntimePhase("staged-verification");
      const staged = runtimeLayoutForRoot(layout, layout.stagingDir);
      if (!(await verifyInstalledPackage(staged, identity))) {
        throw new Error(
          `Installed ${PACKAGE_NAME}@${packageVersion} does not match the executing CLI SHA-256 ${identity.cliSha256}.`,
        );
      }
      const closureManifestSha256 = await writeClosureManifest(staged);
      const stagedPackageSource = dirname(dirname(staged.cliPath));
      const stagedAdditionalPackages = additionalPackages.map(({ packageName }) => ({
        packageName,
        packageSource: join(staged.installRoot, "node_modules", ...packageNameSegments(packageName)),
      }));
      const stagedExecutionClosure = await captureExecutionClosure(
        stagedPackageSource,
        stagedAdditionalPackages,
        staged.installRoot,
      );
      if (stagedExecutionClosure.sourceClosureSha256 !== identity.sourceClosureSha256) {
        throw new Error("The staged managed runtime execution closure does not match its source identity.");
      }
      const marker: RuntimeMarkerV4 = {
        schema: "mono-agent.managed-runtime.v4",
        packageName: MANAGED_RUNTIME_MARKER_PACKAGE,
        closureManifestSha256,
        executionProofSha256: stagedExecutionClosure.filesystemProofSha256,
        ...identity,
        // Provisional only. Promotion rewrites this with the post-proof launch
        // boundary; a crash before that rewrite must never look finalized.
        installedAt: PROVISIONAL_RUNTIME_INSTALLED_AT,
      };
      await writePrivateJson(staged.markerPath, marker);
      await chmod(layout.stagingDir, 0o700);
      // Build and verify the replacement completely before moving an invalid
      // runtime aside. This is essential when the executing CLI (and therefore
      // packageSource) lives inside that invalid runtime: quarantine must never
      // make the only repair source disappear halfway through installation.
      reportRuntimePhase("promotion");
      await quarantineInvalidRuntime(layout, identity, additionalPackages, deps);
      const promoted = await promoteStaging(layout, staged, identity, additionalPackages);
      if (promoted) {
        // Renaming the staging root changes that directory's ctime. Rebind the
        // marker to the post-promotion resolution-path identities before any
        // caller can persist or launch this runtime.
        const promotedPackageSource = dirname(dirname(layout.cliPath));
        const promotedAdditionalPackages = additionalPackages.map(({ packageName }) => ({
          packageName,
          packageSource: join(layout.installRoot, "node_modules", ...packageNameSegments(packageName)),
        }));
        const promotedClosure = await captureExecutionClosure(
          promotedPackageSource,
          promotedAdditionalPackages,
          layout.installRoot,
        );
        if (promotedClosure.sourceClosureSha256 !== identity.sourceClosureSha256) {
          throw new Error("The promoted managed runtime execution closure does not match its source identity.");
        }
        reportRuntimePhase("proof-publication");
        const sourceReuseProof = await currentSourceReuseProof(
          packageSource,
          additionalPackages,
          sourceClosure,
        );
        await publishRuntimeReuseProof(layout, identity, packageSource, additionalPackages, sourceReuseProof, {
          ...marker,
          executionProofSha256: promotedClosure.filesystemProofSha256,
        }, deps, true);
      }
    } catch (error) {
      await rm(layout.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    reportRuntimePhase("final-verification");
    if (!(await verifyRuntime(layout, identity, additionalPackages))) {
      throw new Error("The managed runtime failed verification after atomic promotion.");
    }
    if (!(await verifyRuntimeFast(layout, identity, packageSource, additionalPackages))) {
      const marker = await readRuntimeMarker(layout.markerPath, identity);
      if (marker === undefined) throw new Error("The managed runtime marker changed before warm-proof publication.");
      const sourceReuseProof = await currentSourceReuseProof(
        packageSource,
        additionalPackages,
        sourceClosure,
      );
      await publishRuntimeReuseProof(
        layout,
        identity,
        packageSource,
        additionalPackages,
        sourceReuseProof,
        marker,
        deps,
      );
    }
    if (!(await verifyRuntimeFast(layout, identity, packageSource, additionalPackages))) {
      throw new Error("The managed runtime warm-reuse proof failed verification after atomic promotion.");
    }
    await waitForManagedRuntimeLaunchBoundary(layout, identity, deps);
    return await runtimeResult(
      layout,
      identity,
      input.nodePath,
      runtimeWasPresent ? "repaired" : "installed",
    );
  } finally {
    await acquired.release().catch(() => undefined);
  }
}

/**
 * Inspect the controller CLI as inert installation input. The recovery helper
 * uses this to decide whether launchd owns an older closure without ever
 * executing mutable checkout bytes.
 */
export async function inspectManagedRuntimeSourceIdentity(
  currentCliPathInput: string,
): Promise<ManagedRuntimeSourceIdentity> {
  const currentCliPath = resolve(currentCliPathInput);
  await assertRegularFile(currentCliPath, "current mono-agent CLI");
  const packageSource = packageRootForCli(currentCliPath);
  const sourceDetails = await lstat(packageSource);
  if (!sourceDetails.isDirectory() || sourceDetails.isSymbolicLink()) {
    throw new Error(`Managed runtime package source ${packageSource} must be a real directory.`);
  }
  const packageVersion = await packageVersionAt(packageSource);
  if (!isExactVersion(packageVersion)) {
    throw new Error(`Cannot inspect a durable managed runtime for invalid package version ${JSON.stringify(packageVersion)}.`);
  }
  return {
    packageVersion,
    cliSha256: sha256(await readFile(currentCliPath)),
  };
}

/**
 * Validate the opaque proof carried by a managed LaunchAgent against the exact
 * CLI that is about to start. This is intentionally lighter than controller
 * attestation: it rechecks the private layout, marker, CLI, and stored closure
 * manifest fingerprints without traversing the entire installed dependency
 * tree on every KeepAlive restart.
 */
export async function verifyManagedRuntimeLaunch(
  input: ManagedRuntimeLaunchVerificationInput,
): Promise<ManagedRuntimeLaunchVerification> {
  const proof = decodeManagedRuntimeLaunchProof(input.launchProof);
  const currentCliPath = resolve(input.currentCliPath);
  const packageRoot = packageRootForCli(currentCliPath);
  const installRoot = dirname(dirname(dirname(packageRoot)));
  const home = resolve(input.homeDir ?? accountHomeDirectory());
  const initialInstallRoot = await lstat(installRoot, { bigint: true });
  if (!privateRuntimeDirectory(initialInstallRoot)) {
    throw new Error("The managed runtime closure root is not a real owner-private directory.");
  }
  const markerPath = join(installRoot, ".mono-agent-runtime.json");
  const initialBytes = await readPrivateRuntimeMarkerBytes(markerPath);
  if (initialBytes === undefined) throw new Error("The managed runtime marker is unavailable or unsafe.");
  const markerValue = parseJson(initialBytes, "managed runtime marker");
  const identity = runtimeIdentityFromMarkerJson(markerValue);
  if (identity === undefined) throw new Error("The managed runtime marker has an invalid identity.");
  const marker = runtimeMarkerFromJson(markerValue, identity);
  if (marker === undefined) throw new Error("The managed runtime marker is provisional or malformed.");

  const layout = runtimeLayout(home, identity, "launch", 0);
  if (layout.installRoot !== installRoot || layout.cliPath !== currentCliPath) {
    throw new Error("The managed worker CLI is outside its canonical runtime closure.");
  }
  if (!(await verifyPrivateRuntimeAncestors(home, layout.versionAbiDir))) {
    throw new Error("The managed runtime has an unsafe private ancestry.");
  }
  if (sha256(initialBytes) !== proof.markerSha256 || marker.installedAt !== proof.installedAt) {
    throw new Error("The managed runtime marker does not match its LaunchAgent proof.");
  }
  if (!(await verifyInstalledPackage(layout, identity))) {
    throw new Error("The managed runtime CLI or package identity failed verification.");
  }
  if (!(await verifyManagedRuntimeCliFingerprint(layout, identity.cliSha256))) {
    throw new Error("The managed runtime CLI fingerprint is unstable.");
  }
  if (!(await verifyManagedRuntimeMaintenanceEntryFingerprint(layout, proof.maintenanceEntrySha256))) {
    throw new Error("The managed runtime maintenance entry fingerprint is invalid.");
  }
  if (!(await verifyClosureManifestFingerprint(layout, marker.closureManifestSha256))) {
    throw new Error("The managed runtime closure manifest fingerprint is invalid.");
  }

  await waitForLaunchBoundary(marker.installedAt, input.now ?? Date.now, input.sleep ?? sleep);

  const finalBytes = await readPrivateRuntimeMarkerBytes(markerPath);
  if (finalBytes === undefined || sha256(finalBytes) !== proof.markerSha256 || !finalBytes.equals(initialBytes)) {
    throw new Error("The managed runtime marker changed during launch verification.");
  }
  if (!(await verifyManagedRuntimeCliFingerprint(layout, identity.cliSha256))) {
    throw new Error("The managed runtime CLI changed during launch verification.");
  }
  if (!(await verifyManagedRuntimeMaintenanceEntryFingerprint(layout, proof.maintenanceEntrySha256))) {
    throw new Error("The managed runtime maintenance entry changed during launch verification.");
  }
  if (!(await verifyClosureManifestFingerprint(layout, marker.closureManifestSha256))) {
    throw new Error("The managed runtime closure manifest changed during launch verification.");
  }
  const finalInstallRoot = await lstat(installRoot, { bigint: true });
  if (!privateRuntimeDirectory(finalInstallRoot) || !sameSourceStats(initialInstallRoot, finalInstallRoot)) {
    throw new Error("The managed runtime closure root changed during launch verification.");
  }
  const closureId = `${identity.cliSha256}-${identity.sourceClosureSha256}`;
  return {
    installRoot,
    packageVersion: identity.packageVersion,
    cliSha256: identity.cliSha256,
    provenanceDetail: `Runtime provenance: managed closure ${closureId} (`
      + `${PACKAGE_NAME} ${identity.packageVersion}; ${identity.platform}-${identity.arch}; `
      + `Node ABI ${identity.nodeAbi}; installed ${marker.installedAt}).`,
  };
}

/**
 * Canonically verify the installed package, freshly recomputed execution
 * closure/filesystem proof, and coherent current manifest behind a provenance
 * marker. This intentionally does not install, repair, or compare against a
 * deploy checkout; it only validates the managed snapshot executing the caller.
 */
export async function verifyManagedRuntimeClosureForProvenance(
  input: ManagedRuntimeProvenanceVerificationInput,
  deps: ManagedRuntimeProvenanceVerificationDeps = {},
): Promise<boolean> {
  try {
    if (
      !isExactVersion(input.packageVersion)
      || !/^[0-9a-f]{64}$/u.test(input.cliSha256)
      || !/^[0-9a-f]{64}$/u.test(input.sourceClosureSha256)
      || !/^[0-9a-f]{64}$/u.test(input.closureManifestSha256)
      || !/^[0-9a-f]{64}$/u.test(input.executionProofSha256)
    ) {
      return false;
    }
    const packageRoot = resolve(input.packageRoot);
    const installRoot = dirname(dirname(dirname(packageRoot)));
    if (join(installRoot, "node_modules", "@mono-agent", "app") !== packageRoot) return false;

    const identity: RuntimeIdentity = {
      packageVersion: input.packageVersion,
      cliSha256: input.cliSha256,
      sourceClosureSha256: input.sourceClosureSha256,
      nodeAbi: input.nodeAbi,
      platform: input.platform,
      arch: input.arch,
    };
    const appRuntimeRoot = dirname(dirname(dirname(installRoot)));
    const home = dirname(dirname(dirname(appRuntimeRoot)));
    const layout = runtimeLayout(home, identity, "provenance", 0);
    if (layout.installRoot !== installRoot || layout.cliPath !== join(packageRoot, "dist", "cli.js")) return false;
    if (!(await verifyPrivateRuntimeAncestors(home, layout.versionAbiDir))) return false;
    const markerInitial = await verifiedRuntimeMarker(layout, identity);
    if (markerInitial === undefined || !runtimeMarkerMatchesProvenance(markerInitial, input)) return false;
    const additionalPackages = await managedRuntimeAdditionalPackages(layout);
    if (additionalPackages === undefined) return false;
    const closureInitial = await matchingRuntimeClosureCapture(
      layout,
      identity,
      markerInitial,
      additionalPackages,
    );
    if (closureInitial === undefined) return false;

    await deps.afterInitialClosureCapture?.();

    const closureFinal = await matchingRuntimeClosureCapture(
      layout,
      identity,
      markerInitial,
      additionalPackages,
      deps.afterFinalRootCapture === undefined
        ? {}
        : { afterRootCapture: deps.afterFinalRootCapture },
    );
    if (
      closureFinal === undefined
      || closureFinal.sourceClosureSha256 !== closureInitial.sourceClosureSha256
      || closureFinal.sourceProofSha256 !== closureInitial.sourceProofSha256
      || closureFinal.filesystemProofSha256 !== closureInitial.filesystemProofSha256
    ) {
      return false;
    }
    const markerFinal = await readRuntimeMarker(layout.markerPath, identity);
    if (
      markerFinal === undefined
      || !sameRuntimeMarker(markerFinal, markerInitial)
      || !runtimeMarkerMatchesProvenance(markerFinal, input)
      || !(await verifyClosureManifest(
        layout,
        markerFinal.closureManifestSha256,
        deps.beforeFinalManifestProof === undefined
          ? {}
          : { beforeFinalProof: deps.beforeFinalManifestProof },
      ))
    ) {
      return false;
    }
    const markerAfterManifest = await readRuntimeMarker(layout.markerPath, identity);
    return markerAfterManifest !== undefined
      && sameRuntimeMarker(markerAfterManifest, markerInitial)
      && runtimeMarkerMatchesProvenance(markerAfterManifest, input);
  } catch {
    return false;
  }
}

/**
 * Prove, without installing or repairing anything, that a persisted managed
 * runtime is the canonical private copy of the exact deploy-source execution
 * closure (including config-selected plugin roots).
  * @coreScanRetained
 */
export async function attestManagedBackgroundRuntime(
  input: ManagedBackgroundRuntimeAttestationInput,
  deps: ManagedBackgroundRuntimeAttestationDeps = {},
): Promise<ManagedBackgroundRuntimeAttestation> {
  const currentCliPath = resolve(input.currentCliPath);
  await assertRegularFile(currentCliPath, "current mono-agent CLI");
  const packageSource = resolve(input.packageSource ?? packageRootForCli(currentCliPath));
  const sourceDetails = await lstat(packageSource);
  if (!sourceDetails.isDirectory() || sourceDetails.isSymbolicLink()) {
    throw new Error(`Managed runtime package source ${packageSource} must be a real directory.`);
  }
  const additionalPackages = await canonicalAdditionalPackages(input.additionalPackages ?? []);
  const sourceClosureInitial = await captureExecutionClosure(packageSource, additionalPackages);
  const packageVersion = input.packageVersion ?? await packageVersionAt(packageSource);
  if (!isExactVersion(packageVersion)) {
    throw new Error(`Cannot attest a durable managed runtime for invalid package version ${JSON.stringify(packageVersion)}.`);
  }
  const identity: RuntimeIdentity = {
    packageVersion,
    cliSha256: sha256(await readFile(currentCliPath)),
    sourceClosureSha256: sourceClosureInitial.sourceClosureSha256,
    nodeAbi: input.nodeAbi ?? requiredNodeAbi(),
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
  };
  const home = resolve(input.homeDir ?? accountHomeDirectory());
  const layout = runtimeLayout(home, identity, "attestation", 0);
  if (resolve(input.runtimeCliPath) !== layout.cliPath) {
    throw new Error("The managed runtime CLI is not at the canonical execution-closure path.");
  }
  if (!(await verifyPrivateRuntimeAncestors(home, layout.versionAbiDir))) {
    throw new Error("The managed runtime has an unsafe ancestor directory.");
  }
  const markerInitial = await verifiedRuntimeMarker(layout, identity);
  if (markerInitial === undefined) {
    throw new Error("The managed runtime marker or closure manifest is invalid.");
  }

  const runtimePackageSource = dirname(dirname(layout.cliPath));
  const runtimeAdditionalPackages = additionalPackages.map(({ packageName }) => ({
    packageName,
    packageSource: join(layout.installRoot, "node_modules", ...packageNameSegments(packageName)),
  }));
  const runtimeClosureInitial = await captureExecutionClosure(
    runtimePackageSource,
    runtimeAdditionalPackages,
    layout.installRoot,
  );
  if (runtimeClosureInitial.sourceClosureSha256 !== sourceClosureInitial.sourceClosureSha256) {
    throw new Error("The managed runtime execution closure does not match the deploy source closure.");
  }
  if (runtimeClosureInitial.filesystemProofSha256 !== markerInitial.executionProofSha256) {
    throw new Error("The managed runtime filesystem proof does not match its install-time proof.");
  }

  await deps.afterInitialCaptures?.();

  const sourceClosureFinal = await captureExecutionClosure(packageSource, additionalPackages);
  if (sourceClosureFinal.sourceClosureSha256 !== sourceClosureInitial.sourceClosureSha256
    || sourceClosureFinal.sourceProofSha256 !== sourceClosureInitial.sourceProofSha256) {
    throw new Error("The deploy source execution closure changed while it was attested.");
  }
  const runtimeClosureFinal = await captureExecutionClosure(
    runtimePackageSource,
    runtimeAdditionalPackages,
    layout.installRoot,
  );
  if (runtimeClosureFinal.sourceClosureSha256 !== runtimeClosureInitial.sourceClosureSha256
    || runtimeClosureFinal.sourceProofSha256 !== runtimeClosureInitial.sourceProofSha256) {
    throw new Error("The managed runtime execution closure changed while it was attested.");
  }
  if (runtimeClosureFinal.filesystemProofSha256 !== markerInitial.executionProofSha256) {
    throw new Error("The managed runtime filesystem proof changed after installation.");
  }

  const markerFinal = await verifiedRuntimeMarker(layout, identity);
  if (markerFinal === undefined || JSON.stringify(markerFinal) !== JSON.stringify(markerInitial)) {
    throw new Error("The managed runtime changed while it was attested.");
  }
  const fingerprint = sha256(Buffer.from(JSON.stringify({
    schema: "mono-agent.managed-runtime-attestation.v1",
    identity,
    sourceProofSha256: sourceClosureFinal.sourceProofSha256,
    runtimeProofSha256: runtimeClosureFinal.sourceProofSha256,
    closureManifestSha256: markerInitial.closureManifestSha256,
    installedAt: markerInitial.installedAt,
  }), "utf8"));
  return {
    schema: "mono-agent.managed-runtime-attestation.v1",
    fingerprint,
    installedAt: markerInitial.installedAt,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function acquireRuntimeLock(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  deps: ManagedBackgroundRuntimeDeps,
  isSatisfied: () => Promise<boolean> = () => verifyRuntime(layout, identity, additionalPackages),
): Promise<OwnerPrivateLock | undefined> {
  const incarnation = await (deps.currentProcessIncarnation ?? currentProcessIncarnation)();
  // Liveness, not authorization: a live owner with unavailable or legacy
  // Darwin evidence keeps the lock; only ESRCH or proven reuse reclaims it.
  const sameProcess = deps.isSameProcessIncarnation ?? isProcessIncarnationLive;
  const startedAt = deps.now();
  const deadline = startedAt + LOCK_WAIT_TIMEOUT_MS;
  // Initially ownerless/invalid publication keeps the old wait bound. Once an
  // owner was observed, a quarantine/publication handoff is not an ownerless
  // timeout: keep retrying until the overall cap without stealing a live owner.
  const ownerlessDeadline = startedAt + LOCK_STALE_AFTER_MS;
  let lastOwnerPid: number | undefined;
  let legacyHolder: LegacyLockHolder | undefined;
  let observedOwner = false;
  for (;;) {
    let satisfied = false;
    runtimePreparationProgress.getStore()?.checkFailure();
    legacyHolder = undefined;
    const held = await acquireOwnerPrivateLock({
      ...managedRuntimeLockProtocol(layout, identity),
      waitTimeoutMs: Math.max(1, Math.min(LOCK_WAIT_SLICE_MS, deadline - deps.now())),
      pollIntervalMs: LOCK_POLL_INTERVAL_MS,
      now: deps.now,
      processIncarnation: incarnation,
      onLegacyOwnerHeld: (holder) => { legacyHolder = holder; },
      afterInspected: (observed) => { if (observed.kind === "owned") observedOwner = true; },
      isSameProcessIncarnation: async (pid, expected) => {
        const live = await sameProcess(pid, expected);
        if (live) {
          lastOwnerPid = pid;
          runtimePreparationProgress.getStore()?.waiting(pid, expected);
        }
        return live;
      },
      isSatisfied: async () => { satisfied = await isSatisfied(); return satisfied; },
      sleep: deps.sleep,
    });
    if (held !== undefined || satisfied) return held;
    if (deps.now() >= deadline) {
      throw new Error("Managed runtime preparation is still owned by another mono-agent process"
        + (lastOwnerPid === undefined ? "" : ` (pid ${lastOwnerPid})`)
        + " after 30 minutes. The live owner was not interrupted; check that process, then retry start."
        + (legacyHolder === undefined ? "" : ` ${legacyLockHolderMessage(legacyHolder)}`));
    }
    if (!observedOwner && deps.now() >= ownerlessDeadline) return undefined;
    // A dead owner may have just been quarantined. Retry acquisition, rather
    // than mistaking that safe recovery for an installation-lock timeout.
  }
}

/**
 * The fixed lock protocol for one runtime closure. The gate sits beside the
 * lock in the version/ABI directory, where only prefix-matched staging and
 * closure directories are ever listed. A busy gate inside a 10 s wait slice is
 * reported as "held", so the caller simply takes its next slice; a busy release
 * finishes in the background.
 */
export function managedRuntimeLockProtocol(
  layout: Pick<RuntimeLayout, "lockDir" | "quarantineDir">,
  identity: RuntimeIdentity,
): Parameters<typeof acquireOwnerPrivateLock>[0] {
  return {
    path: layout.lockDir,
    label: "Managed runtime lock",
    schemaTag: "mono-agent.managed-runtime-lock.v1",
    ownerlessGraceMs: LOCK_STALE_AFTER_MS,
    ownerFields: () => ({ ...identity }),
    validateOwnerFields: (record) => Object.entries(identity)
      .every(([key, value]) => record[key] === value),
    parseLegacyOwner: (record) => {
      const legacyIncarnation = processIncarnationFromJson(record.incarnation);
      return typeof record.pid === "number"
        && Number.isSafeInteger(record.pid)
        && record.pid > 0
        && legacyIncarnation !== undefined
        ? { pid: record.pid, incarnation: legacyIncarnation }
        : undefined;
    },
    invalidOwner: "ownerless",
    staleRace: "retry",
    beforeStaleRename: async () => {
      await mkdir(dirname(layout.quarantineDir), { recursive: true, mode: 0o700 });
    },
    stalePath: () => `${layout.quarantineDir}-stale-lock`,
    mutationGate: { path: ownerLockMutationGatePath(layout.lockDir) },
    onGateBusy: () => undefined,
    releaseGateBusy: "background",
  };
}

/** Reclaim only this locked closure's abandoned private staging, never retained runtimes. */
async function cleanupAbandonedRuntimeStaging(layout: RuntimeLayout, sourceRoots: readonly string[]): Promise<void> {
  const closureId = basename(layout.installRoot);
  const prefixes = [`.${closureId}.staging-`, `.${closureId}.cleanup-`];
  const names = (await readdir(layout.versionAbiDir)).filter((name) => prefixes.some((prefix) => name.startsWith(prefix))
    && join(layout.versionAbiDir, name) !== layout.stagingDir).sort(compareCodeUnits);
  if (names.length === 0) return;
  reportRuntimePhase("cleanup", Math.min(MAX_ABANDONED_STAGING_SWEEP, names.length));
  const parent = await lstat(layout.versionAbiDir, { bigint: true });
  const warnings = new Set<ManagedRuntimeStagingWarning>();
  const warn = (reason: ManagedRuntimeStagingWarning): void => {
    if (warnings.has(reason)) return;
    warnings.add(reason);
    runtimePreparationProgress.getStore()?.warning(reason);
  };
  let attempts = 0;
  for (const [index, name] of names.slice(0, MAX_ABANDONED_STAGING_INSPECTIONS).entries()) {
    if (attempts >= MAX_ABANDONED_STAGING_SWEEP) break;
    const candidate = join(layout.versionAbiDir, name);
    let details: BigIntStats;
    try { details = await lstat(candidate, { bigint: true }); } catch { warn("staging-cleanup-failed"); continue; }
    if (!privateRuntimeDirectory(parent) || !privateRuntimeDirectory(details)) { warn("unsafe-staging"); continue; }
    let canonicalCandidate: string;
    try { canonicalCandidate = await realpath(candidate); } catch { warn("staging-cleanup-failed"); continue; }
    if (sourceRoots.some((source) => {
      const inside = relative(canonicalCandidate, source);
      return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
    })) continue; // Canonicalize aliases such as /tmp before protecting a repair source.
    const container = join(layout.versionAbiDir,
      `${basename(layout.stagingDir).replace(`.${closureId}.staging-`, `.${closureId}.retained-`)}-${index}`);
    const moved = join(container, "abandoned");
    let changed = false;
    try {
      const parentBefore = await lstat(layout.versionAbiDir, { bigint: true });
      const before = await lstat(candidate, { bigint: true });
      if (!privateRuntimeDirectory(parentBefore) || !sameSourceIdentity(parent, parentBefore)
        || !privateRuntimeDirectory(before) || !sameSourceStats(details, before)) {
        warn("staging-changed"); continue;
      }
      // Non-swept until deletion: a crash or identity change must not turn an
      // unknown replacement into an abandoned tree eligible on the next run.
      // Exclusive private container: rename cannot overwrite another artifact.
      await mkdir(container, { mode: 0o700 });
      const containerBefore = await lstat(container, { bigint: true });
      attempts += 1;
      await rename(candidate, moved);
      const [after, parentAfter, containerAfter] = await Promise.all([
        lstat(moved, { bigint: true }), lstat(layout.versionAbiDir, { bigint: true }), lstat(container, { bigint: true }),
      ]);
      changed = !privateRuntimeDirectory(after) || !sameSourceIdentity(before, after)
        || !privateRuntimeDirectory(parentAfter) || !sameSourceIdentity(parent, parentAfter)
        || !privateRuntimeDirectory(containerAfter) || !sameSourceIdentity(containerBefore, containerAfter);
      if (!changed) await rm(container, { recursive: true, force: true });
    } catch { warn("staging-cleanup-failed"); continue; }
    // Replacement across rename is retained in the cleanup container, never deleted.
    if (changed) warn("staging-changed");
    else runtimePreparationProgress.getStore()?.removed();
  }
}

async function quarantineInvalidRuntime(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
  deps: ManagedBackgroundRuntimeDeps,
): Promise<void> {
  try {
    await lstat(layout.installRoot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (await verifyRuntime(layout, identity, additionalPackages)) return;
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
  additionalPackages: readonly ManagedRuntimeAdditionalPackage[],
): Promise<boolean> {
  try {
    await rename(staged.installRoot, layout.installRoot);
    return true;
  } catch (error) {
    // A concurrent installer can win after a stale-lock recovery. Its result is
    // acceptable only if it independently verifies against the same identity.
    if (!(await verifyRuntime(layout, identity, additionalPackages))) throw error;
    await rm(staged.installRoot, { recursive: true, force: true });
    return false;
  }
}

async function waitForManagedRuntimeLaunchBoundary(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  deps: ManagedBackgroundRuntimeDeps,
): Promise<void> {
  const marker = await readRuntimeMarker(layout.markerPath, identity);
  if (marker === undefined) {
    throw new Error("The managed runtime marker became invalid before launch.");
  }
  await waitForLaunchBoundary(marker.installedAt, deps.now, deps.sleep);
}

async function waitForLaunchBoundary(
  installedAt: string,
  now: () => number,
  sleepFor: (ms: number) => Promise<void>,
): Promise<void> {
  const boundaryMs = Date.parse(installedAt);
  const safeStartMs = (Math.floor(boundaryMs / 1_000) + 1) * 1_000;
  const nowMs = now();
  if (safeStartMs - nowMs > 5_000) {
    throw new Error("The managed runtime launch boundary is implausibly far in the future.");
  }
  if (nowMs < safeStartMs) await sleepFor(safeStartMs - nowMs);
}

async function runtimeResult(
  layout: RuntimeLayout,
  identity: RuntimeIdentity,
  nodePath: string,
  verificationMode: ManagedRuntimeVerificationMode,
): Promise<ManagedBackgroundRuntime> {
  const markerBytes = await readPrivateRuntimeMarkerBytes(layout.markerPath);
  if (markerBytes === undefined) {
    throw new Error("The managed runtime marker became unsafe before launch proof publication.");
  }
  const marker = runtimeMarkerFromJson(parseJson(markerBytes, "managed runtime marker"), identity);
  if (marker === undefined) {
    throw new Error("The managed runtime marker became invalid before launch proof publication.");
  }
  const maintenanceEntry = await fingerprintClosureFile(
    layout.maintenanceEntryPath,
    `node_modules/@mono-agent/app/dist/${MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE}`,
  );
  return {
    cliPath: layout.cliPath,
    nodePath: resolve(nodePath),
    installRoot: layout.installRoot,
    packageVersion: identity.packageVersion,
    cliSha256: identity.cliSha256,
    nodeAbi: identity.nodeAbi,
    verificationMode,
    launchProof: encodeManagedRuntimeLaunchProof({
      schema: "mono-agent.managed-runtime-launch.v2",
      markerSha256: sha256(markerBytes),
      maintenanceEntrySha256: maintenanceEntry.sha256,
      installedAt: marker.installedAt,
    }),
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

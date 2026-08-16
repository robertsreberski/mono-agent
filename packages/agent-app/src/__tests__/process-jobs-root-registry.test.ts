import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const processIdentity = vi.hoisted(() => ({
  current: {
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-registry",
  },
}));

vi.mock("../process-incarnation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: async () => processIdentity.current,
  isSameProcessIncarnation: () => true,
}));

import {
  acquireAgentRootOwnership,
  agentRootLeasePath,
} from "../agent-root-coordinator.js";
import {
  PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
  PROCESS_JOBS_ROOT_REGISTRY_DIRECTORY,
  PROCESS_JOBS_ROOT_REGISTRY_FAILED_FILE,
  PROCESS_JOBS_ROOT_REGISTRY_FILE,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_RECOVERY_ENTRIES,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENTS,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENT_BYTES,
  PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE,
  PROCESS_JOBS_ROOT_REGISTRY_RECOVERY_DIRECTORY,
  assertProcessJobsRegistryDisjointFromPaths,
  attestProcessJobsRootRegistrySnapshot,
  freezeProcessJobsRootRegistry,
  loadProcessJobsRootRegistryProtection,
  processJobsRootRegistryPaths,
  registerProcessJobsRoot,
} from "../process-jobs-root-registry.js";

const temporaryDirectories: string[] = [];
const ownerships: Array<{
  ownership: Awaited<ReturnType<typeof acquireAgentRootOwnership>>;
  leasePath: string;
}> = [];

afterEach(async () => {
  const held = ownerships.splice(0);
  for (const { ownership } of held) ownership.release();
  await Promise.all(held.map(async ({ leasePath }) => {
    await vi.waitFor(async () => {
      await expect(readdir(dirname(leasePath))).resolves.toEqual([]);
    }, { timeout: 2_000, interval: 10 });
  }));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("durable monotonic process-job root registry", () => {
  it.each([
    {
      label: "default state root inside an agent-root workspace",
      workspace: (fixture: RegistryFixture) => fixture.root,
      stateDir: (fixture: RegistryFixture) => join(fixture.root, ".mono-agent", "process-jobs"),
      rootKey: ".mono-agent/process-jobs",
    },
    {
      label: "custom private state root inside a narrower workspace",
      workspace: (fixture: RegistryFixture) => fixture.workspace,
      stateDir: (fixture: RegistryFixture) => join(fixture.workspace, ".private", "process-jobs"),
      rootKey: "workspace/.private/process-jobs",
    },
  ])("registers the $label", async ({ workspace: workspaceFor, stateDir: stateDirFor, rootKey }) => {
    const fixture = await registryFixture(`workspace-positive-${rootKey.replaceAll("/", "-")}`);
    const workspace = workspaceFor(fixture);
    const stateDir = stateDirFor(fixture);
    const ownership = await acquireRegistryOwnership(fixture, workspace);

    const registration = await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace,
      stateDir,
      coordinator: ownership.coordinator,
    });

    expect(registration.rootKey).toBe(rootKey);
    expect(registration.snapshot.generation.rootKeys).toContain(rootKey);
    expect(registration.snapshot.protectedRoots).toContain(stateDir);
  });

  it.each([
    {
      label: "state root equal to the workspace",
      workspace: (fixture: RegistryFixture) => fixture.workspace,
      stateDir: (fixture: RegistryFixture) => fixture.workspace,
    },
    {
      label: "state root containing the workspace",
      workspace: (fixture: RegistryFixture) => join(fixture.root, "model-area", "workspace"),
      stateDir: (fixture: RegistryFixture) => join(fixture.root, "model-area"),
    },
  ])("rejects a $label before publishing a manifest", async ({ workspace: workspaceFor, stateDir: stateDirFor }) => {
    const fixture = await registryFixture("workspace-negative");
    const workspace = workspaceFor(fixture);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const stateDir = stateDirFor(fixture);
    const ownership = await acquireRegistryOwnership(fixture, workspace);

    await expect(registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace,
      stateDir,
      coordinator: ownership.coordinator,
    })).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    await expect(lstat(processJobsRootRegistryPaths(fixture.root).manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is absent only while empty, then retains sorted A-to-B roots across disable and restart", async () => {
    const fixture = await registryFixture("retention");
    const empty = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    expect(empty).toMatchObject({ kind: "empty", roots: [], protectedRoots: [] });
    await expect(lstat(processJobsRootRegistryPaths(fixture.root).registryDir)).rejects.toMatchObject({ code: "ENOENT" });

    const ownership = await acquireAgentRootOwnership(fixture.root, { homeDir: fixture.home });
    ownerships.push({
      ownership,
      leasePath: agentRootLeasePath(ownership.agentRoot, fixture.home),
    });
    ownership.coordinator.synchronizeGeneration(empty.generation);
    const rootB = join(fixture.root, ".state", "b");
    const rootA = join(fixture.root, ".state", "a");
    await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: rootB,
      coordinator: ownership.coordinator,
    });
    const registered = await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: rootA,
      coordinator: ownership.coordinator,
    });

    expect(registered.snapshot.generation.rootKeys).toEqual([".state/a", ".state/b"]);
    expect(registered.snapshot.protectedRoots).toEqual(expect.arrayContaining([
      registered.snapshot.registryDir,
      registered.snapshot.mutationLockPath,
      rootA,
      rootB,
    ]));
    expect((await lstat(registered.snapshot.registryDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(registered.snapshot.manifestPath)).mode & 0o777).toBe(0o600);

    // Disabled configuration does not mutate the registry. A fresh loader is
    // the restart boundary and must keep both formerly active roots sealed.
    ownership.release();
    const afterDisableAndRestart = await loadProcessJobsRootRegistryProtection(
      fixture.root,
      fixture.workspace,
    );
    expect(afterDisableAndRestart).toMatchObject({
      kind: "ready",
      generation: { rootKeys: [".state/a", ".state/b"] },
    });
  });

  it.each([
    ["root count", () => Array.from({ length: PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS + 1 }, (_, index) => [`.r${String(index).padStart(2, "0")}`])],
    ["segment count", () => [Array.from({ length: PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENTS + 1 }, () => "s")]],
    ["segment bytes", () => [["x".repeat(PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENT_BYTES + 1)]]],
    ["relative root bytes", () => [Array.from({ length: 21 }, () => "x".repeat(100))]],
  ] as const)("fails closed when the manifest exceeds the %s bound", async (_label, roots) => {
    const fixture = await registryFixture("bounds");
    await writeManifest(fixture.root, roots());

    const snapshot = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    expect(snapshot).toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
      generation: { rootKeys: [] },
    });
    expect(snapshot.kind).toBe("failed");
    if (snapshot.kind === "failed") expect(snapshot.error).not.toContain(fixture.root);
  });

  it("fails closed before parsing an over-byte manifest", async () => {
    const fixture = await registryFixture("byte-bound");
    const paths = await createRegistryDirectory(fixture.root);
    await writeFile(paths.manifestPath, Buffer.alloc(PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES + 1, 0x20), { mode: 0o600 });

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
    });
  });

  it.each(["permissions", "symlink", "hardlink"] as const)(
    "rejects an unsafe %s manifest without exposing its pathname in the provider error",
    async (unsafeKind) => {
      const fixture = await registryFixture(`unsafe-${unsafeKind}`);
      const paths = await writeManifest(fixture.root, [[".state", "jobs"]]);
      if (unsafeKind === "permissions") {
        await chmod(paths.manifestPath, 0o644);
      } else if (unsafeKind === "symlink") {
        const target = join(fixture.root, "outside.json");
        await writeFile(target, "{}", { mode: 0o600 });
        await rm(paths.manifestPath);
        await symlink(target, paths.manifestPath);
      } else {
        const alias = join(fixture.root, "manifest-hardlink.json");
        await link(paths.manifestPath, alias);
      }

      const snapshot = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
      expect(snapshot).toMatchObject({ kind: "failed", error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR });
      expect(snapshot.kind).toBe("failed");
      if (snapshot.kind === "failed") expect(snapshot.error).not.toContain(fixture.root);
    },
  );

  it("detects a pathname ABA replacement even when manifest bytes are unchanged", async () => {
    const fixture = await registryFixture("aba");
    const ownership = await acquireAgentRootOwnership(fixture.root, { homeDir: fixture.home });
    ownerships.push({
      ownership,
      leasePath: agentRootLeasePath(ownership.agentRoot, fixture.home),
    });
    const empty = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    ownership.coordinator.synchronizeGeneration(empty.generation);
    const registration = await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: join(fixture.root, ".state", "jobs"),
      coordinator: ownership.coordinator,
    });
    const replacement = join(registration.snapshot.registryDir, ".replacement");
    await writeFile(replacement, registration.snapshot.manifestContents, { mode: 0o600 });
    await rename(replacement, registration.snapshot.manifestPath);

    await expect(attestProcessJobsRootRegistrySnapshot(
      registration.snapshot,
      fixture.workspace,
    )).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    ownership.release();
  });

  it("keeps a crash-partial empty directory provider-zero until registration recovers it", async () => {
    const fixture = await registryFixture("crash-partial");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await mkdir(paths.registryDir, { recursive: true, mode: 0o700 });

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
      protectedRoots: expect.arrayContaining([paths.registryDir, paths.mutationLockPath]),
    });

    const ownership = await acquireUncheckedRegistryOwnership(fixture);
    const stateDir = join(fixture.root, ".state", "recovered");
    const registration = await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir,
      coordinator: ownership.coordinator,
    });

    expect(registration.snapshot.generation.rootKeys).toEqual([".state/recovered"]);
    await expect(lstat(registration.snapshot.manifestPath)).resolves.toBeDefined();
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await expect(lstat(stateDir)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("cleans an injected first-registration failure before retry permits root creation", async () => {
    const fixture = await registryFixture("first-registration-failure");
    const paths = processJobsRootRegistryPaths(fixture.root);
    const ownership = await acquireRegistryOwnership(fixture, fixture.workspace);
    const stateDir = join(fixture.root, ".state", "jobs");
    const registerThenCreateRoot = async (failAfterDirectoryCreation: boolean) => {
      const registration = await registerProcessJobsRoot({
        agentRoot: fixture.root,
        workspace: fixture.workspace,
        stateDir,
        coordinator: ownership.coordinator,
        ...(failAfterDirectoryCreation
          ? { hooks: { afterRegistryDirectoryCreated: () => { throw new Error("injected crash gap"); } } }
          : {}),
      });
      await expect(lstat(registration.snapshot.manifestPath)).resolves.toBeDefined();
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      return registration;
    };

    await expect(registerThenCreateRoot(true)).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    await expect(lstat(paths.registryDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "empty",
      roots: [],
    });

    const registration = await registerThenCreateRoot(false);
    expect(registration.snapshot.generation.rootKeys).toEqual([".state/jobs"]);
    await expect(lstat(stateDir)).resolves.toBeDefined();
  });

  it("never cleans a crash-partial registry directory containing an unknown entry", async () => {
    const fixture = await registryFixture("crash-partial-unknown-entry");
    const paths = await createRegistryDirectory(fixture.root);
    const unknownPath = join(paths.registryDir, "unknown");
    await writeFile(unknownPath, "unknown\n", { mode: 0o600 });
    const ownership = await acquireUncheckedRegistryOwnership(fixture);
    const stateDir = join(fixture.root, ".state", "must-not-open");

    await expect(registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir,
      coordinator: ownership.coordinator,
    })).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

    await expect(lstat(unknownPath)).resolves.toBeDefined();
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
    });
  });

  it("lets a valid current target win and idempotently removes only proven recovery artifacts", async () => {
    const { fixture, registration } = await registeredRegistry("current-wins");
    const paths = processJobsRootRegistryPaths(fixture.root);
    const currentBefore = await captureRegistryBoundary(paths);
    await Promise.all([
      writeRecoveryCopy(paths.stagingPath, registration.snapshot.manifestContents),
      writeRecoveryCopy(paths.previousPath, registration.snapshot.manifestContents),
      writeRecoveryCopy(paths.failedPath, registration.snapshot.manifestContents),
    ]);

    const recovered = await freezeAndRelease(fixture);
    expect(recovered).toMatchObject({ kind: "ready" });
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
    expect(await capturePathEvidence(paths.manifestPath)).toEqual(
      currentBefore.paths.find((entry) => entry.path === paths.manifestPath),
    );

    const repeated = await freezeAndRelease(fixture);
    expect(repeated).toMatchObject({
      kind: "ready",
      generation: { id: registration.snapshot.generation.id },
    });
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
  });

  it("restores a valid previous target from an empty registry and cleans staging and failed artifacts", async () => {
    const { fixture, registration } = await registeredRegistry("restore-previous");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await rename(paths.manifestPath, paths.previousPath);
    const previousIdentity = await lstat(paths.previousPath, { bigint: true });
    await Promise.all([
      writeRecoveryCopy(paths.stagingPath, registration.snapshot.manifestContents),
      writeRecoveryCopy(paths.failedPath, registration.snapshot.manifestContents),
    ]);
    const beforeRequest = await captureRegistryBoundary(paths);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
    });
    expect(await captureRegistryBoundary(paths)).toEqual(beforeRequest);

    const recovered = await freezeAndRelease(fixture);
    expect(recovered).toMatchObject({
      kind: "ready",
      generation: { id: registration.snapshot.generation.id },
    });
    const restored = await lstat(paths.manifestPath, { bigint: true });
    expect({ dev: restored.dev, ino: restored.ino, nlink: restored.nlink }).toEqual({
      dev: previousIdentity.dev,
      ino: previousIdentity.ino,
      nlink: 1n,
    });
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);

    const repeated = await freezeAndRelease(fixture);
    expect(repeated).toMatchObject({ kind: "ready" });
    expect((await lstat(paths.manifestPath, { bigint: true })).ino).toBe(restored.ino);
  });

  it.each(["freeze", "register"] as const)(
    "completes an exact same-inode mid-restore pair before the next locked %s mutation",
    async (mutation) => {
      const { fixture, ownership, registration } = await registeredRegistry(`mid-restore-${mutation}`);
      const paths = processJobsRootRegistryPaths(fixture.root);
      await rename(paths.manifestPath, paths.previousPath);
      await link(paths.previousPath, paths.manifestPath);
      const [targetPair, previousPair] = await Promise.all([
        lstat(paths.manifestPath, { bigint: true }),
        lstat(paths.previousPath, { bigint: true }),
      ]);
      expect({
        sameDevice: targetPair.dev === previousPair.dev,
        sameInode: targetPair.ino === previousPair.ino,
        targetLinks: targetPair.nlink,
        previousLinks: previousPair.nlink,
        sameBytes: (await readFile(paths.manifestPath)).equals(await readFile(paths.previousPath)),
      }).toEqual({
        sameDevice: true,
        sameInode: true,
        targetLinks: 2n,
        previousLinks: 2n,
        sameBytes: true,
      });
      const beforeRequest = await captureRegistryBoundary(paths);

      await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
        kind: "failed",
        error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
      });
      expect(await captureRegistryBoundary(paths)).toEqual(beforeRequest);

      const recovered = mutation === "freeze"
        ? await freezeAndRelease(fixture)
        : (await registerProcessJobsRoot({
            agentRoot: fixture.root,
            workspace: fixture.workspace,
            stateDir: join(fixture.root, ".state", "next"),
            coordinator: ownership.coordinator,
          })).snapshot;
      expect(recovered).toMatchObject({
        kind: "ready",
        generation: {
          rootKeys: mutation === "freeze" ? [".state/jobs"] : [".state/jobs", ".state/next"],
        },
      });
      await expect(lstat(paths.previousPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(paths.manifestPath, { bigint: true })).nlink).toBe(1n);
      await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
      await expect(freezeAndRelease(fixture)).resolves.toMatchObject({ kind: "ready" });
    },
  );

  it("restores a valid previous manifest when its empty target directory is absent", async () => {
    const { fixture, registration } = await registeredRegistry("restore-previous-missing-directory");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await rename(paths.manifestPath, paths.previousPath);
    const previousIdentity = await lstat(paths.previousPath, { bigint: true });
    await rmdir(paths.registryDir);
    const beforeRequest = await captureRegistryBoundary(paths);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
    });
    expect(await captureRegistryBoundary(paths)).toEqual(beforeRequest);

    await expect(freezeAndRelease(fixture)).resolves.toMatchObject({
      kind: "ready",
      generation: { id: registration.snapshot.generation.id },
    });
    const restored = await lstat(paths.manifestPath, { bigint: true });
    expect({ dev: restored.dev, ino: restored.ino, nlink: restored.nlink }).toEqual({
      dev: previousIdentity.dev,
      ino: previousIdentity.ino,
      nlink: 1n,
    });
    expect((await lstat(paths.registryDir)).mode & 0o777).toBe(0o700);
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
  });

  it("leaves an unrelated two-link target untouched instead of treating it as interrupted restore", async () => {
    const { fixture } = await registeredRegistry("unrelated-target-hardlink");
    const paths = processJobsRootRegistryPaths(fixture.root);
    const unrelatedAlias = join(fixture.root, "unrelated-registry-hardlink.json");
    await link(paths.manifestPath, unrelatedAlias);
    const before = await captureRegistryBoundary(paths, [unrelatedAlias]);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
    });
    expect(await captureRegistryBoundary(paths, [unrelatedAlias])).toEqual(before);
    await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
      .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(await captureRegistryBoundary(paths, [unrelatedAlias])).toEqual(before);
  });

  it("fails closed on a failed-only publication because no authoritative generation is provable", async () => {
    const { fixture } = await registeredRegistry("failed-only");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await rename(paths.manifestPath, paths.failedPath);
    const stranded = await captureRegistryBoundary(paths);

    await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
      .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(await captureRegistryBoundary(paths)).toEqual(stranded);
    const request = await loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace);
    expect(request).toMatchObject({
      kind: "failed",
      protectedRoots: expect.arrayContaining([paths.registryDir, paths.recoveryDir, paths.mutationLockPath]),
    });
  });

  it.each(["failed-only", "invalid-fixed-previous", "unrecognized"] as const)(
    "blocks registration before fixed-name reuse when recovery evidence is %s",
    async (evidence) => {
      const { fixture, ownership } = await registeredRegistry(`blocked-publication-${evidence}`);
      const paths = processJobsRootRegistryPaths(fixture.root);
      const extras: string[] = [];
      if (evidence === "failed-only") {
        await rename(paths.manifestPath, paths.failedPath);
      } else if (evidence === "invalid-fixed-previous") {
        await writeFile(paths.previousPath, "invalid fixed evidence\n", { mode: 0o600 });
        await chmod(paths.previousPath, 0o600);
      } else {
        const unknownPath = join(paths.recoveryDir, "unrecognized.json");
        await writeFile(unknownPath, "unrecognized evidence\n", { mode: 0o600 });
        extras.push(unknownPath);
      }
      const before = await captureRegistryBoundary(paths, extras);
      const unpublishedRoot = join(fixture.root, ".state", "must-not-publish");

      await expect(registerProcessJobsRoot({
        agentRoot: fixture.root,
        workspace: fixture.workspace,
        stateDir: unpublishedRoot,
        coordinator: ownership.coordinator,
      })).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

      expect(await captureRegistryBoundary(paths, extras)).toEqual(before);
      await expect(lstat(unpublishedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rechecks the drained fixed-name namespace immediately before secure replacement", async () => {
    const fixture = await registryFixture("pre-replace-drain-proof");
    const paths = processJobsRootRegistryPaths(fixture.root);
    const ownership = await acquireRegistryOwnership(fixture, fixture.workspace);
    const unpublishedRoot = join(fixture.root, ".state", "must-not-publish");
    const fixedEvidence = Buffer.from("invalid evidence introduced after initial recovery\n", "utf8");

    await expect(registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: unpublishedRoot,
      coordinator: ownership.coordinator,
      hooks: {
        afterRegistryDirectoryCreated: async () => {
          await writeFile(paths.previousPath, fixedEvidence, { mode: 0o600 });
          await chmod(paths.previousPath, 0o600);
        },
      },
    })).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

    await expect(readFile(paths.previousPath)).resolves.toEqual(fixedEvidence);
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE]);
    await expect(lstat(paths.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.failedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(unpublishedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a valid staging-only artifact under the mutation lock and remains idempotently empty", async () => {
    const fixture = await registryFixture("staging-only");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await createRecoveryDirectory(paths);
    await writeRecoveryCopy(paths.stagingPath, validManifestContents([[".state", "jobs"]]));
    const beforeRequest = await captureRegistryBoundary(paths);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      protectedRoots: expect.arrayContaining([paths.recoveryDir]),
    });
    expect(await captureRegistryBoundary(paths)).toEqual(beforeRequest);

    await expect(freezeAndRelease(fixture)).resolves.toMatchObject({ kind: "empty" });
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
    await expect(freezeAndRelease(fixture)).resolves.toMatchObject({ kind: "empty" });

    const ownership = await acquireRegistryOwnership(fixture, fixture.workspace);
    const registered = await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: join(fixture.root, ".state", "fresh"),
      coordinator: ownership.coordinator,
    });
    expect(registered.snapshot.generation.rootKeys).toEqual([".state/fresh"]);
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
  });

  it.each(["permissions", "symlink", "hardlink"] as const)(
    "fails closed without mutating an invalid previous artifact with unsafe %s",
    async (unsafeKind) => {
      const { fixture, registration } = await registeredRegistry(`unsafe-previous-${unsafeKind}`);
      const paths = processJobsRootRegistryPaths(fixture.root);
      await rename(paths.manifestPath, paths.previousPath);
      if (unsafeKind === "permissions") {
        await chmod(paths.previousPath, 0o644);
      } else if (unsafeKind === "symlink") {
        const outside = join(fixture.root, "outside-previous.json");
        await writeRecoveryCopy(outside, registration.snapshot.manifestContents);
        await rm(paths.previousPath);
        await symlink(outside, paths.previousPath);
      } else {
        await link(paths.previousPath, join(fixture.root, "previous-hardlink.json"));
      }
      const stranded = await captureRegistryBoundary(paths);

      await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
        .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      expect(await captureRegistryBoundary(paths)).toEqual(stranded);
      await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
        kind: "failed",
      });
    },
  );

  it("never overwrites a corrupt current target with a valid previous artifact", async () => {
    const { fixture, registration } = await registeredRegistry("corrupt-current");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await writeRecoveryCopy(paths.previousPath, registration.snapshot.manifestContents);
    await writeFile(paths.manifestPath, "{not-json\n", { mode: 0o600 });
    const stranded = await captureRegistryBoundary(paths);

    await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
      .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(await captureRegistryBoundary(paths)).toEqual(stranded);
    expect(await readFile(paths.manifestPath, "utf8")).toBe("{not-json\n");
  });

  it("fails closed and read-only on an unknown recovery entry", async () => {
    const { fixture } = await registeredRegistry("unknown-recovery-entry");
    const paths = processJobsRootRegistryPaths(fixture.root);
    const unknownPath = join(paths.recoveryDir, "unknown.json");
    await writeFile(unknownPath, "unknown\n", { mode: 0o600 });
    const before = await captureRegistryBoundary(paths, [unknownPath]);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      protectedRoots: expect.arrayContaining([paths.recoveryDir]),
    });
    expect(await captureRegistryBoundary(paths, [unknownPath])).toEqual(before);
    await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
      .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(await captureRegistryBoundary(paths, [unknownPath])).toEqual(before);
  });

  it("fails closed without repairing an unsafe recovery directory", async () => {
    const { fixture } = await registeredRegistry("unsafe-recovery-directory");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await chmod(paths.recoveryDir, 0o755);
    const before = await captureRegistryBoundary(paths);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
    });
    await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
      .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(await captureRegistryBoundary(paths)).toEqual(before);
    expect((await lstat(paths.recoveryDir)).mode & 0o777).toBe(0o755);
  });

  it("stops and fails closed when the recovery directory exceeds three entries", async () => {
    expect(PROCESS_JOBS_ROOT_REGISTRY_MAX_RECOVERY_ENTRIES).toBe(3);
    const { fixture, registration } = await registeredRegistry("recovery-entry-bound");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await Promise.all([
      writeRecoveryCopy(paths.stagingPath, registration.snapshot.manifestContents),
      writeRecoveryCopy(paths.previousPath, registration.snapshot.manifestContents),
      writeRecoveryCopy(paths.failedPath, registration.snapshot.manifestContents),
      writeFile(join(paths.recoveryDir, "fourth.json"), "fourth\n", { mode: 0o600 }),
    ]);
    const before = await captureRegistryBoundary(paths, [join(paths.recoveryDir, "fourth.json")]);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
    });
    await expect(freezeProcessJobsRootRegistry(fixture.root, fixture.workspace))
      .rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(await captureRegistryBoundary(paths, [join(paths.recoveryDir, "fourth.json")])).toEqual(before);
  });

  it("keeps recognized recovery identities and bytes unchanged during request-side failure", async () => {
    const { fixture, registration } = await registeredRegistry("request-read-only");
    const paths = processJobsRootRegistryPaths(fixture.root);
    await writeRecoveryCopy(paths.previousPath, registration.snapshot.manifestContents);
    const before = await captureRegistryBoundary(paths);

    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
      error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
    });
    expect(await captureRegistryBoundary(paths)).toEqual(before);
  });

  it("recovers a compound post-publish and restoration failure on a later locked mutation", async () => {
    const { fixture, ownership } = await registeredRegistry("compound-recovery");
    const paths = processJobsRootRegistryPaths(fixture.root);
    const nextStateDir = join(fixture.root, ".state", "next");
    let recoveryCalls = 0;

    await expect(registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: nextStateDir,
      coordinator: ownership.coordinator,
      hooks: {
        afterManifestPublish: () => { throw new Error("injected afterPublish failure"); },
        beforeManifestRestore: () => { throw new Error("injected restoration failure"); },
        beforeRegistryRecovery: () => {
          recoveryCalls += 1;
          if (recoveryCalls === 2) throw new Error("injected interrupted recovery");
        },
      },
    })).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

    expect(recoveryCalls).toBe(2);
    await expect(readdir(paths.registryDir)).resolves.toEqual([]);
    await expect(readdir(paths.recoveryDir).then((entries) => entries.sort())).resolves.toEqual([
      PROCESS_JOBS_ROOT_REGISTRY_FAILED_FILE,
      PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE,
    ]);
    const stranded = await captureRegistryBoundary(paths);
    await expect(loadProcessJobsRootRegistryProtection(fixture.root, fixture.workspace)).resolves.toMatchObject({
      kind: "failed",
    });
    expect(await captureRegistryBoundary(paths)).toEqual(stranded);

    const recovered = await registerProcessJobsRoot({
      agentRoot: fixture.root,
      workspace: fixture.workspace,
      stateDir: nextStateDir,
      coordinator: ownership.coordinator,
    });
    expect(recovered.snapshot.generation.rootKeys).toEqual([".state/jobs", ".state/next"]);
    await expect(readdir(paths.recoveryDir)).resolves.toEqual([]);
    expect((await lstat(paths.recoveryDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.manifestPath)).mode & 0o777).toBe(0o600);
  });

  it("protects and rejects lexical recovery overlap plus symlinked aliases", async () => {
    const { fixture, ownership, registration } = await registeredRegistry("recovery-overlap");
    const paths = processJobsRootRegistryPaths(fixture.root);
    expect(paths.recoveryDir).toBe(join(
      fixture.root,
      ".mono-agent",
      PROCESS_JOBS_ROOT_REGISTRY_RECOVERY_DIRECTORY,
    ));
    expect(registration.snapshot.protectedRoots).toContain(paths.recoveryDir);
    expect(() => assertProcessJobsRegistryDisjointFromPaths(
      registration.snapshot,
      [join(paths.recoveryDir, "purge-child")],
    )).toThrow("overlaps retained process-job private state");
    const manifestBefore = await readFile(paths.manifestPath);
    const recoveryAlias = join(fixture.root, "recovery-directory-alias");
    await symlink(paths.recoveryDir, recoveryAlias, "dir");

    for (const stateDir of [
      paths.recoveryDir,
      join(paths.recoveryDir, "nested"),
      recoveryAlias,
      join(recoveryAlias, "nested"),
    ]) {
      await expect(registerProcessJobsRoot({
        agentRoot: fixture.root,
        workspace: fixture.workspace,
        stateDir,
        coordinator: ownership.coordinator,
      })).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    expect(await readFile(paths.manifestPath)).toEqual(manifestBefore);
  });
});

async function registeredRegistry(label: string) {
  const fixture = await registryFixture(label);
  const ownership = await acquireRegistryOwnership(fixture, fixture.workspace);
  const registration = await registerProcessJobsRoot({
    agentRoot: fixture.root,
    workspace: fixture.workspace,
    stateDir: join(fixture.root, ".state", "jobs"),
    coordinator: ownership.coordinator,
  });
  return { fixture, ownership, registration };
}

async function freezeAndRelease(
  fixture: RegistryFixture,
): Promise<Awaited<ReturnType<typeof freezeProcessJobsRootRegistry>>["snapshot"]> {
  const frozen = await freezeProcessJobsRootRegistry(fixture.root, fixture.workspace);
  try {
    return frozen.snapshot;
  } finally {
    await frozen.release();
  }
}

async function createRecoveryDirectory(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
): Promise<void> {
  await mkdir(dirname(paths.recoveryDir), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.recoveryDir), 0o700);
  await mkdir(paths.recoveryDir, { mode: 0o700 });
  await chmod(paths.recoveryDir, 0o700);
}

async function writeRecoveryCopy(path: string, contents: Buffer): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

function validManifestContents(roots: readonly (readonly string[])[]): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema: "mono-agent.process-jobs-roots.v1",
    generation: randomUUID(),
    roots,
  }, null, 2)}\n`, "utf8");
}

interface PathEvidence {
  readonly path: string;
  readonly kind: "missing" | "file" | "directory" | "symlink" | "other";
  readonly dev?: bigint;
  readonly ino?: bigint;
  readonly mode?: bigint;
  readonly nlink?: bigint;
  readonly size?: bigint;
  readonly mtimeNs?: bigint;
  readonly ctimeNs?: bigint;
  readonly contentsBase64?: string;
}

interface RegistryBoundaryEvidence {
  readonly registryEntries: readonly string[] | null;
  readonly recoveryEntries: readonly string[] | null;
  readonly paths: readonly PathEvidence[];
}

async function captureRegistryBoundary(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  extras: readonly string[] = [],
): Promise<RegistryBoundaryEvidence> {
  const evidencePaths = [...new Set([
    paths.registryDir,
    paths.recoveryDir,
    paths.manifestPath,
    paths.stagingPath,
    paths.previousPath,
    paths.failedPath,
    ...extras,
  ])].sort();
  return {
    registryEntries: await readDirectoryEntries(paths.registryDir),
    recoveryEntries: await readDirectoryEntries(paths.recoveryDir),
    paths: await Promise.all(evidencePaths.map(capturePathEvidence)),
  };
}

async function readDirectoryEntries(path: string): Promise<readonly string[] | null> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function capturePathEvidence(path: string): Promise<PathEvidence> {
  let details: BigIntStats;
  try {
    details = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { path, kind: "missing" };
    throw error;
  }
  const kind = details.isSymbolicLink() ? "symlink"
    : details.isFile() ? "file"
      : details.isDirectory() ? "directory" : "other";
  return {
    path,
    kind,
    dev: details.dev,
    ino: details.ino,
    mode: details.mode & 0o777n,
    nlink: details.nlink,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
    ...(kind === "file" ? { contentsBase64: (await readFile(path)).toString("base64") } : {}),
  };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null
    && (error as { readonly code?: unknown }).code === code;
}

interface RegistryFixture {
  root: string;
  workspace: string;
  home: string;
}

async function registryFixture(label: string): Promise<RegistryFixture> {
  const parent = await mkdtemp(join(tmpdir(), `mono-agent-registry-${label}-`));
  temporaryDirectories.push(parent);
  const lexicalRoot = join(parent, "agent");
  const lexicalWorkspace = join(lexicalRoot, "workspace");
  const home = join(parent, "home");
  await Promise.all([
    mkdir(lexicalWorkspace, { recursive: true, mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
  ]);
  const root = await realpath(lexicalRoot);
  const workspace = await realpath(lexicalWorkspace);
  return { root, workspace, home };
}

async function acquireRegistryOwnership(
  fixture: RegistryFixture,
  workspace: string,
): Promise<Awaited<ReturnType<typeof acquireAgentRootOwnership>>> {
  const ownership = await acquireAgentRootOwnership(fixture.root, { homeDir: fixture.home });
  ownerships.push({
    ownership,
    leasePath: agentRootLeasePath(ownership.agentRoot, fixture.home),
  });
  const empty = await loadProcessJobsRootRegistryProtection(fixture.root, workspace);
  expect(empty).toMatchObject({ kind: "empty" });
  ownership.coordinator.synchronizeGeneration(empty.generation);
  return ownership;
}

async function acquireUncheckedRegistryOwnership(
  fixture: RegistryFixture,
): Promise<Awaited<ReturnType<typeof acquireAgentRootOwnership>>> {
  const ownership = await acquireAgentRootOwnership(fixture.root, { homeDir: fixture.home });
  ownerships.push({
    ownership,
    leasePath: agentRootLeasePath(ownership.agentRoot, fixture.home),
  });
  return ownership;
}

async function createRegistryDirectory(root: string): Promise<ReturnType<typeof processJobsRootRegistryPaths>> {
  const paths = processJobsRootRegistryPaths(root);
  expect(paths.registryDir).toBe(join(root, ".mono-agent", PROCESS_JOBS_ROOT_REGISTRY_DIRECTORY));
  expect(paths.manifestPath).toBe(join(paths.registryDir, PROCESS_JOBS_ROOT_REGISTRY_FILE));
  await mkdir(paths.registryDir, { recursive: true, mode: 0o700 });
  await chmod(join(root, ".mono-agent"), 0o700);
  await chmod(paths.registryDir, 0o700);
  return paths;
}

async function writeManifest(
  root: string,
  roots: readonly (readonly string[])[],
): Promise<ReturnType<typeof processJobsRootRegistryPaths>> {
  const paths = await createRegistryDirectory(root);
  await writeFile(paths.manifestPath, `${JSON.stringify({
    schema: "mono-agent.process-jobs-roots.v1",
    generation: randomUUID(),
    roots,
  })}\n`, { mode: 0o600 });
  await chmod(paths.manifestPath, 0o600);
  return paths;
}

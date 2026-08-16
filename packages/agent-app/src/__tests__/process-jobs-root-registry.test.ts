import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
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
  PROCESS_JOBS_ROOT_REGISTRY_FILE,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENTS,
  PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENT_BYTES,
  attestProcessJobsRootRegistrySnapshot,
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
});

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

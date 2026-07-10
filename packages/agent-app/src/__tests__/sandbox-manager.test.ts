import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeAdapterMocks = vi.hoisted(() => ({
  createSrtSandboxEngine: vi.fn(),
}));

vi.mock("@mono-agent/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/runtime-adapter")>();
  runtimeAdapterMocks.createSrtSandboxEngine.mockImplementation(actual.createSrtSandboxEngine);
  return { ...actual, createSrtSandboxEngine: runtimeAdapterMocks.createSrtSandboxEngine };
});

import {
  MANAGED_SRT_LOCK_SHA256,
  MANAGED_SRT_MARKER,
  MANAGED_SRT_PACKAGE,
  MANAGED_SRT_VERSION,
  checkSandboxRuntime,
  managedSrtInstallRoot,
  sandboxRuntimeStatus,
  setupManagedSrt,
  type ManagedSrtHooks,
  type SandboxManagerOptions,
} from "../sandbox-manager.js";

const resourceRoot = fileURLToPath(new URL("../../resources/srt", import.meta.url));
const tempDirs: string[] = [];
let trustedNodePath = "";

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "managed-srt-test-"));
  tempDirs.push(directory);
  return directory;
}

beforeEach(async () => {
  runtimeAdapterMocks.createSrtSandboxEngine.mockClear();
  const launchRoot = await tempDir();
  trustedNodePath = resolve(launchRoot, "node");
  // process.execPath permissions and hard-link count belong to the host (for
  // example, CI toolcaches), so setup tests use a test-owned trusted launcher.
  await writeFile(trustedNodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(trustedNodePath, 0o700);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeInstall(stagingRoot: string): Promise<void> {
  const packageRoot = resolve(stagingRoot, "node_modules", "@anthropic-ai", "sandbox-runtime");
  await mkdir(resolve(packageRoot, "dist"), { recursive: true });
  await writeFile(resolve(packageRoot, "dist", "cli.js"), "// fixture cli\n", { mode: 0o600 });
  await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify({
    name: MANAGED_SRT_PACKAGE,
    version: MANAGED_SRT_VERSION,
  })}\n`, { mode: 0o600 });
  await writeFile(resolve(stagingRoot, "node_modules", "fixture-dependency.js"), "export default true;\n", { mode: 0o600 });
}

async function hashFixtureTree(installRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directoryPath: string): Promise<void> {
    const directory = await opendir(directoryPath);
    const entries = [];
    for await (const entry of directory) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      const relativePath = relative(installRoot, path);
      if (relativePath === MANAGED_SRT_MARKER || relativePath === "node_modules/.package-lock.json") {
        continue;
      }
      const entryStat = await lstat(path);
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(path);
      } else if (entryStat.isFile()) {
        hash.update(`F\0${relativePath}\0${entryStat.size}\0`);
        hash.update(await readFile(path));
      } else {
        throw new Error(`Unsupported fixture entry: ${relativePath}`);
      }
    }
  }
  await walk(installRoot);
  return hash.digest("hex");
}

function options(cacheRoot: string, hooks: ManagedSrtHooks = {}): SandboxManagerOptions {
  return {
    cacheRoot,
    platform: "darwin",
    nodePath: trustedNodePath,
    externalCommand: false,
    hooks: {
      installDependencies: fakeInstall,
      expectedTreeSha256: hashFixtureTree,
      ...hooks,
    },
  };
}

describe("managed SRT setup", () => {
  it("installs the exact locked tree into the private content-addressed cache", async () => {
    const cacheRoot = await tempDir();

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result).toMatchObject({ installed: true, repaired: false, status: { state: "ready", source: "managed" } });
    expect(result.status.installRoot).toBe(managedSrtInstallRoot({ cacheRoot, platform: "darwin" }));
    expect(await readFile(resolve(result.status.installRoot, "package-lock.json"), "utf8"))
      .toBe(await readFile(resolve(resourceRoot, "package-lock.json"), "utf8"));
  });

  it("rejects a group-writable Node executable before creating managed cache state", async () => {
    const cacheRoot = await tempDir();
    const unsafeRoot = await tempDir();
    const unsafeNodePath = resolve(unsafeRoot, "node");
    await writeFile(unsafeNodePath, "#!/bin/sh\nexit 0\n", { mode: 0o770 });
    await chmod(unsafeNodePath, 0o770);

    await expect(setupManagedSrt({
      ...options(cacheRoot),
      nodePath: unsafeNodePath,
      verify: false,
    })).rejects.toMatchObject({
      code: "managed_srt_corrupt",
      details: { cause: expect.stringContaining("writable by group or other users") },
    });
    expect(existsSync(resolve(cacheRoot, "mono-agent"))).toBe(false);
  });

  it("serializes concurrent installers and performs one dependency installation", async () => {
    const cacheRoot = await tempDir();
    let installs = 0;
    const hooks: ManagedSrtHooks = {
      async installDependencies(stagingRoot) {
        installs += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        await fakeInstall(stagingRoot);
      },
    };

    const results = await Promise.all([
      setupManagedSrt({ ...options(cacheRoot, hooks), verify: false }),
      setupManagedSrt({ ...options(cacheRoot, hooks), verify: false }),
      setupManagedSrt({ ...options(cacheRoot, hooks), verify: false }),
    ]);

    expect(installs).toBe(1);
    expect(results.every((result) => result.status.state === "ready")).toBe(true);
    expect(results.filter((result) => result.installed)).toHaveLength(1);
  });

  it("cleans staging and its owned lock when installation is interrupted", async () => {
    const cacheRoot = await tempDir();
    const controller = new AbortController();
    let entered = false;
    const install = setupManagedSrt({
      ...options(cacheRoot, {
        async installDependencies(_stagingRoot, signal) {
          entered = true;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
      verify: false,
      signal: controller.signal,
    });
    while (!entered) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    controller.abort(new Error("test interruption"));

    await expect(install).rejects.toMatchObject({ code: "managed_srt_install_failed" });
    const versionRoot = dirname(managedSrtInstallRoot({ cacheRoot, platform: "darwin" }));
    expect((await readdir(versionRoot)).filter((name) => name.includes("staging") || name === ".install.lock")).toEqual([]);
  });

  it("rejects a modified bundled lock before starting installation", async () => {
    const cacheRoot = await tempDir();
    const resources = await tempDir();
    await Promise.all([
      copyFile(resolve(resourceRoot, "package.json"), resolve(resources, "package.json")),
      copyFile(resolve(resourceRoot, "package-lock.json"), resolve(resources, "package-lock.json")),
    ]);
    await writeFile(resolve(resources, "package-lock.json"), "{}\n");

    await expect(setupManagedSrt({
      ...options(cacheRoot),
      resourceRoot: resources,
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_corrupt" });
    expect(existsSync(resolve(cacheRoot, "mono-agent"))).toBe(false);
  });

  it("quarantines a target symlink without touching its destination, then repairs", async () => {
    const cacheRoot = await tempDir();
    const outside = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    await mkdir(dirname(installRoot), { recursive: true, mode: 0o700 });
    await chmod(dirname(installRoot), 0o700);
    await symlink(outside, installRoot);

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result).toMatchObject({ installed: true, repaired: true, status: { state: "ready" } });
    expect(existsSync(outside)).toBe(true);
    expect((await readdir(dirname(installRoot))).some((name) => name.includes(".corrupt."))).toBe(true);
  });

  it("rejects a symlinked managed cache ancestor", async () => {
    const cacheRoot = await tempDir();
    const outside = await tempDir();
    await symlink(outside, resolve(cacheRoot, "mono-agent"));

    await expect(setupManagedSrt({ ...options(cacheRoot), verify: false })).rejects.toThrow(/owner-only directory|symbolic/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("marks post-install CLI corruption and never falls through to external SRT", async () => {
    const cacheRoot = await tempDir();
    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await writeFile(result.status.cliPath as string, "// corrupt\n", { mode: 0o600 });

    const status = await sandboxRuntimeStatus({
      ...options(cacheRoot),
      externalCommand: "/bin/true",
    });

    expect(status).toMatchObject({ state: "corrupt", source: "managed" });
  });

  it("detects corruption anywhere in the installed dependency tree", async () => {
    const cacheRoot = await tempDir();
    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await writeFile(resolve(result.status.installRoot, "node_modules", "fixture-dependency.js"), "export default false;\n", { mode: 0o600 });

    await expect(sandboxRuntimeStatus(options(cacheRoot)))
      .resolves.toMatchObject({ state: "corrupt", source: "managed" });
  });

  it("uses the managed absolute path with a launchd-minimal PATH", async () => {
    const cacheRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });

    const status = await sandboxRuntimeStatus({
      ...options(cacheRoot),
      env: { PATH: "/usr/bin:/bin" },
      externalCommand: false,
    });

    expect(status).toMatchObject({ state: "ready", source: "managed", nodePath: trustedNodePath });
    expect(status.cliPath).toMatch(/node_modules\/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/u);
  });

  it("reports managed status as corrupt if its selected Node launcher loses trust", async () => {
    const cacheRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });
    await chmod(trustedNodePath, 0o770);

    await expect(sandboxRuntimeStatus(options(cacheRoot))).resolves.toMatchObject({
      state: "corrupt",
      source: "managed",
      message: expect.stringContaining("writable by group or other users"),
    });
  });

  it("functionally checks the same trusted Node path reported by managed status", async () => {
    const cacheRoot = await tempDir();
    await setupManagedSrt({ ...options(cacheRoot), verify: false });
    runtimeAdapterMocks.createSrtSandboxEngine.mockReturnValueOnce({
      id: "srt",
      async isAvailable() {
        return false;
      },
      async prepareCommand() {
        throw new Error("unavailable engine must not prepare a command");
      },
    });

    await expect(checkSandboxRuntime(options(cacheRoot)))
      .rejects.toMatchObject({ code: "sandbox_check_failed" });
    expect(runtimeAdapterMocks.createSrtSandboxEngine).toHaveBeenCalledWith(expect.objectContaining({
      cacheRoot,
      managedNodePath: trustedNodePath,
      platform: "darwin",
    }));
  });

  it("removes only a proven-dead secure install lock before retrying", async () => {
    const cacheRoot = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    const versionRoot = dirname(installRoot);
    await mkdir(versionRoot, { recursive: true, mode: 0o700 });
    await chmod(versionRoot, 0o700);
    await writeFile(resolve(versionRoot, ".install.lock"), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999,
      uid: process.getuid?.() ?? null,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const result = await setupManagedSrt({
      ...options(cacheRoot, { processIsAlive: () => "dead" }),
      verify: false,
    });

    expect(result.status.state).toBe("ready");
    expect(existsSync(resolve(versionRoot, ".install.lock"))).toBe(false);
  });

  it("cleans a private staging directory left by a crashed installer after taking the lock", async () => {
    const cacheRoot = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    const versionRoot = dirname(installRoot);
    const staleStaging = resolve(versionRoot, `.${MANAGED_SRT_LOCK_SHA256}.staging.999999.${randomUUID()}`);
    await mkdir(staleStaging, { recursive: true, mode: 0o700 });
    await chmod(versionRoot, 0o700);
    await writeFile(resolve(staleStaging, "partial"), "partial", { mode: 0o600 });

    const result = await setupManagedSrt({ ...options(cacheRoot), verify: false });

    expect(result.status.state).toBe("ready");
    expect(existsSync(staleStaging)).toBe(false);
  });

  it("leaves a stale lock untouched if its identity changes during the unlink race", async () => {
    const cacheRoot = await tempDir();
    const installRoot = managedSrtInstallRoot({ cacheRoot, platform: "darwin" });
    const versionRoot = dirname(installRoot);
    const lockPath = resolve(versionRoot, ".install.lock");
    await mkdir(versionRoot, { recursive: true, mode: 0o700 });
    await chmod(versionRoot, 0o700);
    const initial = {
      schemaVersion: 1,
      pid: 999_998,
      uid: process.getuid?.() ?? null,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(initial)}\n`, { mode: 0o600 });

    await expect(setupManagedSrt({
      ...options(cacheRoot, {
        processIsAlive() {
          writeFileSync(lockPath, `${JSON.stringify({ ...initial, token: randomUUID() })}\n`, { mode: 0o600 });
          return "dead";
        },
      }),
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_lock_unsafe" });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("returns an actionable unsupported result without system automation off macOS", async () => {
    const cacheRoot = await tempDir();

    await expect(setupManagedSrt({
      cacheRoot,
      platform: "linux",
      externalCommand: false,
      verify: false,
    })).rejects.toMatchObject({ code: "managed_srt_unsupported" });
    await expect(sandboxRuntimeStatus({ cacheRoot, platform: "linux", externalCommand: false }))
      .resolves.toMatchObject({ state: "unsupported", source: "none" });
  });

  it("keeps the resource lock identity stable", async () => {
    const lock = await readFile(resolve(resourceRoot, "package-lock.json"));
    expect(createHash("sha256").update(lock).digest("hex")).toBe(MANAGED_SRT_LOCK_SHA256);
  });
});

import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveLaunchdLabel,
  launchdMaintenanceDispersionSeconds,
  launchdPathsFor,
  MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV,
  MANAGED_WEB_LOG_MAINTENANCE_ENV,
  webMaintenanceDispersionSeconds,
} from "../launchd.js";
import {
  acquireFilesystemLifecycleLock,
} from "../launchd-lifecycle-lock.js";
import {
  runLaunchdMaintenanceEntry,
} from "../launchd-maintenance-entry.js";
import type { LaunchdMaintenanceEntryDependencies } from "../launchd-maintenance-entry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("launchd maintenance lightweight entry", () => {
  it("uses the exact web marker and private argv before its dispersed heavy import", async () => {
    const calls: string[] = [];
    const { deps } = entryHarness({
      sleep: async () => { calls.push("dispersed"); },
      verifyEntrypoint: async () => { calls.push("attested"); },
      inspectWebHelper: async () => {
        calls.push("launchd-authenticated");
        return webHelperInfo();
      },
      loadWebHeavy: async () => {
        calls.push("web-heavy-imported");
        return {
          runWebLogMaintenanceCommand: async () => {
            calls.push("web-handler");
            return 9;
          },
        };
      },
    });
    const env = {
      [MANAGED_WEB_LOG_MAINTENANCE_ENV]: "1",
      PATH: "/usr/bin:/bin",
      SECRET: "removed",
    };
    await expect(runLaunchdMaintenanceEntry(webEntryArguments(), env, deps)).resolves.toBe(9);
    expect(deps.sleep).toHaveBeenCalledWith(webMaintenanceDispersionSeconds() * 1_000);
    expect(calls).toEqual([
      "dispersed",
      "attested",
      "launchd-authenticated",
      "web-heavy-imported",
      "web-handler",
    ]);
    expect(env).toEqual({ PATH: "/usr/bin:/bin" });
    expect(deps.loadHeavy).not.toHaveBeenCalled();
  });

  it("rejects a stale cached web-helper definition before importing heavy code", async () => {
    const { deps } = entryHarness({
      inspectWebHelper: async () => ({
        ...webHelperInfo(),
        definition: {
          ...webHelperInfo().definition!,
          expectedWebPlistIdentity: `9:9:9:${"b".repeat(64)}`,
        },
      }),
    });
    const env = { [MANAGED_WEB_LOG_MAINTENANCE_ENV]: "1", PATH: "/usr/bin:/bin" };

    await expect(runLaunchdMaintenanceEntry(webEntryArguments(), env, deps)).resolves.toBe(1);
    expect(deps.loadWebHeavy).not.toHaveBeenCalled();
  });

  it.each([
    ["missing marker", {}, webEntryArguments()],
    ["agent marker", { [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1" }, webEntryArguments()],
    ["both markers", {
      [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1",
      [MANAGED_WEB_LOG_MAINTENANCE_ENV]: "1",
    }, webEntryArguments()],
    ["reordered", { [MANAGED_WEB_LOG_MAINTENANCE_ENV]: "1" }, [
      "__web-log-maintenance",
      "--expected-web-plist-identity", `1:2:3:${"a".repeat(64)}`,
      "--expected-managed-runtime-launch", "cHJvb2Y",
    ]],
    ["extra", { [MANAGED_WEB_LOG_MAINTENANCE_ENV]: "1" }, [...webEntryArguments(), "extra"]],
  ])("rejects %s web-helper authority without importing heavy code", async (_label, env, argv) => {
    const { deps } = entryHarness();
    await expect(runLaunchdMaintenanceEntry(argv, env, deps)).resolves.toBe(2);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.loadHeavy).not.toHaveBeenCalled();
    expect(deps.loadWebHeavy).not.toHaveBeenCalled();
  });

  it("defers at the per-agent lifecycle lock without attestation or heavy import", async () => {
    const calls: string[] = [];
    const { deps, env } = entryHarness({
      acquireLifecycleLock: async (target) => {
        calls.push(target.label);
        return undefined;
      },
    });

    await expect(runLaunchdMaintenanceEntry(entryArguments(), env, deps)).resolves.toBe(0);
    const mainLabel = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    expect(deps.sleep).toHaveBeenCalledWith(launchdMaintenanceDispersionSeconds(mainLabel) * 1_000);
    expect(calls).toEqual([mainLabel]);
    expect(deps.verifyEntrypoint).not.toHaveBeenCalled();
    expect(deps.loadHeavy).not.toHaveBeenCalled();
  });

  it("attests and imports the heavy controller only after the per-agent lifecycle lease", async () => {
    const calls: string[] = [];
    const { deps, env } = entryHarness({
      sleep: async () => { calls.push("dispersed"); },
      acquireLifecycleLock: async (target) => {
        calls.push("per-agent-won");
        return async () => { calls.push("release-per-agent"); };
      },
      verifyEntrypoint: async () => { calls.push("attested"); },
      loadHeavy: async () => {
        calls.push("heavy-imported");
        return {
          runLaunchdLogMaintenanceCommandWithLifecycleLease: async () => {
            calls.push("heavy-handler");
            return 7;
          },
        };
      },
    });

    await expect(runLaunchdMaintenanceEntry(entryArguments(), env, deps)).resolves.toBe(7);
    expect(calls).toEqual([
      "dispersed",
      "per-agent-won",
      "attested",
      "heavy-imported",
      "heavy-handler",
      "release-per-agent",
    ]);
  });

  it("rejects marker misuse and never reports launchctl inspection contents", async () => {
    const errors: string[] = [];
    const { deps, env } = entryHarness({
      runner: async () => ({
        code: 0,
        stdout: "service = {\n\tpid = 123\n\tenvironment = { SECRET_VALUE = inherited-secret }\n}\n",
        stderr: "",
      }),
      stderr: (text) => { errors.push(text); },
    });
    await expect(runLaunchdMaintenanceEntry(["status"], env, deps)).resolves.toBe(2);
    expect(errors.join(" ")).toContain("cannot authorize another command");

    errors.length = 0;
    env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] = "1";
    await expect(runLaunchdMaintenanceEntry(entryArguments(), env, deps)).resolves.toBe(1);
    expect(errors.join(" ")).toContain("launchd does not own this helper pid");
    expect(errors.join(" ")).not.toContain("inherited-secret");
    expect(deps.loadHeavy).not.toHaveBeenCalled();
  });

  it("swallows synchronous and rejected reporter failures", async () => {
    for (const stderr of [
      () => { throw new Error("sync reporter failure"); },
      async () => { throw new Error("async reporter failure"); },
    ]) {
      const { deps, env } = entryHarness({ stderr, runner: async () => ({ code: 1, stdout: "", stderr: "" }) });
      await expect(runLaunchdMaintenanceEntry(entryArguments(), env, deps)).resolves.toBe(1);
      await Promise.resolve();
    }
  });

  it("exits a real per-agent loser quickly without touching a heavy-import sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-entry-process-"));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const configPath = join(root, "agent", "mono-agent.config.json");
    await mkdir(join(root, "agent"), { mode: 0o700 });
    const label = deriveLaunchdLabel(configPath);
    const target = { label, paths: launchdPathsFor(label, home) };
    const release = await acquireFilesystemLifecycleLock(target, {
      purpose: "lifecycle",
      processIncarnation: {
        schema: "mono-agent.process-incarnation.v1",
        bootSessionId: "issue-609-process-test",
        processStartId: String(process.pid),
      },
      isSameProcessIncarnation: () => true,
    });
    expect(release).toBeTypeOf("function");
    const sentinel = join(root, "heavy-imported.txt");
    const fixture = new URL("./fixtures/launchd-maintenance-entry-loser.ts", import.meta.url);
    const require = createRequire(import.meta.url);
    const vitestPackage = require.resolve("vitest/package.json");
    const viteNode = createRequire(vitestPackage).resolve("vite-node/vite-node.mjs");
    const started = performance.now();
    try {
      const result = await runProcess(process.execPath, [viteNode, fixture.pathname, configPath, home, sentinel], {
        ...process.env,
        [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(performance.now() - started).toBeLessThan(5_000);
      const metrics = JSON.parse(result.stdout) as {
        readonly durationMs: number;
        readonly cpuMs: number;
        readonly maxRssKiB: number;
        readonly requestedDelayMs: number;
        readonly heavyImported: boolean;
      };
      expect(metrics.heavyImported).toBe(false);
      expect(metrics.durationMs).toBeLessThan(1_000);
      expect(metrics.cpuMs).toBeLessThan(1_000);
      expect(metrics.maxRssKiB).toBeLessThan(256 * 1_024);
      expect(metrics.requestedDelayMs).toBe(launchdMaintenanceDispersionSeconds(label) * 1_000);
      await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await release?.();
    }
  }, 10_000);

  it("bounds one real winning entry lifecycle and releases its per-agent lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-entry-winner-"));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const configPath = join(root, "agent", "mono-agent.config.json");
    await mkdir(join(root, "agent"), { mode: 0o700 });
    const label = deriveLaunchdLabel(configPath);
    const target = { label, paths: launchdPathsFor(label, home) };
    const sentinel = join(root, "heavy-imported.txt");
    const fixture = new URL("./fixtures/launchd-maintenance-entry-loser.ts", import.meta.url);
    const require = createRequire(import.meta.url);
    const vitestPackage = require.resolve("vitest/package.json");
    const viteNode = createRequire(vitestPackage).resolve("vite-node/vite-node.mjs");
    const started = performance.now();

    const result = await runProcess(process.execPath, [viteNode, fixture.pathname, configPath, home, sentinel], {
      ...process.env,
      [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1",
    });

    expect(result.code).toBe(99);
    expect(result.stderr).toBe("");
    expect(performance.now() - started).toBeLessThan(5_000);
    const metrics = JSON.parse(result.stdout) as {
      readonly durationMs: number;
      readonly cpuMs: number;
      readonly maxRssKiB: number;
      readonly requestedDelayMs: number;
      readonly heavyImported: boolean;
    };
    expect(metrics.heavyImported).toBe(true);
    expect(metrics.durationMs).toBeLessThan(1_000);
    expect(metrics.cpuMs).toBeLessThan(1_000);
    expect(metrics.maxRssKiB).toBeLessThan(256 * 1_024);
    expect(metrics.requestedDelayMs).toBe(launchdMaintenanceDispersionSeconds(label) * 1_000);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("heavy import reached\n");
    await expect(stat(join(home, ".mono-agent", "locks", `${target.label}.lock`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("disperses three real agent processes while proving every entry reaches recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-entry-fleet-"));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const configPaths = [
      "/private/tmp/mono-agent-609-fleet-18/mono-agent.config.json",
      "/private/tmp/mono-agent-609-fleet-4/mono-agent.config.json",
      "/private/tmp/mono-agent-609-fleet-0/mono-agent.config.json",
    ];
    const fixture = new URL("./fixtures/launchd-maintenance-entry-fleet.ts", import.meta.url);
    const require = createRequire(import.meta.url);
    const vitestPackage = require.resolve("vitest/package.json");
    const viteNode = createRequire(vitestPackage).resolve("vite-node/vite-node.mjs");
    const started = performance.now();
    const results = await Promise.all(configPaths.map(async (configPath, index) => {
      const sentinel = join(root, `recovered-${String(index)}.txt`);
      const processResult = await runProcess(
        process.execPath,
        [viteNode, fixture.pathname, configPath, home, sentinel, "0.001"],
        { ...process.env, [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1" },
      );
      return { processResult, sentinel };
    }));
    expect(performance.now() - started).toBeLessThan(5_000);

    const metrics = results.map(({ processResult }) => {
      expect(processResult.code).toBe(0);
      expect(processResult.stderr).toBe("");
      return JSON.parse(processResult.stdout) as {
        readonly result: number;
        readonly label: string;
        readonly requestedDelayMs: number;
        readonly durationMs: number;
        readonly cpuMs: number;
        readonly maxRssKiB: number;
        readonly events: Readonly<Record<string, number>>;
      };
    });
    expect(new Set(metrics.map((entry) => entry.label)).size).toBe(3);
    const heavyStarts: number[] = [];
    for (const [index, entry] of metrics.entries()) {
      const expectedDelaySeconds = launchdMaintenanceDispersionSeconds(entry.label);
      expect(entry.result).toBe(0);
      expect(entry.requestedDelayMs).toBe(expectedDelaySeconds * 1_000);
      expect(entry.durationMs).toBeLessThan(5_000);
      expect(entry.cpuMs).toBeLessThan(1_000);
      expect(entry.maxRssKiB).toBeLessThan(256 * 1_024);
      expect(entry.events.dispersionEnd).toBeGreaterThanOrEqual(expectedDelaySeconds - 5);
      expect(entry.events.pidAuthenticated).toBeGreaterThanOrEqual(entry.events.dispersionEnd!);
      expect(entry.events.perAgentAttempt).toBeGreaterThanOrEqual(entry.events.pidAuthenticated!);
      expect(entry.events.perAgentWon).toBeGreaterThanOrEqual(entry.events.perAgentAttempt!);
      expect(entry.events.attested).toBeGreaterThanOrEqual(entry.events.perAgentWon!);
      expect(entry.events.heavyImportStart).toBeGreaterThanOrEqual(entry.events.attested!);
      expect(entry.events.recovered).toBeGreaterThanOrEqual(entry.events.heavyImportStart!);
      heavyStarts.push(entry.events.heavyImportStart!);
      await expect(readFile(results[index]!.sentinel, "utf8")).resolves.toBe("proven and recovered\n");
      await expect(stat(join(home, ".mono-agent", "locks", `${entry.label}.lock`)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(Math.max(...heavyStarts) - Math.min(...heavyStarts)).toBeGreaterThanOrEqual(60);
  }, 15_000);
});

function entryArguments(): string[] {
  return [
    "__launchd-log-maintenance",
    "--config", "/work/demo/mono-agent.config.json",
    "--controller-cli", "/managed/controller/dist/cli.js",
    "--agent-cwd", "/work/demo",
    "--agent-path", "/usr/bin:/bin",
    "--expected-managed-runtime-launch", "cHJvb2Y",
  ];
}

function webEntryArguments(): string[] {
  return [
    "__web-log-maintenance",
    "--expected-managed-runtime-launch", "cHJvb2Y",
    "--expected-web-plist-identity", `1:2:3:${"a".repeat(64)}`,
  ];
}

function entryHarness(overrides: Partial<LaunchdMaintenanceEntryDependencies["gate"]> & {
  readonly verifyEntrypoint?: LaunchdMaintenanceEntryDependencies["verifyEntrypoint"];
  readonly loadHeavy?: LaunchdMaintenanceEntryDependencies["loadHeavy"];
  readonly loadWebHeavy?: NonNullable<LaunchdMaintenanceEntryDependencies["loadWebHeavy"]>;
  readonly inspectWebHelper?: NonNullable<LaunchdMaintenanceEntryDependencies["inspectWebHelper"]>;
  readonly sleep?: LaunchdMaintenanceEntryDependencies["sleep"];
} = {}): { deps: LaunchdMaintenanceEntryDependencies; env: Record<string, string | undefined> } {
  const pid = 999;
  const env = { [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1", PATH: "/usr/bin:/bin", SECRET: "removed" };
  const gate = {
    runner: async () => ({ code: 0, stdout: `service = {\n\tpid = ${pid}\n}\n`, stderr: "" }),
    getuid: () => 501,
    currentPid: () => pid,
    isAlive: () => true,
    acquireLifecycleLock: async () => async () => undefined,
    stderr: () => undefined,
    ...overrides,
  };
  return {
    env,
    deps: {
      gate,
      pathsForLabel: (label) => launchdPathsFor(label, "/Users/example"),
      verifyEntrypoint: overrides.verifyEntrypoint === undefined ? vi.fn(async () => undefined) : vi.fn(overrides.verifyEntrypoint),
      loadHeavy: overrides.loadHeavy === undefined
        ? vi.fn(async () => ({ runLaunchdLogMaintenanceCommandWithLifecycleLease: async () => 0 }))
        : vi.fn(overrides.loadHeavy),
      loadWebHeavy: overrides.loadWebHeavy === undefined
        ? vi.fn(async () => ({ runWebLogMaintenanceCommand: async () => 0 }))
        : vi.fn(overrides.loadWebHeavy),
      inspectWebHelper: overrides.inspectWebHelper === undefined
        ? vi.fn(async () => webHelperInfo(pid))
        : vi.fn(overrides.inspectWebHelper),
      currentEntrypointPath: "/managed/runtime/dist/launchd-maintenance-entry.js",
      platform: "darwin",
      sleep: overrides.sleep === undefined ? vi.fn(async () => undefined) : vi.fn(overrides.sleep),
      stderr: gate.stderr,
    },
  };
}

function webHelperInfo(pid = 999) {
  return {
    loaded: true,
    pid,
    definition: {
      plistPath: "/Users/example/Library/LaunchAgents/com.mono-agent-web-maintenance.plist",
      nodePath: process.execPath,
      cliPath: "/managed/runtime/dist/launchd-maintenance-entry.js",
      cwd: "/Users/example/.mono-agent/web",
      expectedManagedRuntimeLaunch: "cHJvb2Y",
      expectedWebPlistIdentity: `1:2:3:${"a".repeat(64)}`,
    },
  };
}

function runProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

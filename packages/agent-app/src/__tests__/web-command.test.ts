import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseTailscaleHttpsPort,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  ensureTailscaleServe,
  removeOwnedTailscaleServe,
  runWebCommand,
  tailscaleProxyTarget,
  webHealthcheck,
  webPaths,
  WEB_LAUNCHD_LABEL,
} from "../web-command.js";
import type { CommandRunner } from "../web-command.js";
import {
  buildWebMaintenancePlistXml,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
  webMaintenanceCalendarMinute,
} from "../launchd.js";
import {
  beginLaunchdLogMaintenanceIntent,
  LAUNCHD_LOG_MAX_BYTES,
  markLaunchdLogMaintenanceRestoring,
  markLaunchdLogMaintenanceStopped,
  readLaunchdLogMaintenanceIntent,
} from "../launchd-logs.js";
import { managedWebLogMaintenanceEnvironment } from "../managed-web-maintenance-environment.js";

let dir: string | undefined;

const prepareState = async (options: { readonly stateDir?: string }) => {
  if (options.stateDir !== undefined) await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function testHome(): Promise<string> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-web-command-")));
  return dir;
}

async function compositeIdentity(path: string): Promise<string> {
  const [stats, contents] = await Promise.all([lstat(path), readFile(path)]);
  return [stats.dev, stats.ino, stats.size, createHash("sha256").update(contents).digest("hex")].join(":");
}

function pairedLaunchctlFixture(initial: { readonly worker?: boolean; readonly helper?: boolean } = {}) {
  const loaded = new Map<string, boolean>([
    ["com.mono-agent-web", initial.worker ?? false],
    ["com.mono-agent-web-maintenance", initial.helper ?? false],
  ]);
  const calls: string[][] = [];
  const labelFor = (args: readonly string[]): string => args.some((value) => value.includes("com.mono-agent-web-maintenance"))
    ? "com.mono-agent-web-maintenance"
    : "com.mono-agent-web";
  return {
    calls,
    loaded,
    isAlive: (pid: number) => pid === 777 && loaded.get("com.mono-agent-web") === true,
    runner: async (args: readonly string[]) => {
      calls.push([...args]);
      const label = labelFor(args);
      if (args[0] === "print") {
        const active = loaded.get(label) === true;
        return {
          code: active ? 0 : 1,
          stdout: active && label === "com.mono-agent-web" ? "pid = 777\n" : "",
          stderr: active ? "" : "not loaded",
        };
      }
      if (args[0] === "bootout") {
        loaded.set(label, false);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        if (loaded.get(label) === true) return { code: 37, stdout: "", stderr: "already loaded" };
        loaded.set(label, true);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "kickstart") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
}

describe("runWebCommand", () => {
  it("keeps bare web read-only while showing status and subcommand help", async () => {
    const home = await testHome();
    let output = "";
    const startServer = vi.fn();
    const resetState = vi.fn();
    const code = await runWebCommand(
      { positionals: [], env: {} },
      {
        platform: "freebsd",
        homeDir: home,
        discoverNetworkAddresses: () => [
          "203.0.113.9",
          "192.168.2.42",
          "100.64.0.7",
          "fd7a:115c:a1e0::7",
          "2001:4860:4860::8888",
          "fe80::7",
          "fe80::7%en0",
          "192.168.2.42",
        ],
        stdout: { write: (text) => { output += text; } },
        startServer,
        resetState,
      },
    );

    expect(code).toBe(0);
    expect(output).toContain("mono-agent web start");
    expect(output).toContain("service");
    expect(output).toContain("stopped");
    expect(output).toContain("evergreen");
    expect(output).toContain("http://127.0.0.1:5050/");
    expect(output).toContain("http://192.168.2.42:5050/");
    expect(output).toContain("http://100.64.0.7:5050/");
    expect(output).not.toContain("fd7a:115c:a1e0::7");
    expect(output.match(/http:\/\/192\.168\.2\.42:5050\//gu)).toHaveLength(1);
    expect(output).not.toContain("203.0.113.9");
    expect(output).not.toContain("2001:4860:4860::8888");
    expect(output).not.toContain("http://[fe80::7]:5050/");
    expect(output).not.toContain("fe80::7%25en0");
    expect(output).not.toContain("http://0.0.0.0:5050/");
    expect(startServer).not.toHaveBeenCalled();
    expect(resetState).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it.each([
    [true, "maintenance in progress (stopping)"],
    [false, "maintenance recovery required"],
  ])("distinguishes live helper maintenance from abandoned recovery (live=%s)", async (helperLive, expected) => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "main plist\n", { mode: 0o600 });
    await beginLaunchdLogMaintenanceIntent(paths.launchd, {
      version: 1,
      phase: "stopping",
      label: WEB_LAUNCHD_LABEL,
      plistFingerprint: await compositeIdentity(paths.launchd.plistPath),
    });
    let output = "";
    const launchctl = async (args: readonly string[]) => {
      const helper = args.some((value) => value.includes("com.mono-agent-web-maintenance"));
      if (helper) return { code: 0, stdout: helperLive ? "pid = 900\n" : "", stderr: "" };
      return { code: 0, stdout: "pid = 777\n", stderr: "" };
    };
    await expect(runWebCommand(
      { positionals: ["status"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        launchctl,
        healthcheck: async () => true,
        stdout: { write: (text) => { output += text; } },
      },
    )).resolves.toBe(1);
    expect(output).toContain(expected);
    if (!helperLive) {
      expect(output).toContain("mono-agent web stop");
      expect(output).toContain("mono-agent web start");
    }
  });

  it.each(["stopping", "stale-restoring"] as const)(
    "advertises and executes stop-then-start recovery for %s authority",
    async (scenario) => {
      const home = await testHome();
      const paths = webPaths(home);
      await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
      await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
      await writeFile(paths.launchd.plistPath, "pre-crash main plist\n", { mode: 0o600 });
      await writeFile(paths.maintenancePlistPath, "pre-crash helper plist\n", { mode: 0o600 });
      const stopping = {
        version: 1 as const,
        phase: "stopping" as const,
        label: WEB_LAUNCHD_LABEL,
        plistFingerprint: await compositeIdentity(paths.launchd.plistPath),
      };
      await beginLaunchdLogMaintenanceIntent(paths.launchd, stopping);
      if (scenario === "stale-restoring") {
        const stopped = await markLaunchdLogMaintenanceStopped(paths.launchd, stopping);
        await markLaunchdLogMaintenanceRestoring(paths.launchd, stopped);
        await writeFile(paths.launchd.plistPath, "replacement main plist with a fresh identity\n", { mode: 0o600 });
      }
      const launchd = pairedLaunchctlFixture();
      let statusOutput = "";

      await expect(runWebCommand(
        { positionals: ["status"], env: {} },
        {
          platform: "darwin",
          homeDir: home,
          getuid: () => 501,
          launchctl: launchd.runner,
          stdout: { write: (text) => { statusOutput += text; } },
        },
      )).resolves.toBe(1);
      expect(statusOutput).toContain("mono-agent web stop");
      expect(statusOutput).toContain("mono-agent web start");
      expect(statusOutput).not.toContain("Recover it with exactly: mono-agent web restart");

      await expect(runWebCommand(
        { positionals: ["stop"], env: {} },
        {
          platform: "darwin",
          homeDir: home,
          getuid: () => 501,
          prepareState,
          acquireLifecycleLock: async () => async () => undefined,
          launchctl: launchd.runner,
          isAlive: launchd.isAlive,
          stdout: { write: () => undefined },
          stderr: { write: () => undefined },
        },
      )).resolves.toBe(0);
      expect(await readLaunchdLogMaintenanceIntent(paths.launchd)).toBeUndefined();

      await expect(runWebCommand(
        { positionals: ["start"], env: {}, loopback: true },
        {
          platform: "darwin",
          homeDir: home,
          getuid: () => 501,
          prepareState,
          acquireLifecycleLock: async () => async () => undefined,
          launchctl: launchd.runner,
          ensureManagedRuntime: async () => ({
            cliPath: "/managed/dist/cli.js",
            nodePath: "/managed/node",
            launchProof: "cHJvb2Y",
          }),
          healthcheck: async () => true,
          isAlive: launchd.isAlive,
          sleep: async () => undefined,
          tailscale: async () => ({ code: 1, stdout: "", stderr: "unavailable in test" }),
          stdout: { write: () => undefined },
          stderr: { write: () => undefined },
        },
      )).resolves.toBe(0);
      expect(launchd.loaded.get(WEB_MAINTENANCE_LAUNCHD_LABEL)).toBe(true);
      expect(launchd.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
      expect(await readLaunchdLogMaintenanceIntent(paths.launchd)).toBeUndefined();
    },
  );

  it("prints only reachable IPv6 URLs for an IPv6 wildcard bind", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    let output = "";
    const stop = vi.fn(async () => undefined);
    const startServer = vi.fn(async () => ({ url: "http://[::]:5050/", host: "::", port: 5050, stop }));

    const code = await runWebCommand(
      { positionals: ["run"], host: "::", env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir } },
      {
        homeDir: home,
        prepareState,
        startServer,
        waitForShutdown: async () => undefined,
        discoverNetworkAddresses: () => ["192.168.2.42", "100.64.0.7", "fd7a:115c:a1e0::7"],
        stdout: { write: (text) => { output += text; } },
      },
    );

    expect(code).toBe(0);
    expect(output).toContain("http://[::1]:5050/");
    expect(output).toContain("Tailscale  → http://[fd7a:115c:a1e0::7]:5050/");
    expect(output).not.toContain("192.168.2.42");
    expect(output).not.toContain("100.64.0.7");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("runs foreground on the LAN default without adding authentication", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    const stop = vi.fn(async () => undefined);
    const startManagedLogMonitor = vi.fn(() => ({ stop: vi.fn() }));
    const startServer = vi.fn(async (options) => ({
      url: "http://0.0.0.0:5050/",
      host: "0.0.0.0",
      port: 5050,
      stop,
      options,
    }));

    const code = await runWebCommand(
      {
        positionals: ["run"],
        theme: "ocean",
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
      },
      {
        homeDir: home,
        prepareState,
        startServer,
        startManagedLogMonitor,
        waitForShutdown: async () => undefined,
        discoverNetworkAddresses: () => ["192.0.2.42"],
        stdout: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
      theme: "ocean",
      registryDirs: [registryDir],
    }));
    expect(startServer.mock.calls[0]?.[0]).not.toHaveProperty("authToken");
    expect(startManagedLogMonitor).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("tails only the two active web logs and follows replacements by name", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    const spawnTail = vi.fn(async (_args: readonly string[]) => 0);

    await expect(runWebCommand(
      { positionals: ["logs"], env: {}, follow: true, lines: 37 },
      { platform: "darwin", homeDir: home, spawnTail },
    )).resolves.toBe(0);

    expect(spawnTail).toHaveBeenCalledWith([
      "-n",
      "37",
      "-F",
      paths.launchd.stderrPath,
      paths.launchd.stdoutPath,
    ]);
    expect(spawnTail.mock.calls[0]?.[0].some((path) => /\.log\.[1-3]$/u.test(path))).toBe(false);
  });

  it("maps --loopback to 127.0.0.1 and rejects combining it with --host", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    const startServer = vi.fn(async () => ({
      url: "http://127.0.0.1:5050/",
      stop: async () => undefined,
    }));
    await expect(runWebCommand(
      { positionals: ["run"], env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir }, loopback: true },
      { homeDir: home, prepareState, startServer, waitForShutdown: async () => undefined, stdout: { write: () => undefined } },
    )).resolves.toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1" }));

    let errors = "";
    await expect(runWebCommand(
      { positionals: ["start"], env: {}, loopback: true, host: "0.0.0.0" },
      { stderr: { write: (text) => { errors += text; } }, stdout: { write: () => undefined } },
    )).resolves.toBe(2);
    expect(errors).toContain("either --loopback or --host");
  });

  it("rejects unknown themes before starting a worker", async () => {
    const startServer = vi.fn();
    let errors = "";

    await expect(runWebCommand(
      { positionals: ["run"], env: {}, theme: "neon" },
      {
        startServer,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    )).resolves.toBe(2);

    expect(errors).toContain("evergreen, ocean, plum, terracotta");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("does not silently ignore a theme passed to start when the managed service is already loaded", async () => {
    const home = await testHome();
    const ensureManagedRuntime = vi.fn();
    const launchctl = vi.fn(async (args: readonly string[]) => (
      args[0] === "print"
        ? { code: 0, stdout: "pid = 777\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "unexpected" }
    ));
    let errors = "";

    await expect(runWebCommand(
      { positionals: ["start"], env: {}, theme: "ocean" },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        ensureManagedRuntime,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    )).resolves.toBe(1);

    expect(errors).toContain("mono-agent web restart --theme ocean");
    expect(ensureManagedRuntime).not.toHaveBeenCalled();
    expect(launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootout"]));
    expect(launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootstrap"]));
  });

  it("installs a missing healthy-worker helper in place without changing the worker PID", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "existing worker plist\n", { mode: 0o600 });
    await writeFile(paths.recordPath, `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      theme: "evergreen",
      updatedAt: "2026-08-14T12:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const launchd = pairedLaunchctlFixture({ worker: true });

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        ensureManagedRuntime: async () => ({
          cliPath: "/managed/dist/cli.js",
          nodePath: "/managed/node",
          launchProof: "cHJvb2Y",
        }),
        inspectMaintenanceService: async () => ({
          loaded: launchd.loaded.get("com.mono-agent-web-maintenance") === true,
          definition: {
            plistPath: paths.maintenancePlistPath,
            nodePath: "/managed/node",
            cliPath: "/managed/dist/launchd-maintenance-entry.js",
            cwd: paths.stateDir,
            expectedManagedRuntimeLaunch: "cHJvb2Y",
            expectedWebPlistIdentity: await compositeIdentity(paths.launchd.plistPath),
          },
        }),
        verifyMaintenanceEntrypoint: async () => undefined,
        healthcheck: async () => true,
        isAlive: launchd.isAlive,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(launchd.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    const workerStatus = await launchd.runner(["print", `gui/501/${WEB_LAUNCHD_LABEL}`]);
    expect(workerStatus).toMatchObject({ code: 0, stdout: "pid = 777\n" });
    expect(launchd.isAlive(777)).toBe(true);
    expect(launchd.calls.filter((args) => (args[0] === "bootout" || args[0] === "bootstrap")
      && !args.some((value) => value.includes(WEB_MAINTENANCE_LAUNCHD_LABEL)))).toEqual([]);
    expect(await readFile(paths.maintenancePlistPath, "utf8"))
      .toContain(`<string>${await compositeIdentity(paths.launchd.plistPath)}</string>`);
  });

  it("preserves a healthy worker when its loaded helper is stale and requires explicit restart", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "existing worker plist\n", { mode: 0o600 });
    await writeFile(paths.maintenancePlistPath, "stale helper plist\n", { mode: 0o600 });
    const launchd = pairedLaunchctlFixture({ worker: true, helper: true });
    const ensureManagedRuntime = vi.fn();
    let errors = "";
    await expect(runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        ensureManagedRuntime,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    )).resolves.toBe(1);
    expect(launchd.calls.some((args) => args[0] === "bootout")).toBe(false);
    expect(ensureManagedRuntime).not.toHaveBeenCalled();
    expect(errors).toContain("mono-agent web restart");
  });

  it("keeps a pre-helper worker serving when managed-runtime preparation fails before restart", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    const priorPlist = "pre-helper worker plist\n";
    const priorRecord = `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      theme: "evergreen",
      updatedAt: "2026-08-14T12:00:00.000Z",
    })}\n`;
    await writeFile(paths.launchd.plistPath, priorPlist, { mode: 0o600 });
    await writeFile(paths.recordPath, priorRecord, { mode: 0o600 });
    const launchd = pairedLaunchctlFixture({ worker: true });

    await expect(runWebCommand(
      { positionals: ["restart"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        ensureManagedRuntime: async () => { throw new Error("runtime unavailable"); },
        isAlive: launchd.isAlive,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(1);

    expect(launchd.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(launchd.calls.some((args) => args[0] === "bootout" || args[0] === "bootstrap")).toBe(false);
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(priorPlist);
    expect(await readFile(paths.recordPath, "utf8")).toBe(priorRecord);
  });

  it("reports routine due maintenance without failing an idempotent healthy start", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.stdoutPath, Buffer.alloc(LAUNCHD_LOG_MAX_BYTES + 1), { mode: 0o600 });
    await writeFile(paths.launchd.stderrPath, "", { mode: 0o600 });
    await writeFile(paths.launchd.plistPath, "healthy worker plist\n", { mode: 0o600 });
    await writeFile(paths.recordPath, `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      theme: "evergreen",
      updatedAt: "2026-08-14T12:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const mainIdentity = await compositeIdentity(paths.launchd.plistPath);
    const definition = {
      plistPath: paths.maintenancePlistPath,
      nodePath: "/managed/node",
      cliPath: "/managed/dist/launchd-maintenance-entry.js",
      cwd: paths.stateDir,
      expectedManagedRuntimeLaunch: "cHJvb2Y",
      expectedWebPlistIdentity: mainIdentity,
    };
    await writeFile(paths.maintenancePlistPath, buildWebMaintenancePlistXml({
      label: WEB_MAINTENANCE_LAUNCHD_LABEL,
      ...definition,
      environment: managedWebLogMaintenanceEnvironment(),
      calendarMinute: webMaintenanceCalendarMinute(),
    }), { mode: 0o600 });
    let output = "";
    let errors = "";
    const launchctl = async (args: readonly string[]) => ({
      code: 0,
      stdout: args.some((value) => value.includes(WEB_MAINTENANCE_LAUNCHD_LABEL))
        ? "pid = 900\n"
        : "pid = 777\n",
      stderr: "",
    });

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        launchctl,
        inspectMaintenanceService: async () => ({ loaded: true, pid: 900, definition }),
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        verifyMaintenanceEntrypoint: async () => undefined,
        healthcheck: async () => true,
        stdout: { write: (text) => { output += text; } },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(0);
    expect(errors).toBe("");
    expect(output).toContain("due");
    expect(output).not.toContain("managed web log maintenance is due");
  });

  it("requires explicit double confirmation before reset", async () => {
    const resetState = vi.fn();
    await expect(runWebCommand(
      { positionals: ["reset"], env: {}, all: true },
      { resetState, stdout: { write: () => undefined }, stderr: { write: () => undefined } },
    )).resolves.toBe(2);
    expect(resetState).not.toHaveBeenCalled();
  });

  it("allows foreground-only Linux reset when the systemd user manager is unavailable", async () => {
    const home = await testHome();
    const resetState = vi.fn(async () => undefined);
    await expect(runWebCommand(
      { positionals: ["reset"], env: {}, all: true, yes: true },
      {
        platform: "linux",
        homeDir: home,
        systemd: { run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) },
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        resetState,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(0);
    expect(resetState).toHaveBeenCalledOnce();
  });

  it("refuses reset while the maintenance helper is loaded", async () => {
    const home = await testHome();
    const resetState = vi.fn();
    let errors = "";
    const launchctl = async (args: readonly string[]) => ({
      code: args.some((value) => value.includes(WEB_MAINTENANCE_LAUNCHD_LABEL)) ? 0 : 1,
      stdout: "",
      stderr: "",
    });

    await expect(runWebCommand(
      { positionals: ["reset"], env: {}, all: true, yes: true },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        launchctl,
        resetState,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    )).resolves.toBe(1);

    expect(resetState).not.toHaveBeenCalled();
    expect(errors).toContain("mono-agent web stop");
  });

  it("boots out a running worker without preparing its contended state", async () => {
    const home = await testHome();
    let loaded = true;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") {
        return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const prepareContendedState = vi.fn(async () => {
      throw new Error("web state lease is already active");
    });

    await expect(runWebCommand(
      { positionals: ["stop"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        launchctl,
        prepareState: prepareContendedState,
        acquireLifecycleLock: async () => async () => undefined,
        isAlive: () => false,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(0);

    expect(prepareContendedState).not.toHaveBeenCalled();
    expect(calls.map((args) => args[0])).toContain("bootout");
  });

  it("stops the helper before the worker and removes both definitions only after death proof", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "worker\n", { mode: 0o600 });
    await writeFile(paths.maintenancePlistPath, "helper\n", { mode: 0o600 });
    await writeFile(paths.monitorStatusPath, "status\n", { mode: 0o600 });
    await writeFile(paths.maintenanceStatusPath, "status\n", { mode: 0o600 });
    const launchd = pairedLaunchctlFixture({ worker: true, helper: true });

    await expect(runWebCommand(
      { positionals: ["stop"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        isAlive: launchd.isAlive,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(0);

    expect(launchd.calls.filter((args) => args[0] === "bootout").map((args) => args[1])).toEqual([
      "gui/501/com.mono-agent-web-maintenance",
      "gui/501/com.mono-agent-web",
    ]);
    for (const path of [
      paths.maintenancePlistPath,
      paths.launchd.plistPath,
      paths.monitorStatusPath,
      paths.maintenanceStatusPath,
    ]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reports when stop cannot restore the helper after worker death proof fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "worker\n", { mode: 0o600 });
    await writeFile(paths.maintenancePlistPath, "helper\n", { mode: 0o600 });
    let helperLoaded = true;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      const helper = args.some((value) => value.includes(WEB_MAINTENANCE_LAUNCHD_LABEL));
      if (args[0] === "print") {
        if (helper) return helperLoaded
          ? { code: 0, stdout: "pid = 900\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "not loaded" };
        return { code: 0, stdout: "pid = 777\n", stderr: "" };
      }
      if (args[0] === "bootout" && helper) {
        helperLoaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "bootstrap" && helper) {
        // launchctl success alone is insufficient: this fixture deliberately
        // leaves the helper absent so the loaded-state proof must fail.
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let clock = 0;
    let errors = "";

    await expect(runWebCommand(
      { positionals: ["stop"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        isAlive: (pid) => pid === 777 || (pid === 900 && helperLoaded),
        now: () => { clock += 20_000; return clock; },
        sleep: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    )).resolves.toBe(1);

    expect(helperLoaded).toBe(false);
    expect(errors).toContain("prior maintenance helper could not be proven restored");
    expect(errors).toContain("launchd did not retain the helper");
    expect(calls.filter((args) => args[0] === "bootout" || args[0] === "bootstrap")
      .map((args) => [args[0], args.at(-1)])).toEqual([
      ["bootout", `gui/501/${WEB_MAINTENANCE_LAUNCHD_LABEL}`],
      ["bootout", `gui/501/${WEB_LAUNCHD_LABEL}`],
      ["bootstrap", paths.maintenancePlistPath],
    ]);
    await expect(readFile(paths.launchd.plistPath, "utf8")).resolves.toBe("worker\n");
    await expect(readFile(paths.maintenancePlistPath, "utf8")).resolves.toBe("helper\n");
  });

  it("reboots the prior helper if restart cannot prove the worker stopped", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "worker plist\n", { mode: 0o600 });
    await writeFile(paths.maintenancePlistPath, "prior helper plist\n", { mode: 0o600 });
    await writeFile(paths.recordPath, `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      theme: "evergreen",
      updatedAt: "2026-08-14T12:00:00.000Z",
    })}\n`, { mode: 0o600 });
    let helperLoaded = true;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      const helper = args.some((value) => value.includes(WEB_MAINTENANCE_LAUNCHD_LABEL));
      if (args[0] === "print") {
        if (helper) return helperLoaded
          ? { code: 0, stdout: "pid = 900\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "not loaded" };
        return { code: 0, stdout: "pid = 777\n", stderr: "" };
      }
      if (args[0] === "bootout" && helper) {
        helperLoaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "bootstrap" && helper) {
        helperLoaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let clock = 0;

    await expect(runWebCommand(
      { positionals: ["restart"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        ensureManagedRuntime: async () => ({
          cliPath: "/managed/dist/cli.js",
          nodePath: "/managed/node",
          launchProof: "cHJvb2Y",
        }),
        isAlive: (pid) => pid === 777 || (pid === 900 && helperLoaded),
        now: () => { clock += 20_000; return clock; },
        sleep: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(1);

    expect(helperLoaded).toBe(true);
    const lifecycleCalls = calls.filter((args) => args[0] === "bootout" || args[0] === "bootstrap");
    expect(lifecycleCalls.map((args) => [args[0], args.at(-1)])).toEqual([
      ["bootout", `gui/501/${WEB_MAINTENANCE_LAUNCHD_LABEL}`],
      ["bootout", `gui/501/${WEB_LAUNCHD_LABEL}`],
      ["bootstrap", paths.maintenancePlistPath],
    ]);
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe("worker plist\n");
    expect(await readFile(paths.maintenancePlistPath, "utf8")).toBe("prior helper plist\n");
  });

  it("surfaces the web package's shared-state lease for concurrent ports and reset", async () => {
    const home = await testHome();
    const registryDir = join(home, "registry");
    await mkdir(registryDir, { mode: 0o700 });
    let finish: (() => void) | undefined;
    const waitForShutdown = () => new Promise<void>((resolvePromise) => { finish = resolvePromise; });
    let stateBusy = false;
    const startServer = vi.fn(async () => {
      if (stateBusy) throw new Error("web state lease is already active");
      stateBusy = true;
      return {
        url: "http://127.0.0.1:5050/",
        stop: async () => { stateBusy = false; },
      };
    });
    const first = runWebCommand(
      {
        positionals: ["run"],
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
        loopback: true,
      },
      { homeDir: home, prepareState, startServer, waitForShutdown, stdout: { write: () => undefined } },
    );
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledOnce());

    await expect(runWebCommand(
      {
        positionals: ["run"],
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
        host: "127.0.0.1",
        port: 5051,
      },
      { homeDir: home, prepareState, startServer, stderr: { write: () => undefined } },
    )).resolves.toBe(1);
    expect(startServer).toHaveBeenCalledTimes(2);

    const resetState = vi.fn(async () => {
      if (stateBusy) throw new Error("web state lease is already active");
    });
    await expect(runWebCommand(
      { positionals: ["reset"], env: {}, all: true, yes: true },
      {
        platform: "linux",
        homeDir: home,
        systemd: { run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) },
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        resetState,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(1);
    expect(resetState).toHaveBeenCalledOnce();

    finish?.();
    await expect(first).resolves.toBe(0);
  });

  it("restores Tailscale ownership if a reset implementation tries to erase lifecycle metadata", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    const ownership = "{\"schema\":\"test-owned-route\"}\n";
    await writeFile(paths.tailscalePath, ownership, { mode: 0o600 });
    const code = await runWebCommand(
      { positionals: ["reset"], env: {}, all: true, yes: true },
      {
        platform: "linux",
        homeDir: home,
        systemd: { run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) },
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        resetState: async () => { await rm(paths.tailscalePath); },
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );
    expect(code).toBe(1);
    expect(await readFile(paths.tailscalePath, "utf8")).toBe(ownership);
  });

  it("restores and reboots the previous worker when a restart replacement never becomes healthy", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { mode: 0o700 });
    const oldPlist = "old verified plist\n";
    const oldRecord = `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }, undefined, 2)}\n`;
    await writeFile(paths.launchd.plistPath, oldPlist, { mode: 0o600 });
    await writeFile(paths.recordPath, oldRecord, { mode: 0o600 });

    let loaded = true;
    let alive = true;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") {
        return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        alive = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        loaded = true;
        alive = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let clock = 0;
    let errors = "";
    const code = await runWebCommand(
      { positionals: ["restart"], env: {}, loopback: true, port: 5051 },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        healthcheck: async (url) => url.includes(":5050/"),
        isAlive: () => alive,
        now: () => { clock += 20_000; return clock; },
        sleep: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(oldPlist);
    expect(await readFile(paths.recordPath, "utf8")).toBe(oldRecord);
    expect(await readFile(paths.maintenancePlistPath, "utf8"))
      .toContain(`<string>${await compositeIdentity(paths.launchd.plistPath)}</string>`);
    expect(calls.filter((args) => args[0] === "bootstrap").map((args) => args.at(-1))).toEqual([
      paths.maintenancePlistPath,
      paths.launchd.plistPath,
      paths.maintenancePlistPath,
      paths.launchd.plistPath,
    ]);
    expect(errors).toContain("previous web worker is running again");
  });

  it("refuses a malformed service record without overwriting it or launching", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await writeFile(paths.recordPath, "{broken\n", { mode: 0o600 });
    const ensureManagedRuntime = vi.fn();
    const launchctl = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not loaded" }));
    let errors = "";

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        ensureManagedRuntime,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(errors).toContain("service record is malformed");
    expect(await readFile(paths.recordPath, "utf8")).toBe("{broken\n");
    expect(ensureManagedRuntime).not.toHaveBeenCalled();
    expect(launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootstrap"]));
  });

  it("publishes the helper from the fresh composite main identity before either bootstrap", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    const launchd = pairedLaunchctlFixture();

    await expect(runWebCommand(
      { positionals: ["start"], env: {}, loopback: true },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({
          cliPath: "/managed/dist/cli.js",
          nodePath: "/managed/node",
          launchProof: "cHJvb2Y",
        }),
        healthcheck: async () => true,
        isAlive: launchd.isAlive,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(0);

    const identity = await compositeIdentity(paths.launchd.plistPath);
    const helper = await readFile(paths.maintenancePlistPath, "utf8");
    expect(helper).toContain(`<string>${identity}</string>`);
    expect(helper).not.toContain("--expected-web-plist-fingerprint");
    expect(launchd.calls.filter((args) => args[0] === "bootstrap").map((args) => args.at(-1))).toEqual([
      paths.maintenancePlistPath,
      paths.launchd.plistPath,
    ]);
  });

  it("regenerates the helper after a byte-identical main rewrite with a new inode identity", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    const launchd = pairedLaunchctlFixture();
    const deps = {
      platform: "darwin" as const,
      homeDir: home,
      getuid: () => 501,
      prepareState,
      acquireLifecycleLock: async () => async () => undefined,
      launchctl: launchd.runner,
      tailscale: unavailableTailscaleRunner(),
      ensureManagedRuntime: async () => ({
        cliPath: "/managed/dist/cli.js",
        nodePath: "/managed/node",
        launchProof: "cHJvb2Y",
      }),
      healthcheck: async () => true,
      isAlive: launchd.isAlive,
      stdout: { write: (_text: string) => undefined },
      stderr: { write: (_text: string) => undefined },
    };
    await expect(runWebCommand({ positionals: ["start"], env: {}, loopback: true }, deps)).resolves.toBe(0);
    const firstMain = await readFile(paths.launchd.plistPath, "utf8");
    const firstIdentity = await compositeIdentity(paths.launchd.plistPath);
    await expect(runWebCommand({ positionals: ["restart"], env: {}, loopback: true }, deps)).resolves.toBe(0);
    const secondIdentity = await compositeIdentity(paths.launchd.plistPath);
    const helper = await readFile(paths.maintenancePlistPath, "utf8");

    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(firstMain);
    expect(secondIdentity).not.toBe(firstIdentity);
    expect(helper).toContain(`<string>${secondIdentity}</string>`);
    expect(helper).not.toContain(`<string>${firstIdentity}</string>`);
  });

  it("converges an abandoned restoring intent with zero additional rotation", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "prior main plist\n", { mode: 0o600 });
    await writeFile(paths.recordPath, `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      theme: "evergreen",
      updatedAt: "2026-08-14T12:00:00.000Z",
    })}\n`, { mode: 0o600 });
    await writeFile(paths.launchd.stdoutPath, Buffer.alloc(LAUNCHD_LOG_MAX_BYTES + 1, "x"), { mode: 0o600 });
    const stopping = {
      version: 1 as const,
      phase: "stopping" as const,
      label: WEB_LAUNCHD_LABEL,
      plistFingerprint: await compositeIdentity(paths.launchd.plistPath),
    };
    await beginLaunchdLogMaintenanceIntent(paths.launchd, stopping);
    const stopped = await markLaunchdLogMaintenanceStopped(paths.launchd, stopping);
    await markLaunchdLogMaintenanceRestoring(paths.launchd, stopped);
    const launchd = pairedLaunchctlFixture();

    await expect(runWebCommand(
      { positionals: ["start"], env: {}, loopback: true },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({
          cliPath: "/managed/dist/cli.js",
          nodePath: "/managed/node",
          launchProof: "cHJvb2Y",
        }),
        verifyMaintenanceEntrypoint: async () => undefined,
        healthcheck: async () => true,
        isAlive: launchd.isAlive,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(0);

    expect((await stat(paths.launchd.stdoutPath)).size).toBe(LAUNCHD_LOG_MAX_BYTES + 1);
    await expect(stat(`${paths.launchd.stdoutPath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readLaunchdLogMaintenanceIntent(paths.launchd)).resolves.toBeUndefined();
  });

  it("fails closed on an abandoned stopping intent without unloading either service", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "prior main plist\n", { mode: 0o600 });
    await beginLaunchdLogMaintenanceIntent(paths.launchd, {
      version: 1,
      phase: "stopping",
      label: WEB_LAUNCHD_LABEL,
      plistFingerprint: await compositeIdentity(paths.launchd.plistPath),
    });
    const launchd = pairedLaunchctlFixture({ helper: true });
    await expect(runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(1);
    expect(launchd.calls.some((args) => args[0] === "bootout")).toBe(false);
  });

  it("never bootstraps a partial pair when helper regeneration fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    const launchd = pairedLaunchctlFixture();
    const writer = async (path: string, contents: string): Promise<void> => {
      if (path === paths.maintenancePlistPath) throw new Error("injected helper publication failure");
      await writeFile(path, contents, { mode: 0o600 });
    };
    await expect(runWebCommand(
      { positionals: ["start"], env: {}, loopback: true },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl: launchd.runner,
        ensureManagedRuntime: async () => ({
          cliPath: "/managed/dist/cli.js",
          nodePath: "/managed/node",
          launchProof: "cHJvb2Y",
        }),
        writePrivateFile: writer,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    )).resolves.toBe(1);
    expect(launchd.calls.some((args) => args[0] === "bootstrap")).toBe(false);
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.maintenancePlistPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a partial first-start publication when the plist write fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let writes = 0;
    const writePrivateFile = async (path: string, contents: string) => {
      writes += 1;
      if (writes === 2) throw new Error("plist disk failure");
      await writeFile(path, contents, { mode: 0o600 });
    };
    const launchctl = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not loaded" }));

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        writePrivateFile,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(1);
    await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.maintenancePlistPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootstrap"]));
  });

  it("pins the node's exact Tailscale DNS hostname into the worker before claiming Serve", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let loaded = false;
    const launchctl = async (args: readonly string[]) => {
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const claimRunner = scriptedClaimRunner();
    let dnsReads = 0;
    const tailscale: CommandRunner = async (args) => {
      if (args[0] === "status" && dnsReads++ === 0) {
        return { code: 1, stdout: "", stderr: "transient LocalAPI failure" };
      }
      return claimRunner(args);
    };
    const sleep = vi.fn(async () => undefined);
    const code = await runWebCommand(
      {
        positionals: ["start"],
        theme: "terracotta",
        env: {
          MONO_AGENT_WEB_ALLOWED_HOSTS: "console.home.arpa",
          MONO_AGENT_WEB_PUSH_SUBJECT: "mailto:owner@example.test",
        },
      },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale,
        sleep,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        healthcheck: async () => true,
        isAlive: () => loaded,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(dnsReads).toBeGreaterThanOrEqual(2);
    const plist = await readFile(paths.launchd.plistPath, "utf8");
    expect(plist).toContain("<string>MONO_AGENT_WEB_ALLOWED_HOSTS=console.home.arpa,host.example.ts.net</string>");
    expect(plist).toContain("<string>MONO_AGENT_WEB_PUSH_SUBJECT=mailto:owner@example.test</string>");
    expect(plist).toContain("<string>--theme</string>");
    expect(plist).toContain("<string>terracotta</string>");
    expect(JSON.parse(await readFile(paths.recordPath, "utf8"))).toMatchObject({ theme: "terracotta" });
  });

  it("preserves the recorded theme when restart does not override it", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "old plist\n", { mode: 0o600 });
    await writeFile(paths.recordPath, `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "127.0.0.1",
      port: 5050,
      theme: "plum",
      updatedAt: "2026-07-17T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    let workerLoaded = true;
    let helperLoaded = false;
    const launchctl = async (args: readonly string[]) => {
      const helper = args.some((value) => value.includes("com.mono-agent-web-maintenance"));
      const loaded = helper ? helperLoaded : workerLoaded;
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded && !helper ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootout") {
        if (helper) helperLoaded = false;
        else workerLoaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        if (helper) helperLoaded = true;
        else workerLoaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    let errors = "";
    const result = await runWebCommand(
      { positionals: ["restart"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        healthcheck: async () => true,
        isAlive: (pid) => pid === 777 && workerLoaded,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );
    expect(result, errors).toBe(0);

    expect(JSON.parse(await readFile(paths.recordPath, "utf8"))).toMatchObject({ theme: "plum" });
    expect(await readFile(paths.launchd.plistPath, "utf8")).toContain("<string>plum</string>");
  });

  it("retains an exact owned Tailscale hostname when LocalAPI status is transiently unavailable", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "Library"), { mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });

    let loaded = false;
    const launchctl = async (args: readonly string[]) => {
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const tailscale = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "status") return { code: 1, stdout: "", stderr: "LocalAPI unavailable" };
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
          }),
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    let output = "";

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale,
        sleep: async () => undefined,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        healthcheck: async () => true,
        isAlive: () => loaded,
        stdout: { write: (text) => { output += text; } },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(await readFile(paths.launchd.plistPath, "utf8"))
      .toContain("<string>MONO_AGENT_WEB_ALLOWED_HOSTS=host.example.ts.net</string>");
    expect(output).toContain("https://host.example.ts.net/ (existing owned handler)");
    expect(tailscale.mock.calls.filter(([args]) => args[0] === "status")).toHaveLength(3);
  });

  it("boots out a partially loaded first start and removes its artifacts after bootstrap failure", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let loaded = false;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 1, stdout: "", stderr: "bootstrap failed after load" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let errors = "";

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        isAlive: () => false,
        stdout: { write: () => undefined },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(errors).toContain("launchctl could not start");
    expect(loaded).toBe(false);
    expect(calls.map((args) => args[0])).toContain("bootout");
    await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.maintenancePlistPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops a crash-looping first start and removes its artifacts after readiness timeout", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(join(home, "Library"), { mode: 0o700 });
    let loaded = false;
    const calls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    let clock = 0;

    const code = await runWebCommand(
      { positionals: ["start"], env: {} },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale: unavailableTailscaleRunner(),
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        healthcheck: async () => false,
        isAlive: () => false,
        now: () => { clock += 20_000; return clock; },
        sleep: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(1);
    expect(loaded).toBe(false);
    expect(calls.some((args) => args[0] === "bootout")).toBe(true);
    await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.launchd.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.maintenancePlistPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls worker, service record, plist, and Tailnet route back to 5050 when a 5051 migration claim fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const oldPlist = "old 5050 plist\n";
    const oldRecord = `${JSON.stringify({
      schema: "mono-agent.web-service.v1",
      host: "0.0.0.0",
      port: 5050,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }, undefined, 2)}\n`;
    await writeFile(paths.launchd.plistPath, oldPlist, { mode: 0o600 });
    await writeFile(paths.recordPath, oldRecord, { mode: 0o600 });

    let loaded = true;
    let currentTarget: string | undefined = "http://127.0.0.1:5050";
    const launchCalls: string[][] = [];
    const launchctl = async (args: readonly string[]) => {
      launchCalls.push([...args]);
      if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: loaded ? "pid = 777\n" : "", stderr: "" };
      if (args[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const tailscale: CommandRunner = async (args) => {
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(currentTarget === undefined ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: currentTarget } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        if (args[3] === "http://127.0.0.1:5051") return { code: 1, stdout: "", stderr: "claim failed" };
        currentTarget = args[3];
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const code = await runWebCommand(
      { positionals: ["restart"], env: {}, port: 5051 },
      {
        platform: "darwin",
        homeDir: home,
        getuid: () => 501,
        prepareState,
        acquireLifecycleLock: async () => async () => undefined,
        launchctl,
        tailscale,
        ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
        healthcheck: async () => true,
        isAlive: () => loaded,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(code).toBe(1);
    expect(loaded).toBe(true);
    expect(currentTarget).toBe("http://127.0.0.1:5050");
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(oldPlist);
    expect(await readFile(paths.recordPath, "utf8")).toBe(oldRecord);
    expect(await readFile(paths.tailscalePath, "utf8")).toContain("http://127.0.0.1:5050");
    expect(launchCalls.filter((args) => args[0] === "bootstrap").map((args) => args.at(-1))).toEqual([
      paths.maintenancePlistPath,
      paths.launchd.plistPath,
      paths.maintenancePlistPath,
      paths.launchd.plistPath,
    ]);
  });
});

describe("webHealthcheck", () => {
  it("accepts only the exact versioned JSON health contract", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(new Response("unrelated service", { status: 200, headers: { "content-type": "text/plain" } }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: 1, push: "ok", extra: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: 1, push: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: 1, push: "degraded" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: 1, push: "unknown" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(false);

    for (const status of ["ok", "degraded"]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status, version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await expect(webHealthcheck("http://127.0.0.1:5050/healthz")).resolves.toBe(true);
    }
  });
});

describe("Tailscale Serve ownership", () => {
  it("prefers 443, then the first free port in 8443-8499", () => {
    expect(chooseTailscaleHttpsPort({ TCP: {} })).toBe(443);
    expect(chooseTailscaleHttpsPort({ TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } } })).toBe(8444);
    const full = Object.fromEntries([443, ...Array.from({ length: 57 }, (_, index) => 8443 + index)]
      .map((port) => [String(port), { HTTPS: true }]));
    expect(chooseTailscaleHttpsPort({ TCP: full })).toBeUndefined();
  });

  it("uses a loopback proxy only when the configured bind can receive it", async () => {
    expect(tailscaleProxyTarget("0.0.0.0", 5050)).toBe("http://127.0.0.1:5050");
    expect(tailscaleProxyTarget("127.0.0.1", 5050)).toBe("http://127.0.0.1:5050");
    expect(tailscaleProxyTarget("::", 5050)).toBe("http://[::1]:5050");
    expect(tailscaleProxyTarget("::1", 5050)).toBe("http://[::1]:5050");
    expect(tailscaleProxyTarget("localhost", 5050)).toBeUndefined();
    expect(tailscaleProxyTarget("192.0.2.42", 5050)).toBeUndefined();
    expect(tailscaleProxyTarget("2001:db8::42", 5050)).toBeUndefined();

    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    const runner = vi.fn<CommandRunner>();
    const result = await ensureTailscaleServe(paths, "192.0.2.42", 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("claims 8443 without overwriting an existing 443 handler", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let serveStatusReads = 0;
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: CommandRunner = vi.fn(async (args) => {
      mutableCalls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        serveStatusReads += 1;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(serveStatusReads === 1
            ? {
                TCP: { "443": { HTTPS: true } },
                Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4599" } } } },
              }
            : {
                TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
                Web: {
                  "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4599" } } },
                  "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } },
                },
              }),
        };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { tailscale: runner, homeDir: home });
    expect(result).toMatchObject({ kind: "active", reused: false, ownership: { httpsPort: 8443 } });
    expect(mutableCalls).toContainEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:5050"]);
    expect(mutableCalls).not.toContainEqual(expect.arrayContaining(["reset"]));
    expect(await readFile(paths.tailscalePath, "utf8")).toContain("host.example.ts.net:8443");
  });

  it("removes only an exact owned route and refuses a changed handler", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const off = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
          }),
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await removeOwnedTailscaleServe(paths, { homeDir: home, tailscale: off });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(off).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
    await expect(stat(paths.tailscalePath)).resolves.toBeDefined();
  });

  it("refuses post-claim ownership when a sibling handler appears in the immediate status", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let statusReads = 0;
    const runner = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        statusReads += 1;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(statusReads === 1 ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: {
              "host.example.ts.net:443": {
                Handlers: {
                  "/": { Proxy: "http://127.0.0.1:5050" },
                  "/user-added": { Proxy: "http://127.0.0.1:7000" },
                },
              },
            },
          }),
        };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("root Proxy-only shape");
    expect(runner).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a malformed ownership record without touching Tailscale", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.tailscalePath, "{not-json\n", { mode: 0o600 });
    const runner = vi.fn<CommandRunner>();

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("malformed");
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(paths.tailscalePath, "utf8")).toBe("{not-json\n");
  });

  it("clears an ownership record only after confirming its exact route is absent twice", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const runner = vi.fn<CommandRunner>(async (args) => args[0] === "serve" && args[1] === "status"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {}, Web: {} }) }
      : { code: 1, stderr: "unexpected mutation", stdout: "" });

    await expect(removeOwnedTailscaleServe(paths, { homeDir: home, tailscale: runner })).resolves.toEqual({ kind: "absent" });
    expect(runner.mock.calls.filter(([args]) => args[0] === "serve" && args[1] === "status")).toHaveLength(2);
    expect(runner).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to turn off a port when a sibling handler was added after ownership", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const runner = vi.fn<CommandRunner>(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: {
              "host.example.ts.net:443": {
                Handlers: {
                  "/": { Proxy: "http://127.0.0.1:5050" },
                  "/user-added": { Proxy: "http://127.0.0.1:7000" },
                },
              },
            },
          }),
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await removeOwnedTailscaleServe(paths, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(runner).not.toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });

  it("removes the exact prior owned route before migrating to a changed app port", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });

    let currentTarget: string | undefined = "http://127.0.0.1:5050";
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(currentTarget === undefined ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: currentTarget } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        currentTarget = args[3];
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5051, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "active", ownership: { proxyTarget: "http://127.0.0.1:5051" } });
    const offIndex = calls.findIndex((args) => args.join(" ") === "serve --https=443 off");
    const claimIndex = calls.findIndex((args) => args.join(" ") === "serve --bg --https=443 http://127.0.0.1:5051");
    expect(offIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(offIndex);
    expect(await readFile(paths.tailscalePath, "utf8")).not.toContain("5050\"");
  });

  it("restores the prior exact route and ownership when a changed-port claim fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: scriptedClaimRunner(),
    });
    const priorContents = await readFile(paths.tailscalePath, "utf8");
    let currentTarget: string | undefined = "http://127.0.0.1:5050";
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(currentTarget === undefined ? { TCP: {}, Web: {} } : {
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: currentTarget } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        const requestedTarget = args[3];
        if (requestedTarget === "http://127.0.0.1:5051") {
          return { code: 1, stdout: "", stderr: "claim failed" };
        }
        currentTarget = requestedTarget;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5051, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("prior exact HTTPS route and ownership record were restored");
    expect(currentTarget).toBe("http://127.0.0.1:5050");
    expect(await readFile(paths.tailscalePath, "utf8")).toBe(priorContents);
    expect(calls).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:5051"]);
    expect(calls.filter((args) => args.join(" ") === "serve --bg --https=443 http://127.0.0.1:5050")).toHaveLength(1);
  });

  it("rolls back the exact new handler when durable ownership publication fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    const runner = vi.fn(scriptedClaimRunner());
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, {
      homeDir: home,
      tailscale: runner,
      writePrivateFile: async () => { throw new Error("disk full"); },
    });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("rolled back");
    expect(runner).toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });

  it("re-verifies and rolls back an exact new handler after the first verification read fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let statusReads = 0;
    const runner: CommandRunner = vi.fn(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        statusReads += 1;
        if (statusReads === 1) return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
        if (statusReads === 2) return { code: 1, stderr: "transient status failure", stdout: "" };
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
          }),
        };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: runner });
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(runner).toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });
});

function scriptedClaimRunner(): CommandRunner {
  let reads = 0;
  return async (args) => {
    if (args[0] === "serve" && args[1] === "status") {
      reads += 1;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(reads === 1
          ? { TCP: {} }
          : {
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
            }),
      };
    }
    if (args[0] === "status") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function unavailableTailscaleRunner(): CommandRunner {
  return async () => ({ code: 1, stdout: "", stderr: "tailscale unavailable" });
}

describe("web service identity", () => {
  it("cannot be mistaken for a configured agent launchd label", () => {
    expect(WEB_LAUNCHD_LABEL).toBe("com.mono-agent-web");
    expect(WEB_LAUNCHD_LABEL).not.toMatch(/^com\.mono-agent\./u);
  });
});

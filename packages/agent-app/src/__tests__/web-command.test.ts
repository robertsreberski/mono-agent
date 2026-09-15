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
  LEGACY_DEFAULT_WEB_HOST,
  removeOwnedTailscaleServe,
  runWebCommand,
  tailscaleProxyTarget,
  webHealthcheck,
  webPaths,
  WEB_LAUNCHD_LABEL,
} from "../web-command.js";
import type { CommandRunner, RunWebCommandDeps } from "../web-command.js";
import {
  buildWebMaintenancePlistXml,
  buildWebPlistXml,
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
    // Fresh install default: a pristine console binds loopback and reports no
    // owned route; no LAN/tailnet URL is advertised without an explicit --host.
    expect(output).toContain("http://127.0.0.1:5050/");
    expect(output).toContain("mono-agent-owned Tailscale route: none");
    expect(output).toContain("--share-tailnet");
    expect(output).not.toContain("http://192.168.2.42:5050/");
    expect(output).not.toContain("http://100.64.0.7:5050/");
    expect(output).not.toContain("fd7a:115c:a1e0::7");
    expect(output).not.toContain("203.0.113.9");
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

  it("rejects console names the manifest and launchd argv cannot carry", async () => {
    for (const [name, expected] of [
      ["   ", "must not be empty"],
      ["bad\u0007name", "control characters"],
      ["bad\u2028name", "line separators"],
      ["bad\u202ename", "bidirectional overrides"],
      ["x".repeat(81), "at most 80 characters"],
    ] as const) {
      const startServer = vi.fn();
      let errors = "";
      await expect(runWebCommand(
        { positionals: ["run"], env: {}, name },
        {
          startServer,
          stdout: { write: () => undefined },
          stderr: { write: (text) => { errors += text; } },
        },
      )).resolves.toBe(2);
      expect(errors).toContain(expected);
      expect(startServer).not.toHaveBeenCalled();
    }
  });

  it("does not silently ignore presentation flags passed to start when the managed service is already loaded", async () => {
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

    await expect(runWebCommand(
      { positionals: ["start"], env: {}, name: "Robert's Console" },
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

    expect(errors).toContain("mono-agent web restart --name 'Robert'\"'\"'s Console'");
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

  it("falls back to foreground status when the Linux systemd user manager is unavailable", async () => {
    const home = await testHome();
    let output = "";
    let errors = "";

    const code = await runWebCommand(
      { positionals: [], env: {} },
      {
        platform: "linux",
        homeDir: home,
        systemd: { run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) },
        stdout: { write: (text) => { output += text; } },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(0);
    expect(output).toContain("Web console status");
    expect(output).toContain("mono-agent web start");
    expect(errors).not.toContain("Linux web lifecycle");
  });

  it("keeps explicit Linux web status read-only when the systemd user manager is unavailable", async () => {
    const home = await testHome();
    let output = "";
    let errors = "";

    const code = await runWebCommand(
      { positionals: ["status"], env: {} },
      {
        platform: "linux",
        homeDir: home,
        systemd: { run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) },
        stdout: { write: (text) => { output += text; } },
        stderr: { write: (text) => { errors += text; } },
      },
    );

    expect(code).toBe(1);
    expect(output).toContain("Web console status");
    expect(output).toContain("mono-agent web start");
    expect(errors).not.toContain("Linux web lifecycle");
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
        shareTailnet: true,
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

  it("preserves the recorded console name by default and clears it with --name -", async () => {
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
      name: "Flockbox",
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
    const dependencies = {
      platform: "darwin" as const,
      homeDir: home,
      getuid: () => 501,
      prepareState,
      acquireLifecycleLock: async () => async () => undefined,
      launchctl,
      tailscale: unavailableTailscaleRunner(),
      ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
      healthcheck: async () => true,
      isAlive: (pid: number) => pid === 777 && workerLoaded,
      stdout: { write: () => undefined },
      stderr: { write: (text: string) => { errors += text; } },
    };
    const result = await runWebCommand(
      { positionals: ["restart"], env: {} },
      dependencies,
    );
    expect(result, errors).toBe(0);

    expect(JSON.parse(await readFile(paths.recordPath, "utf8"))).toMatchObject({ name: "Flockbox" });
    let plist = await readFile(paths.launchd.plistPath, "utf8");
    expect(plist).toContain("<string>--name</string>");
    expect(plist).toContain("<string>Flockbox</string>");

    const cleared = await runWebCommand(
      { positionals: ["restart"], env: {}, name: "-" },
      dependencies,
    );
    expect(cleared, errors).toBe(0);
    expect(JSON.parse(await readFile(paths.recordPath, "utf8"))).not.toHaveProperty("name");
    plist = await readFile(paths.launchd.plistPath, "utf8");
    expect(plist).not.toContain("<string>--name</string>");
    expect(plist).not.toContain("<string>Flockbox</string>");
  });

  it("retains an exact owned Tailscale hostname when LocalAPI status is transiently unavailable", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
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
    expect(result).toMatchObject({ kind: "unavailable", routeOutcome: "rolled-back" });
    expect(result.kind === "unavailable" ? result.detail : "").toContain("absence was verified");
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

/**
 * A managed-start harness: paired launchd fixture, captured stdout/stderr, and
 * deps that always prove the replacement worker healthy unless overridden.
 */
async function managedStartHarness(home: string, overrides: Partial<RunWebCommandDeps> = {}) {
  await mkdir(join(home, "Library"), { recursive: true, mode: 0o700 });
  const fixture = pairedLaunchctlFixture();
  const captured = { stdout: "", stderr: "" };
  const deps: RunWebCommandDeps = {
    platform: "darwin" as NodeJS.Platform,
    homeDir: home,
    getuid: () => 501,
    prepareState,
    acquireLifecycleLock: async () => async () => undefined,
    launchctl: fixture.runner,
    sleep: async () => undefined,
    ensureManagedRuntime: async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }),
    healthcheck: async () => true,
    isAlive: fixture.isAlive,
    stdout: { write: (text: string) => { captured.stdout += text; } },
    stderr: { write: (text: string) => { captured.stderr += text; } },
    ...overrides,
  };
  return { fixture, captured, deps };
}

const EXACT_ABSENT_OWNERSHIP = {
  schema: "mono-agent.web-tailscale-serve.v1",
  webKey: "host.example.ts.net:8443",
  httpsPort: 8443,
  proxyTarget: "http://127.0.0.1:5050",
  configSha256: "a".repeat(64),
  url: "https://host.example.ts.net:8443/",
  configuredAt: new Date(0).toISOString(),
};

/** The macOS managed worker prefix `buildWebLaunchdProgramArguments` writes before `web run …`. */
const managedWebArgv = (...args: readonly string[]): string[] =>
  ["/usr/bin/env", "-i", "PATH=/usr/bin", "/managed/node", "/managed/dist/cli.js", ...args];

/** Reports the node DNS name and an empty Serve table (the owned route is absent). */
function absentRouteRunner(): CommandRunner {
  return async (args) => {
    if (args[0] === "serve" && args[1] === "status") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
    }
    if (args[0] === "status") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
    }
    return { code: 1, stderr: "unexpected command", stdout: "" };
  };
}

describe("web console exposure contract", () => {
  it("binds loopback on a pristine start and never runs the Tailscale CLI", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    const tailscale = vi.fn(absentRouteRunner());
    const { captured, deps } = await managedStartHarness(home, { tailscale });

    expect(await runWebCommand({ positionals: ["start"], env: {} }, deps)).toBe(0);

    expect(tailscale).not.toHaveBeenCalled();
    const plist = await readFile(paths.launchd.plistPath, "utf8");
    expect(plist).toContain("<string>--host</string>");
    expect(plist).toContain(`<string>${DEFAULT_WEB_HOST}</string>`);
    expect(JSON.parse(await readFile(paths.recordPath, "utf8"))).toMatchObject({
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
    });
    expect(captured.stdout).toContain("mono-agent-owned Tailscale route: none");
    expect(captured.stdout).toContain(`http://${DEFAULT_WEB_HOST}:${String(DEFAULT_WEB_PORT)}/`);
    expect(captured.stdout).not.toContain(LEGACY_DEFAULT_WEB_HOST);
    expect(captured.stderr).not.toContain("Tailscale");
  });

  it("recovers a stopped install's published bind from its LaunchAgent definition", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, buildWebPlistXml({
      label: WEB_LAUNCHD_LABEL,
      nodePath: "/managed/node",
      cliPath: "/managed/dist/cli.js",
      cwd: paths.stateDir,
      host: LEGACY_DEFAULT_WEB_HOST,
      port: 5051,
      theme: "plum",
      name: "Legacy Console",
      stdoutPath: paths.launchd.stdoutPath,
      stderrPath: paths.launchd.stderrPath,
      environment: {},
    }), { mode: 0o600 });
    // No service record: this install is stopped, not fresh.
    const { deps } = await managedStartHarness(home);

    expect(await runWebCommand({ positionals: ["start"], env: {} }, deps)).toBe(0);

    const record = JSON.parse(await readFile(paths.recordPath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ host: LEGACY_DEFAULT_WEB_HOST, port: 5051, theme: "plum", name: "Legacy Console" });
    const plist = await readFile(paths.launchd.plistPath, "utf8");
    expect(plist).toContain(`<string>${LEGACY_DEFAULT_WEB_HOST}</string>`);
    expect(plist).toContain("<string>5051</string>");
    expect(plist).toContain("<string>Legacy Console</string>");
  });

  it("refuses to start over an unvalidated existing definition without mutating it", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "not a plist\n", { mode: 0o600 });
    const { fixture, captured, deps } = await managedStartHarness(home);

    expect(await runWebCommand({ positionals: ["start"], env: {} }, deps)).toBe(1);

    expect(captured.stderr).toContain("could not be validated");
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe("not a plist\n");
    expect(fixture.calls.some((args) => args[0] === "bootstrap")).toBe(false);
    await expect(readFile(paths.recordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the healthy worker and exits nonzero when an explicit share cannot resolve the DNS name", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    const { fixture, captured, deps } = await managedStartHarness(home, { tailscale: unavailableTailscaleRunner() });

    expect(await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, deps)).toBe(1);

    expect(fixture.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(captured.stderr).toContain("Sharing failed:");
    expect(captured.stderr).toContain("No Tailscale handler was changed by this command");
    expect(captured.stderr).not.toContain("route was created");
    expect(captured.stdout).toContain(`http://${DEFAULT_WEB_HOST}:${String(DEFAULT_WEB_PORT)}/`);
    expect(captured.stdout).not.toContain("Tailscale route: http");
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the healthy worker and exits nonzero when the ownership record is invalid", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await writeFile(paths.tailscalePath, "{\"schema\":\"not-ours\"}\n", { mode: 0o600 });
    const { fixture, captured, deps } = await managedStartHarness(home, { tailscale: absentRouteRunner() });

    expect(await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, deps)).toBe(1);

    expect(fixture.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(captured.stderr).toContain("Sharing failed:");
    expect(await readFile(paths.tailscalePath, "utf8")).toBe("{\"schema\":\"not-ours\"}\n");
  });

  it("keeps the healthy worker and exits nonzero when the explicit share claim fails", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "serve" && args[1] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 1, stderr: "serve failed", stdout: "" };
    };
    const { fixture, captured, deps } = await managedStartHarness(home, { tailscale: runner });

    expect(await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, deps)).toBe(1);

    expect(fixture.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(calls).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:5050"]);
    expect(captured.stderr).toContain("Sharing failed:");
    // A failed claim is not proof that nothing was created: never assert absence.
    expect(captured.stderr).toContain("A Tailscale handler may remain");
    expect(captured.stderr).toContain("attempted HTTPS port 443 -> http://127.0.0.1:5050");
    expect(captured.stderr).toContain("tailscale serve status");
    expect(captured.stderr).not.toContain("route was created");
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the healthy worker and exits nonzero when ownership cannot be recorded", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    const runner = vi.fn(scriptedClaimRunner());
    const { fixture, captured, deps } = await managedStartHarness(home, {
      tailscale: runner,
      writePrivateFile: async (path: string, contents: string) => {
        if (path === paths.tailscalePath) throw new Error("disk full");
        await writeFile(path, contents, { mode: 0o600 });
      },
    });

    expect(await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, deps)).toBe(1);

    expect(fixture.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(captured.stderr).toContain("Sharing failed:");
    expect(captured.stderr).toContain("The newly created Tailscale handler was rolled back; no mono-agent-owned route remains");
    expect(captured.stderr).toContain("attempted HTTPS port 443");
    expect(runner).toHaveBeenCalledWith(["serve", "--https=443", "off"]);
  });

  it("does not create a route for a proven-absent ownership record without --share-tailnet", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await writeFile(paths.tailscalePath, `${JSON.stringify(EXACT_ABSENT_OWNERSHIP, undefined, 2)}\n`, { mode: 0o600 });
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      return await absentRouteRunner()(args);
    };
    const { captured, deps } = await managedStartHarness(home, { tailscale: runner });

    expect(await runWebCommand({ positionals: ["start"], env: {} }, deps)).toBe(0);

    expect(calls.some((args) => args[0] === "serve" && args[1] === "--bg")).toBe(false);
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(captured.stdout).toContain("mono-agent-owned Tailscale route: none");
  });

  it("refuses --share-tailnet on a bare start when the console is already managed", async () => {
    const home = await testHome();
    const fixture = pairedLaunchctlFixture({ worker: true, helper: true });
    const captured = { stdout: "", stderr: "" };
    const code = await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, {
      platform: "darwin" as NodeJS.Platform,
      homeDir: home,
      getuid: () => 501,
      prepareState,
      launchctl: fixture.runner,
      stdout: { write: (text: string) => { captured.stdout += text; } },
      stderr: { write: (text: string) => { captured.stderr += text; } },
    });

    expect(code).toBe(1);
    expect(captured.stderr).toContain("mono-agent web restart --share-tailnet");
  });

  it("rejects --share-tailnet for the Linux managed lifecycle", async () => {
    const home = await testHome();
    const captured = { stdout: "", stderr: "" };
    const code = await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, {
      platform: "linux" as NodeJS.Platform,
      homeDir: home,
      stdout: { write: (text: string) => { captured.stdout += text; } },
      stderr: { write: (text: string) => { captured.stderr += text; } },
    });

    expect(code).toBe(2);
    expect(captured.stderr).toContain("Linux HTTPS routes are externally managed");
  });

  it("reports the listener and the owned route separately, including JSON", async () => {
    const home = await testHome();
    const human = { stdout: "", stderr: "" };
    const humanCode = await runWebCommand({ positionals: ["status"], env: {} }, {
      platform: "freebsd" as NodeJS.Platform,
      homeDir: home,
      stdout: { write: (text: string) => { human.stdout += text; } },
      stderr: { write: (text: string) => { human.stderr += text; } },
    });
    expect(humanCode).toBe(1);
    expect(human.stdout).toContain("listener");
    expect(human.stdout).toContain(`127.0.0.1:${String(DEFAULT_WEB_PORT)}`);
    expect(human.stdout).toContain("mono-agent-owned Tailscale route: none");
    expect(human.stdout).toContain("other proxies and routes are not inspected");
    expect(human.stdout).toContain("no application login");
    expect(human.stdout).not.toMatch(/this computer only/iu);

    const jsonOutput = { stdout: "", stderr: "" };
    const jsonCode = await runWebCommand({ positionals: ["status"], json: true, env: {} }, {
      platform: "freebsd" as NodeJS.Platform,
      homeDir: home,
      stdout: { write: (text: string) => { jsonOutput.stdout += text; } },
      stderr: { write: (text: string) => { jsonOutput.stderr += text; } },
    });
    expect(jsonCode).toBe(1);
    const status = JSON.parse(jsonOutput.stdout) as {
      ok: boolean;
      listener: { host: string; port: number; url: string; source: string; provenRunning: boolean };
      ownedTailscaleRoute: { state: string };
      authentication: string;
      note: string;
    };
    expect(status.ok).toBe(false);
    expect(status.listener).toEqual({
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
      url: `http://${DEFAULT_WEB_HOST}:${String(DEFAULT_WEB_PORT)}/`,
      source: "fresh default",
      provenRunning: false,
    });
    expect(status.ownedTailscaleRoute.state).toBe("none");
    expect(status.authentication).toBe("none");
    expect(status.note).toContain("not inspected");
  });

  it("refuses a foreign or ambiguous persisted definition without touching launchd", async () => {
    const cases: ReadonlyArray<readonly string[]> = [
      // An unrelated command with plausible values is not a managed web definition.
      ["/bin/echo", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"],
      // Duplicate options are ambiguous, not a last-one-wins invitation.
      [...managedWebArgv("web", "run", "--host", "0.0.0.0", "--port", "5051", "--port", "5052", "--theme", "plum")],
      // A non-numeric port must never reach a definition.
      [...managedWebArgv("web", "run", "--host", "0.0.0.0", "--port", "not-a-number", "--theme", "plum")],
      // Padded foreign launchers: an env prefix and a valid option list are not
      // enough when the executable/entrypoint filenames are not the managed ones.
      ["/usr/bin/env", "-i", "/bin/echo", "/managed/dist/cli.js", "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"],
      ["/usr/bin/env", "-i", "/usr/bin/node", "/bin/echo", "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"],
    ];
    for (const argv of cases) {
      const home = await testHome();
      const paths = webPaths(home);
      await prepareState({ stateDir: paths.stateDir });
      await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
      const plist = buildWebPlistXml({
        label: WEB_LAUNCHD_LABEL,
        nodePath: "/managed/node",
        cliPath: "/managed/dist/cli.js",
        cwd: paths.stateDir,
        host: "0.0.0.0",
        port: 5051,
        theme: "plum",
        stdoutPath: paths.launchd.stdoutPath,
        stderrPath: paths.launchd.stderrPath,
        environment: {},
      });
      // Replace the managed argv with the case under test while keeping a valid plist.
      const foreign = plist.replace(
        /<array>[\s\S]*?<\/array>/u,
        `<array>\n${argv.map((token) => `    <string>${token}</string>`).join("\n")}\n  </array>`,
      );
      await writeFile(paths.launchd.plistPath, foreign, { mode: 0o600 });
      const runtime = vi.fn(async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }));
      const { fixture, captured, deps } = await managedStartHarness(home, { ensureManagedRuntime: runtime });

      expect(await runWebCommand({ positionals: ["start"], env: {} }, deps)).toBe(1);

      expect(captured.stderr).toContain("could not be validated");
      expect(runtime).not.toHaveBeenCalled();
      expect(fixture.calls.some((args) => args[0] === "bootout")).toBe(false);
      expect(fixture.calls.some((args) => args[0] === "bootstrap")).toBe(false);
      expect(await readFile(paths.launchd.plistPath, "utf8")).toBe(foreign);
      await expect(stat(paths.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps a loaded maintenance helper untouched when the main definition is invalid", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "not a plist\n", { mode: 0o600 });
    const fixture = pairedLaunchctlFixture({ worker: false, helper: true });
    const runtime = vi.fn(async () => ({ cliPath: "/managed/dist/cli.js", nodePath: "/managed/node", launchProof: "cHJvb2Y" }));
    const captured = { stdout: "", stderr: "" };
    const code = await runWebCommand({ positionals: ["start"], env: {} }, {
      platform: "darwin" as NodeJS.Platform,
      homeDir: home,
      getuid: () => 501,
      prepareState,
      acquireLifecycleLock: async () => async () => undefined,
      launchctl: fixture.runner,
      sleep: async () => undefined,
      ensureManagedRuntime: runtime,
      healthcheck: async () => true,
      isAlive: fixture.isAlive,
      stdout: { write: (text: string) => { captured.stdout += text; } },
      stderr: { write: (text: string) => { captured.stderr += text; } },
    });

    expect(code).toBe(1);
    expect(captured.stderr).toContain("could not be validated");
    expect(fixture.loaded.get(WEB_MAINTENANCE_LAUNCHD_LABEL)).toBe(true);
    expect(runtime).not.toHaveBeenCalled();
    expect(fixture.calls.some((args) => args[0] === "bootout")).toBe(false);
    expect(fixture.calls.some((args) => args[0] === "bootstrap")).toBe(false);
    expect(await readFile(paths.launchd.plistPath, "utf8")).toBe("not a plist\n");
  });

  it("reports a stopped install's recovered listener instead of the fresh default", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, buildWebPlistXml({
      label: WEB_LAUNCHD_LABEL,
      nodePath: "/managed/node",
      cliPath: "/managed/dist/cli.js",
      cwd: paths.stateDir,
      host: LEGACY_DEFAULT_WEB_HOST,
      port: 5051,
      theme: "plum",
      name: "Legacy Console",
      stdoutPath: paths.launchd.stdoutPath,
      stderrPath: paths.launchd.stderrPath,
      environment: {},
    }), { mode: 0o600 });
    const captured = { stdout: "", stderr: "" };
    const deps = {
      platform: "freebsd" as NodeJS.Platform,
      homeDir: home,
      stdout: { write: (text: string) => { captured.stdout += text; } },
      stderr: { write: (text: string) => { captured.stderr += text; } },
    };

    expect(await runWebCommand({ positionals: ["status"], env: {} }, deps)).toBe(1);
    expect(captured.stdout).toContain(`0.0.0.0:5051 (configured; not proven running)`);
    expect(captured.stdout).not.toContain(`127.0.0.1:5050`);
    expect(captured.stdout).toContain("plum");

    const jsonCaptured = { stdout: "", stderr: "" };
    expect(await runWebCommand({ positionals: ["status"], json: true, env: {} }, {
      ...deps,
      stdout: { write: (text: string) => { jsonCaptured.stdout += text; } },
      stderr: { write: (text: string) => { jsonCaptured.stderr += text; } },
    })).toBe(1);
    const status = JSON.parse(jsonCaptured.stdout) as {
      listener: { host: string | null; port: number | null; source: string; provenRunning: boolean };
      definitionError: string | null;
    };
    expect(status.listener).toMatchObject({
      host: LEGACY_DEFAULT_WEB_HOST,
      port: 5051,
      source: "installed definition",
      provenRunning: false,
    });
    expect(status.definitionError).toBeNull();
  });

  it("keeps an unreadable status definition unknown without probing it", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.launchd.plistPath, "not a plist\n", { mode: 0o600 });
    const healthcheck = vi.fn(async () => true);
    const captured = { stdout: "", stderr: "" };

    expect(await runWebCommand({ positionals: ["status"], json: true, env: {} }, {
      platform: "darwin" as NodeJS.Platform,
      homeDir: home,
      getuid: () => 501,
      launchctl: pairedLaunchctlFixture().runner,
      healthcheck,
      stdout: { write: (text: string) => { captured.stdout += text; } },
      stderr: { write: (text: string) => { captured.stderr += text; } },
    })).toBe(1);

    const status = JSON.parse(captured.stdout) as {
      ok: boolean;
      listener: { host: null; port: null; url: null; source: string };
      definitionError: string | null;
    };
    expect(status.ok).toBe(false);
    expect(status.listener).toMatchObject({ host: null, port: null, url: null, source: "unknown" });
    expect(status.definitionError).toContain("could not be validated");
    expect(healthcheck).not.toHaveBeenCalled();
  });

  it("distinguishes unverifiable, changed, and missing owned routes in status", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await writeFile(paths.tailscalePath, `${JSON.stringify(EXACT_ABSENT_OWNERSHIP, undefined, 2)}\n`, { mode: 0o600 });

    const statusWith = async (tailscale: CommandRunner) => {
      const captured = { stdout: "", stderr: "" };
      const code = await runWebCommand({ positionals: ["status"], json: true, env: {} }, {
        platform: "freebsd" as NodeJS.Platform,
        homeDir: home,
        tailscale,
        stdout: { write: (text: string) => { captured.stdout += text; } },
        stderr: { write: (text: string) => { captured.stderr += text; } },
      });
      return { code, captured };
    };

    // Inspection failure is not evidence of a mismatch.
    const failing = await statusWith(async (args) => {
      if (args[0] === "serve" && args[1] === "status") return { code: 1, stdout: "", stderr: "LocalAPI unavailable" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const failingStatus = JSON.parse(failing.captured.stdout) as {
      ownedTailscaleRoute: { state: string; detail?: string };
    };
    expect(failingStatus.ownedTailscaleRoute.state).toBe("unverifiable");
    expect(failingStatus.ownedTailscaleRoute.detail).toContain("LocalAPI unavailable");

    // A different handler at the same port is a real mismatch.
    const changed = await statusWith(async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "8443": { HTTPS: true } },
            Web: { "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
          }),
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const changedStatus = JSON.parse(changed.captured.stdout) as {
      ownedTailscaleRoute: { state: string; detail?: string };
    };
    expect(changedStatus.ownedTailscaleRoute.state).toBe("changed");
    expect(changedStatus.ownedTailscaleRoute.detail).toContain("does not match");

    // The recorded handler is provably gone: report that, not a mismatch.
    const missing = await statusWith(absentRouteRunner());
    const missingStatus = JSON.parse(missing.captured.stdout) as {
      ownedTailscaleRoute: { state: string; detail?: string };
    };
    expect(missingStatus.ownedTailscaleRoute.state).toBe("missing");
    expect(missingStatus.ownedTailscaleRoute.detail).toContain("no longer present");

    // Human output uses the same distinctions.
    const human = { stdout: "", stderr: "" };
    await runWebCommand({ positionals: ["status"], env: {} }, {
      platform: "freebsd" as NodeJS.Platform,
      homeDir: home,
      tailscale: absentRouteRunner(),
      stdout: { write: (text: string) => { human.stdout += text; } },
      stderr: { write: (text: string) => { human.stderr += text; } },
    });
    expect(human.stdout).toContain("mono-agent-owned Tailscale route: missing");
    await expect(stat(paths.tailscalePath)).resolves.toBeDefined();
  });

  it("never claims absence when an explicit share's cleanup could not be proven", async () => {
    const home = await testHome();
    const runner: CommandRunner = async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      // The claim fails, so ownership is never written and no rollback can be
      // proven: the outcome must stay uncertain rather than claiming absence.
      return { code: 1, stderr: "serve off failed", stdout: "" };
    };
    const { fixture, captured, deps } = await managedStartHarness(home, {
      tailscale: runner,
      writePrivateFile: async (path: string, contents: string) => {
        if (path.endsWith("tailscale-serve.json")) throw new Error("disk full");
        await writeFile(path, contents, { mode: 0o600 });
      },
    });

    expect(await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, deps)).toBe(1);

    expect(fixture.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(captured.stderr).toContain("Sharing failed:");
    expect(captured.stderr).toContain("A Tailscale handler may remain");
    expect(captured.stderr).toContain("attempted HTTPS port 443");
    expect(captured.stderr).toContain("tailscale serve status");
    expect(captured.stderr).not.toContain("no mono-agent-owned route remains");
  });

  it("reports a verification failure whose rollback is unverifiable as uncertain", async () => {
    const home = await testHome();
    let statusReads = 0;
    const runner: CommandRunner = async (args) => {
      if (args[0] === "serve" && args[1] === "status") {
        statusReads += 1;
        if (statusReads === 1) return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
        return { code: 1, stderr: "LocalAPI unavailable", stdout: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      return { code: 0, stderr: "", stdout: "" };
    };
    const { fixture, captured, deps } = await managedStartHarness(home, { tailscale: runner });

    expect(await runWebCommand({ positionals: ["start"], shareTailnet: true, env: {} }, deps)).toBe(1);

    expect(fixture.loaded.get(WEB_LAUNCHD_LABEL)).toBe(true);
    expect(captured.stderr).toContain("handler command succeeded but verification failed");
    expect(captured.stderr).toContain("A Tailscale handler may remain");
    expect(captured.stderr).not.toContain("no mono-agent-owned route remains");
  });
});


describe("migration-aware Tailscale failure finalization (R1/R2)", () => {
  /**
   * A stateful managed-lifecycle harness: an owned route for
   * `http://127.0.0.1:5050`, a prior service record/plist for port 5050, and a
   * runner whose `serve status --json` reflects the modeled live route — except
   * for the first post-claim verification read, which can be forced to report a
   * foreign handler or nothing at all.
   */
  async function migrationHarness(options: {
    readonly verificationReports: "route" | "foreign" | "none";
    readonly ownershipWriteFailures: number;
    readonly rollbackOffFails: boolean;
  }) {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await mkdir(paths.launchd.launchAgentsDir, { recursive: true, mode: 0o700 });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: scriptedClaimRunner() });
    const priorOwnership = await readFile(paths.tailscalePath, "utf8");
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
    let verificationReadsRemaining = 0;
    let claimArmed = false;
    let rollbackOffFailuresArmed = false;
    let ownershipWriteFailuresRemaining = options.ownershipWriteFailures;
    const calls: string[][] = [];
    const routeStatus = (target: string | undefined): Record<string, unknown> => target === undefined
      ? { TCP: {}, Web: {} }
      : {
          TCP: { "443": { HTTPS: true } },
          Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: target } } } },
        };
    const launchctl = async (args: readonly string[]) => {
      calls.push([...args]);
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
      calls.push([...args]);
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        currentTarget = args[3];
        // Only the verification read that follows the replacement claim is
        // overridden; a later restore command must be verified honestly.
        if (!claimArmed) {
          claimArmed = true;
          verificationReadsRemaining = 1;
          rollbackOffFailuresArmed = true;
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        // The migration's own removal must succeed; only a post-claim rollback
        // attempt can be forced to fail.
        if (options.rollbackOffFails && rollbackOffFailuresArmed) {
          return { code: 1, stdout: "", stderr: "off failed" };
        }
        currentTarget = undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "status") {
        if (verificationReadsRemaining > 0) {
          verificationReadsRemaining -= 1;
          if (options.verificationReports === "none") {
            return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {}, Web: {} }) };
          }
          if (options.verificationReports === "foreign") {
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                TCP: { "443": { HTTPS: true } },
                Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
              }),
            };
          }
        }
        return { code: 0, stderr: "", stdout: JSON.stringify(routeStatus(currentTarget)) };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const captured = { stdout: "", stderr: "" };
    const deps = {
      platform: "darwin" as NodeJS.Platform,
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
      stdout: { write: (text: string) => { captured.stdout += text; } },
      stderr: { write: (text: string) => { captured.stderr += text; } },
      writePrivateFile: async (path: string, contents: string) => {
        if (path.endsWith("tailscale-serve.json") && ownershipWriteFailuresRemaining > 0) {
          ownershipWriteFailuresRemaining -= 1;
          throw new Error("disk full");
        }
        await writeFile(path, contents, { mode: 0o600 });
      },
    };
    return {
      paths,
      calls,
      captured,
      deps,
      priorOwnership,
      oldPlist,
      oldRecord,
      state: () => ({ loaded, currentTarget }),
    };
  }

  const bgTargets = (calls: readonly (readonly string[])[]): string[] =>
    calls.filter((args) => args[0] === "serve" && args[1] === "--bg").map((args) => args[3] ?? "");

  for (const shareTailnet of [false, true]) {
    const flag = shareTailnet ? " with --share-tailnet" : " without --share-tailnet";

    it(`rolls the worker back and restores the prior route when a 5050->5051 migration fails verification${flag}`, async () => {
      const harness = await migrationHarness({ verificationReports: "none", ownershipWriteFailures: 0, rollbackOffFails: false });

      const code = await runWebCommand(
        { positionals: ["restart"], env: {}, port: 5051, ...(shareTailnet ? { shareTailnet: true } : {}) },
        harness.deps,
      );

      // Final-state invariants: the replacement worker must not survive, and the
      // prior exact route plus its ownership record must be live again.
      expect(code).toBe(1);
      expect(harness.state().loaded).toBe(true);
      expect(harness.state().currentTarget).toBe("http://127.0.0.1:5050");
      expect(await readFile(harness.paths.recordPath, "utf8")).toBe(harness.oldRecord);
      expect(await readFile(harness.paths.launchd.plistPath, "utf8")).toBe(harness.oldPlist);
      expect(await readFile(harness.paths.tailscalePath, "utf8")).toBe(harness.priorOwnership);
      expect(bgTargets(harness.calls)).toEqual(["http://127.0.0.1:5051", "http://127.0.0.1:5050"]);
      expect(harness.captured.stderr).toContain("migration failed");
      expect(harness.captured.stderr).toContain("prior owned route was restored");
    });

    it(`rolls the worker back and reports an unrestorable prior route when the replacement may remain${flag}`, async () => {
      const harness = await migrationHarness({ verificationReports: "none", ownershipWriteFailures: 0, rollbackOffFails: true });

      const code = await runWebCommand(
        { positionals: ["restart"], env: {}, port: 5051, ...(shareTailnet ? { shareTailnet: true } : {}) },
        harness.deps,
      );

      expect(code).toBe(1);
      expect(harness.state().loaded).toBe(true);
      expect(harness.state().currentTarget).toBe("http://127.0.0.1:5051");
      expect(await readFile(harness.paths.recordPath, "utf8")).toBe(harness.oldRecord);
      expect(await readFile(harness.paths.launchd.plistPath, "utf8")).toBe(harness.oldPlist);
      expect(harness.captured.stderr).toContain("migration failed");
      expect(harness.captured.stderr).toContain("could not be confirmed restored");
      // The replacement could not be provably removed, so the prior route must
      // not be republished over it and the unknown handler must stay untouched.
      expect(bgTargets(harness.calls)).toEqual(["http://127.0.0.1:5051"]);
      // One off for the migration, one failed rollback attempt that left the
      // replacement handler in place.
      expect(harness.calls.filter((args) => args.join(" ") === "serve --https=443 off")).toHaveLength(2);
    });

    it(`rolls the worker back and restores the prior route when ownership cannot be recorded after migration${flag}`, async () => {
      const harness = await migrationHarness({ verificationReports: "route", ownershipWriteFailures: 1, rollbackOffFails: false });

      const code = await runWebCommand(
        { positionals: ["restart"], env: {}, port: 5051, ...(shareTailnet ? { shareTailnet: true } : {}) },
        harness.deps,
      );

      expect(code).toBe(1);
      expect(harness.state().loaded).toBe(true);
      expect(harness.state().currentTarget).toBe("http://127.0.0.1:5050");
      expect(await readFile(harness.paths.recordPath, "utf8")).toBe(harness.oldRecord);
      expect(await readFile(harness.paths.launchd.plistPath, "utf8")).toBe(harness.oldPlist);
      expect(await readFile(harness.paths.tailscalePath, "utf8")).toBe(harness.priorOwnership);
      expect(harness.captured.stderr).toContain("migration failed");
      expect(harness.captured.stderr).toContain("prior owned route was restored");
    });
  }

  it("does not restore a prior route while a Web-only handler occupies its port", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: scriptedClaimRunner() });
    const priorOwnership = await readFile(paths.tailscalePath, "utf8");
    const calls: string[][] = [];
    let reads = 0;
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      if (args[0] === "serve" && args[1] === "status") {
        reads += 1;
        if (reads <= 2) {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
            }),
          };
        }
        if (reads <= 4) return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {}, Web: {} }) };
        // A Web-only handler (no TCP entry) occupies the prior HTTPS port.
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: {},
            Web: { "other.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        // The 5051 claim fails after the prior route was already migrated away.
        return { code: 1, stdout: "", stderr: "claim failed" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5051, {}, { homeDir: home, tailscale: runner });

    expect(result).toMatchObject({ kind: "unavailable", routeOutcome: "uncertain", priorRouteRestored: false });
    expect(calls.some((args) => args.join(" ") === "serve --bg --https=443 http://127.0.0.1:5050")).toBe(false);
    // The refused restore must not republish an ownership record either.
    await expect(stat(paths.tailscalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(priorOwnership).toContain("http://127.0.0.1:5050");
  });

  it("reports both facts when the prior route is restored but the replacement may remain on another port", async () => {
    const home = await testHome();
    const paths = webPaths(home);
    await prepareState({ stateDir: paths.stateDir });
    await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: home, tailscale: scriptedClaimRunner() });
    const exact = (port: number, target: string): string => JSON.stringify({
      TCP: { [String(port)]: { HTTPS: true } },
      Web: { [`host.example.ts.net:${String(port)}`]: { Handlers: { "/": { Proxy: target } } } },
    });
    const empty = JSON.stringify({ TCP: {}, Web: {} });
    const calls: string[][] = [];
    let reads = 0;
    let ownershipWrites = 0;
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      if (args[0] === "serve" && args[1] === "status") {
        reads += 1;
        if (reads <= 2) return { code: 0, stderr: "", stdout: exact(443, "http://127.0.0.1:5050") };
        if (reads === 3) return { code: 0, stderr: "", stdout: empty };
        if (reads === 4) {
          // Another handler holds 443, so the replacement claims 8443.
          return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: {} }) };
        }
        // Reads 5-6: claim verification and the rollback's post-off check, where
        // the replacement handler survived the zero-exit off command.
        if (reads <= 6) return { code: 0, stderr: "", stdout: exact(8443, "http://127.0.0.1:5051") };
        // Read 7: the prior port is free again, so the restore may proceed.
        if (reads === 7) return { code: 0, stderr: "", stdout: empty };
        return { code: 0, stderr: "", stdout: exact(443, "http://127.0.0.1:5050") };
      }
      if (args[0] === "serve" && args[1] === "--https=8443" && args[2] === "off") {
        // A zero exit that does not remove the surviving replacement handler.
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5051, {}, {
      homeDir: home,
      tailscale: runner,
      writePrivateFile: async (path: string, contents: string) => {
        if (path.endsWith("tailscale-serve.json") && ownershipWrites++ === 0) throw new Error("disk full");
        await writeFile(path, contents, { mode: 0o600 });
      },
    });

    expect(result).toMatchObject({
      kind: "unavailable",
      routeOutcome: "uncertain",
      priorRouteRestored: true,
      replacementHandlerRemoved: false,
    });
    const bgCalls = calls.filter((args) => args[0] === "serve" && args[1] === "--bg");
    expect(bgCalls).toEqual([
      ["serve", "--bg", "--https=8443", "http://127.0.0.1:5051"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:5050"],
    ]);
    expect(await readFile(paths.tailscalePath, "utf8")).toContain("http://127.0.0.1:5050");
  });

  /** Scripted post-claim verification failure with a configurable rollback outcome. */
  async function rollbackOutcome(options: {
    readonly afterOff: "absent" | "present" | "changed" | "error" | "malformed" | "differentWebKey";
    readonly offExit: number;
  }) {
    const home = await testHome();
    const paths = webPaths(home);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    let readIndex = 0;
    const calls: string[][] = [];
    const runner: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }) };
      }
      if (args[0] === "serve" && args[1] === "status") {
        readIndex += 1;
        if (readIndex === 1) return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {} }) };
        if (readIndex === 2) {
          // Verification reports a different handler: the claim did not take effect.
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
            }),
          };
        }
        // Every post-off case must reach the real off command: the pre-off read
        // still shows the exact created handler, so the rollback issues the off
        // and only then reads the inventory under test.
        if (readIndex === 3
          && (options.afterOff === "differentWebKey" || options.afterOff === "absent"
            || options.afterOff === "malformed" || options.afterOff === "error")) {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
            }),
          };
        }
        if (options.afterOff === "error") return { code: 1, stderr: "LocalAPI unavailable", stdout: "" };
        if (options.afterOff === "malformed") {
          return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: "not-an-object", Web: {} }) };
        }
        if (options.afterOff === "differentWebKey") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TCP: {},
              Web: { "other.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
            }),
          };
        }
        if (options.afterOff === "changed") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
            }),
          };
        }
        if (options.afterOff === "absent") return { code: 0, stderr: "", stdout: JSON.stringify({ TCP: {}, Web: {} }) };
        // Index 3 (rollback pre-check) always shows the exact created handler, so
        // the off command is really issued; later reads use `afterOff`.
        if (readIndex === 3) {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              TCP: { "443": { HTTPS: true } },
              Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
            }),
          };
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } } },
          }),
        };
      }
      if (args[0] === "serve" && args[1] === "--bg") return { code: 0, stderr: "", stdout: "" };
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        return { code: options.offExit, stderr: options.offExit === 0 ? "" : "off failed", stdout: "" };
      }
      return { code: 1, stderr: "unexpected", stdout: "" };
    };
    return { home, paths, calls, runner };
  }

  it("treats a surviving handler after a successful off command as uncertain", async () => {
    const { paths, calls, runner } = await rollbackOutcome({ afterOff: "present", offExit: 0 });
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: paths.stateDir, tailscale: runner });
    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" ? result.routeOutcome : undefined).toBe("uncertain");
    expect(calls.filter((args) => args.join(" ") === "serve --https=443 off")).toHaveLength(1);
  });

  /** The rollback must issue exactly one off and re-read status afterwards. */
  const expectRealOffThenStatusRead = (calls: readonly (readonly string[])[]): void => {
    const offCalls = calls.filter((args) => args.join(" ") === "serve --https=443 off");
    expect(offCalls).toHaveLength(1);
    const offIndex = calls.findIndex((args) => args.join(" ") === "serve --https=443 off");
    expect(calls.some((args, index) => index > offIndex && args[0] === "serve" && args[1] === "status")).toBe(true);
  };

  it.each([
    { afterOff: "absent", offExit: 0, expected: "rolled-back" },
    { afterOff: "differentWebKey", offExit: 0, expected: "uncertain" },
    { afterOff: "malformed", offExit: 0, expected: "uncertain" },
  ] as const)(
    "finalizes a post-off $afterOff inventory as $expected after a real off",
    async ({ afterOff, offExit, expected }) => {
      const { paths, calls, runner } = await rollbackOutcome({ afterOff, offExit });
      const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: paths.stateDir, tailscale: runner });
      expect(result.kind === "unavailable" ? result.routeOutcome : undefined).toBe(expected);
      expectRealOffThenStatusRead(calls);
    },
  );

  it("treats an unverifiable status read after a real off as uncertain", async () => {
    const { paths, calls, runner } = await rollbackOutcome({ afterOff: "error", offExit: 0 });
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: paths.stateDir, tailscale: runner });
    expect(result.kind === "unavailable" ? result.routeOutcome : undefined).toBe("uncertain");
    expectRealOffThenStatusRead(calls);
  });

  it("keeps an unmatched handler untouched and reports uncertainty", async () => {
    const { paths, calls, runner } = await rollbackOutcome({ afterOff: "changed", offExit: 0 });
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: paths.stateDir, tailscale: runner });
    expect(result.kind === "unavailable" ? result.routeOutcome : undefined).toBe("uncertain");
    // Nothing beyond the exact-off attempt may target the unknown handler.
    expect(calls.filter((args) => args.some((token) => token.endsWith("off")))).toHaveLength(0);
  });

  it("treats a failed off command as uncertain", async () => {
    const { paths, runner } = await rollbackOutcome({ afterOff: "present", offExit: 1 });
    const result = await ensureTailscaleServe(paths, DEFAULT_WEB_HOST, 5050, {}, { homeDir: paths.stateDir, tailscale: runner });
    expect(result.kind === "unavailable" ? result.routeOutcome : undefined).toBe("uncertain");
  });
});

function scriptedClaimRunner(): CommandRunner {
  let reads = 0;
  let removed = false;
  return async (args) => {
    if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
      removed = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "serve" && args[1] === "status") {
      reads += 1;
      const absent = removed || reads === 1;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(absent
          ? { TCP: {}, Web: {} }
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

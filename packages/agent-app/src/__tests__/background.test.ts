import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RecordedRunListItem, TraceSourceListItem } from "@mono-agent/observability";

import {
  canonicalBackgroundConfigPath,
  acquireFilesystemLifecycleLock,
  ensureBackgroundReady,
  defaultBackgroundDeps,
  forceRestartBackground,
  LAUNCHD_LOG_MAX_BYTES,
  resolveInstanceTarget,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "../background.js";
import type { BackgroundDeps, InstanceTarget } from "../background.js";
import type { BackgroundSnapshot } from "../background-snapshot.js";
import type { LaunchctlRunner } from "../launchd.js";
import type { ProcessIncarnation } from "../process-incarnation.js";

const POLL = { timeoutMs: 5_000, intervalMs: 100 };
const CLOCK_START = 1_000_000;

function processIncarnation(id: string): ProcessIncarnation {
  return {
    schema: "mono-agent.process-incarnation.v1",
    bootSessionId: "boot-test",
    processStartId: id,
  };
}

function makeTarget(
  overrides: Omit<Partial<InstanceTarget>, "expectedSnapshot"> & {
    readonly expectedSnapshot?: BackgroundSnapshot | undefined;
  } = {},
): InstanceTarget {
  const label = "com.mono-agent.demo-0a1b2c3d";
  const { expectedSnapshot, ...targetOverrides } = overrides;
  const target: InstanceTarget = {
    cwd: "/work/demo",
    configPath: "/work/demo/mono-agent.config.json",
    label,
    registryDir: "/home/u/.mono-agent/trace-sources",
    staleAfterMs: 30_000,
    paths: {
      launchAgentsDir: "/home/u/Library/LaunchAgents",
      logDir: "/home/u/.mono-agent/logs",
      plistPath: `/home/u/Library/LaunchAgents/${label}.plist`,
      stdoutPath: `/home/u/.mono-agent/logs/${label}.out.log`,
      stderrPath: `/home/u/.mono-agent/logs/${label}.err.log`,
    },
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/app/dist/cli.js",
    configurationEnvironment: { PATH: "/usr/bin:/bin" },
    environment: { PATH: "/usr/bin:/bin", MONO_AGENT_MANAGED_WORKER: "1" },
    ...targetOverrides,
    ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
  };
  return Object.prototype.hasOwnProperty.call(overrides, "expectedSnapshot")
    ? target
    : { ...target, expectedSnapshot: makeSnapshot(target) };
}

function makeSource(target: InstanceTarget, overrides: Partial<TraceSourceListItem> = {}): TraceSourceListItem {
  const metadata = {
    reason: "startup-complete",
    channels: {
      telegram: { kind: "running" },
      slack: { kind: "waiting_for_config", reason: "Missing appToken" },
    },
    ...(overrides.metadata ?? {}),
    ...(target.expectedSnapshot === undefined || overrides.metadata?.backgroundSnapshot !== undefined
      ? {}
      : { backgroundSnapshot: target.expectedSnapshot }),
  };
  return {
    schema: "agent-runtime.trace-source.v1",
    sourceId: "mono-agent-abcdef012345",
    label: "Mono Agent",
    artifactDir: "/work/demo/.mono-agent/artifacts",
    pid: 4321,
    status: "running",
    startedAt: new Date(CLOCK_START).toISOString(),
    updatedAt: new Date(CLOCK_START).toISOString(),
    configPath: target.configPath,
    health: "running",
    warnings: [],
    ...overrides,
    metadata,
  } as TraceSourceListItem;
}

function makeSnapshot(target: InstanceTarget, suffix = "approved"): BackgroundSnapshot {
  return {
    schema: "mono-agent.background-snapshot.v1",
    configPath: target.configPath,
    configFingerprint: `config-fingerprint-${suffix}`,
    dotenvPath: target.envFile ?? resolve(target.cwd, ".env"),
    dotenvFingerprint: `dotenv-fingerprint-${suffix}`,
    identityPath: resolve(target.cwd, "IDENTITY.md"),
    identityFingerprint: `identity-fingerprint-${suffix}`,
    operationalEnvironmentFingerprint: `environment-fingerprint-${suffix}`,
  };
}

interface RunnerOptions {
  readonly loaded: boolean;
  readonly initialPid?: number;
  readonly bootstrapPid?: number;
  readonly bootstrapCode?: number;
  readonly loadsAfterBootstrap?: boolean;
  readonly kickstartCode?: number;
  readonly bootoutCode?: number;
  /** Simulate a bootout that fails and leaves the service still loaded. */
  readonly bootoutKeepsLoaded?: boolean;
}

type StatefulRunner = LaunchctlRunner & { readonly isAlive: (pid: number) => boolean };

function makeRunner(opts: RunnerOptions): { runner: StatefulRunner; calls: string[][] } {
  const calls: string[][] = [];
  const state: { loaded: boolean; pid?: number } = {
    loaded: opts.loaded,
    ...(opts.loaded ? { pid: opts.initialPid ?? 4321 } : {}),
  };
  const runner = (async (args: readonly string[]) => {
    calls.push([...args]);
    switch (args[0]) {
      case "print":
        return {
          code: state.loaded ? 0 : 113,
          stdout: state.loaded && state.pid !== undefined ? `pid = ${state.pid}\n` : "",
          stderr: "",
        };
      case "bootstrap": {
        const code = opts.bootstrapCode ?? 0;
        if (opts.loadsAfterBootstrap ?? code === 0) {
          state.loaded = true;
          state.pid = opts.bootstrapPid ?? 4321;
        }
        return { code, stdout: "", stderr: "bootstrap detail" };
      }
      case "kickstart":
        return { code: opts.kickstartCode ?? 0, stdout: "", stderr: "" };
      case "bootout":
        if (!opts.bootoutKeepsLoaded) {
          state.loaded = false;
          delete state.pid;
        }
        return { code: opts.bootoutCode ?? 0, stdout: "", stderr: "bootout detail" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  }) as StatefulRunner;
  Object.defineProperty(runner, "isAlive", { value: (pid: number) => state.loaded && state.pid === pid });
  return { runner, calls };
}

function listReturning(getSources: () => readonly TraceSourceListItem[]): BackgroundDeps["listTraceSources"] {
  return (async (options: { registryDir: string }) => ({
    registryDir: options.registryDir,
    sources: [...getSources()],
    warnings: [],
  })) as unknown as BackgroundDeps["listTraceSources"];
}

interface Harness {
  readonly deps: BackgroundDeps;
  readonly out: string[];
  readonly err: string[];
  readonly written: { path: string; data: string }[];
  readonly removed: string[];
  readonly renamed: { from: string; to: string }[];
  readonly mkdirs: string[];
  readonly tailCalls: string[][];
}

function makeHarness(opts: {
  runner: LaunchctlRunner;
  list: BackgroundDeps["listTraceSources"];
  listRecordedRuns?: BackgroundDeps["listRecordedRuns"];
  isAlive?: (pid: number) => boolean;
  fileSizes?: Record<string, number>;
  ensureManagedRuntime?: BackgroundDeps["ensureManagedRuntime"];
  resolveManagedRuntimePackages?: NonNullable<BackgroundDeps["resolveManagedRuntimePackages"]>;
  acquireLifecycleLock?: BackgroundDeps["acquireLifecycleLock"];
  probeTui?: BackgroundDeps["probeTui"];
  captureSnapshot?: NonNullable<BackgroundDeps["captureSnapshot"]>;
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const written: { path: string; data: string }[] = [];
  const removed: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const mkdirs: string[] = [];
  const tailCalls: string[][] = [];
  const fileSizes = new Map(Object.entries(opts.fileSizes ?? {}));
  const isAlive = opts.isAlive ?? ("isAlive" in opts.runner
    ? (opts.runner as StatefulRunner).isAlive
    : () => false);
  let clock = CLOCK_START;
  const deps: BackgroundDeps = {
    runner: opts.runner,
    getuid: () => 501,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    listRecordedRuns: opts.listRecordedRuns ?? (async () => ({ totalRuns: 0, runs: [], warnings: [] })),
    listTraceSources: opts.list,
    writeFile: async (path, data) => {
      written.push({ path, data });
    },
    mkdir: async (path) => {
      mkdirs.push(path);
    },
    rm: async (path) => {
      removed.push(path);
      fileSizes.delete(path);
    },
    stat: async (path) => {
      const size = fileSizes.get(path);
      if (size === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { size };
    },
    rename: async (from, to) => {
      const size = fileSizes.get(from);
      if (size === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      renamed.push({ from, to });
      fileSizes.delete(from);
      fileSizes.set(to, size);
    },
    isAlive,
    ensureManagedRuntime: opts.ensureManagedRuntime ?? (async (input) => ({
      cliPath: "/home/u/.mono-agent/runtimes/agent-app/verified/dist/cli.js",
      nodePath: input.nodePath,
      installRoot: "/home/u/.mono-agent/runtimes/agent-app/verified",
      packageVersion: "0.8.0",
      cliSha256: "a".repeat(64),
      nodeAbi: "137",
    })),
    ...(opts.resolveManagedRuntimePackages === undefined
      ? {}
      : { resolveManagedRuntimePackages: opts.resolveManagedRuntimePackages }),
    acquireLifecycleLock: opts.acquireLifecycleLock ?? (async () => async () => undefined),
    probeTui: opts.probeTui ?? (async () => true),
    captureSnapshot: opts.captureSnapshot ?? (async (target) => target.expectedSnapshot ?? makeSnapshot(target)),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    spawnTail: async (args) => {
      tailCalls.push([...args]);
      return 0;
    },
  };
  return { deps, out, err, written, removed, renamed, mkdirs, tailCalls };
}

describe("background config identity", () => {
  it("uses the effective config environment for env-only managed plugin discovery without putting it in launchd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-background-env-plugin-"));
    try {
      const configPath = join(cwd, "mono-agent.config.json");
      await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n\nEnvironment plugin test.\n");
      await writeFile(configPath, `${JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
        context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
        tools: { allowedTools: [], disallowedTools: [] },
      }, null, 2)}\n`);
      const secret = "must-never-enter-the-plist";
      const target = await resolveInstanceTarget({
        args: { configPath },
        cwd,
        cliPath: "/opt/app/dist/cli.js",
        env: {
          PATH: "/usr/bin:/bin",
          MONO_AGENT_MEMORY_BACKEND: "supermemory",
          MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:8787",
          MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: secret,
        },
      });

      expect(target.configurationEnvironment.MONO_AGENT_MEMORY_BACKEND).toBe("supermemory");
      expect(target.environment.MONO_AGENT_MEMORY_BACKEND).toBeUndefined();
      expect(Object.values(target.environment)).not.toContain(secret);
      const packages = await defaultBackgroundDeps().resolveManagedRuntimePackages?.(target);
      expect(packages?.map((entry) => entry.packageName)).toContain("@mono-agent/memory-supermemory");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("canonicalizes symlinked parent aliases without following the final config name", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-config-identity-"));
    try {
      const agent = join(home, "agent");
      const alias = join(home, "agent-alias");
      await mkdir(agent, { mode: 0o700 });
      await writeFile(join(agent, "mono-agent.config.json"), "{}\n", "utf8");
      await symlink(agent, alias, "dir");

      await expect(canonicalBackgroundConfigPath(alias))
        .resolves.toBe(join(await realpath(agent), "mono-agent.config.json"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("persists a canonical working directory for a symlinked agent folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-working-directory-"));
    try {
      const agent = join(home, "agent");
      const alias = join(home, "agent-alias");
      await mkdir(agent, { mode: 0o700 });
      await writeFile(join(agent, "mono-agent.config.json"), "{}\n", "utf8");
      await symlink(agent, alias, "dir");

      const target = await resolveInstanceTarget({
        args: {},
        cwd: alias,
        cliPath: "/opt/app/dist/cli.js",
        env: { PATH: "/usr/bin:/bin" },
      });

      expect(target.cwd).toBe(await realpath(agent));
      expect(target.configPath).toBe(await realpath(join(agent, "mono-agent.config.json")));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("uses the stored final-component casing on case-insensitive filesystems", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-config-case-"));
    try {
      const stored = join(home, "MiXeD.Config.JSON");
      const alternate = join(home, "mixed.config.json");
      await writeFile(stored, "{}\n", "utf8");
      let alternateDetails;
      try {
        alternateDetails = await lstat(alternate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const storedDetails = await lstat(stored);
      if (alternateDetails.dev !== storedDetails.dev || alternateDetails.ino !== storedDetails.ino) return;

      await expect(canonicalBackgroundConfigPath(home, "mixed.config.json"))
        .resolves.toBe(await realpath(stored));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("startBackground", () => {
  it("refuses a managed launch without an approved snapshot before any mutation", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget({ expectedSnapshot: undefined });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "snapshot" });
    expect(harness.written).toEqual([]);
    expect(calls).toEqual([]);
    expect(harness.err.join("")).toContain("without an approved background snapshot");
  });

  it("returns the fresh authoritative trace source from the structured readiness boundary", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const target = makeTarget();
    const source = makeSource(target, { sourceId: "mono-agent-ready-source", pid: 9876 });
    const harness = makeHarness({ runner, list: listReturning(() => [source]) });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: true, action: "started", source });
  });

  it("requires the live worker metadata and current files to match the exact approved snapshot", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const base = makeTarget();
    const approved = makeSnapshot(base);
    const target = makeTarget({ expectedSnapshot: approved });
    const source = makeSource(target, {
      sourceId: "mono-agent-snapshot-source",
      pid: 9876,
      metadata: {
        reason: "startup-complete",
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/tui" } },
        backgroundSnapshot: approved,
      },
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [source]),
      captureSnapshot: async () => approved,
    });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: true, action: "started", source });
  });

  it("fails before runtime installation or plist creation when the approved snapshot drifted", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const base = makeTarget();
    const approved = makeSnapshot(base);
    const target = makeTarget({ expectedSnapshot: approved });
    let installs = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      captureSnapshot: async () => makeSnapshot(target, "changed"),
      ensureManagedRuntime: async (input) => {
        installs += 1;
        return {
          cliPath: input.currentCliPath,
          nodePath: input.nodePath,
          installRoot: "/unused",
          packageVersion: "0.8.0",
          cliSha256: "a".repeat(64),
          nodeAbi: "137",
        };
      },
    });

    await expect(ensureBackgroundReady(target, harness.deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "snapshot" });
    expect(installs).toBe(0);
    expect(harness.written).toEqual([]);
    expect(calls).toEqual([]);
    expect(harness.err.join(""))
      .toContain("No readiness claim was made for a different snapshot");
  });

  it("unloads a worker when inputs drift after plist commit but before readiness", async () => {
    const { runner, calls } = makeRunner({ loaded: false, bootstrapPid: 9876 });
    const target = makeTarget();
    const approved = target.expectedSnapshot!;
    let captures = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      captureSnapshot: async () => {
        captures += 1;
        return captures <= 2 ? approved : makeSnapshot(target, "post-plist-drift");
      },
    });

    await expect(ensureBackgroundReady(target, harness.deps, { timeoutMs: 300, intervalMs: 100 }))
      .resolves.toEqual({ ok: false, action: "start", reason: "snapshot" });

    expect(calls.map((call) => call[0])).toEqual(expect.arrayContaining(["bootstrap", "bootout"]));
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain("drifted LaunchAgent was stopped");
    expect(harness.written[0]?.data).toContain("--expected-background-snapshot");
  });

  it("bootstraps a fresh instance, writes the plist, and prints its info", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]) });

    const code = await startBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const verbs = calls.map((call) => call[0]);
    expect(verbs).toContain("bootstrap");
    expect(verbs).not.toContain("kickstart");
    expect(harness.mkdirs).toContain(target.paths.logDir);
    expect(harness.mkdirs).toContain(target.paths.launchAgentsDir);
    expect(harness.written[0]?.path).toBe(target.paths.plistPath);
    expect(harness.written[0]?.data).toContain(target.label);
    expect(harness.written[0]?.data).toContain("/home/u/.mono-agent/runtimes/agent-app/verified/dist/cli.js");
    expect(harness.written[0]?.data).not.toContain(target.cliPath);
    const stdout = harness.out.join("");
    expect(stdout).toContain("started in the background");
    expect(stdout).toContain("4321");
    expect(stdout).toContain(target.label);
  });

  it("binds config-selected plugin packages into the managed runtime request", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const additionalPackages = [{
      packageName: "@mono-agent/a2a-adapter",
      packageSource: "/resolved/a2a-adapter",
    }] as const;
    let runtimeInput: Parameters<BackgroundDeps["ensureManagedRuntime"]>[0] | undefined;
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target)]),
      resolveManagedRuntimePackages: async (resolvedTarget) => {
        expect(resolvedTarget).toBe(target);
        return additionalPackages;
      },
      ensureManagedRuntime: async (input) => {
        runtimeInput = input;
        return {
          cliPath: "/managed/agent-app/dist/cli.js",
          nodePath: input.nodePath,
          installRoot: "/managed",
          packageVersion: "0.8.0",
          cliSha256: "a".repeat(64),
          nodeAbi: "137",
        };
      },
    });

    await expect(ensureBackgroundReady(target, harness.deps, POLL)).resolves.toMatchObject({ ok: true });
    expect(runtimeInput?.additionalPackages).toEqual(additionalPackages);
  });

  it("rotates oversized launchd stdout and stderr logs before bootstrap", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target)]),
      fileSizes: {
        [target.paths.stdoutPath]: LAUNCHD_LOG_MAX_BYTES + 1,
        [target.paths.stderrPath]: LAUNCHD_LOG_MAX_BYTES + 1,
      },
    });

    const code = await startBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    expect(harness.removed).toEqual(expect.arrayContaining([
      `${target.paths.stdoutPath}.3`,
      `${target.paths.stderrPath}.3`,
    ]));
    expect(harness.renamed).toEqual(expect.arrayContaining([
      { from: target.paths.stdoutPath, to: `${target.paths.stdoutPath}.1` },
      { from: target.paths.stderrPath, to: `${target.paths.stderrPath}.1` },
    ]));
    expect(calls.map((call) => call[0])).toContain("bootstrap");
  });

  it("tolerates a bootstrap that reports already-loaded", async () => {
    const { runner, calls } = makeRunner({ loaded: false, bootstrapCode: 37, loadsAfterBootstrap: true });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]) });

    const code = await startBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    expect(calls.map((call) => call[0])).toContain("bootstrap");
  });

  it("returns non-zero and points at the logs when the worker never reports ready", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const code = await startBackground(target, harness.deps, { timeoutMs: 1_000, intervalMs: 200 });

    expect(code).toBe(1);
    const stderr = harness.err.join("");
    expect(stderr).toContain("did not report ready");
    expect(stderr).toContain(target.paths.stderrPath);
    expect(stderr).toContain("mono-agent start");
    expect(stderr).toContain("mono-agent status");
    expect(stderr).toContain("mono-agent logs --follow");
  });

  it("returns a structured launchctl failure and prints exact recovery commands", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapCode: 5, loadsAfterBootstrap: false });
    const target = makeTarget({
      configPath: "/work/My Agent/custom.json",
      envFile: "/work/My Agent/.env.agent",
    });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "launchctl" });
    const stderr = harness.err.join("");
    const flags = "--config '/work/My Agent/custom.json' --env-file '/work/My Agent/.env.agent'";
    expect(stderr).toContain(`mono-agent start ${flags}`);
    expect(stderr).toContain(`mono-agent status ${flags}`);
    expect(stderr).toContain(`mono-agent logs ${flags} --follow`);
  });

  it("converts plist preparation exceptions into a preserved-files recovery result", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });
    const deps: BackgroundDeps = {
      ...harness.deps,
      writeFile: async () => {
        throw new Error("plist destination is unavailable");
      },
    };

    const result = await ensureBackgroundReady(target, deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "preparation" });
    const stderr = harness.err.join("");
    expect(stderr).toContain("Failed to prepare the LaunchAgent");
    expect(stderr).toContain("plist destination is unavailable");
    expect(stderr).toContain("committed agent files were preserved");
    expect(stderr).toContain("mono-agent start");
  });

  it("validates launchd log destinations before committing the plist", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });
    const deps: BackgroundDeps = {
      ...harness.deps,
      stat: async () => {
        throw new Error("LaunchAgent log must be a regular non-symbolic-link file");
      },
    };

    await expect(ensureBackgroundReady(target, deps, POLL))
      .resolves.toEqual({ ok: false, action: "start", reason: "preparation" });
    expect(harness.written).toEqual([]);
    expect(harness.err.join("")).toContain("non-symbolic-link");
  });

  it("converts readiness registry exceptions into a preserved-files recovery result", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    let calls = 0;
    const list = (async () => {
      calls += 1;
      if (calls === 1) return { registryDir: target.registryDir, sources: [], warnings: [] };
      throw new Error("trace registry is unreadable");
    }) as BackgroundDeps["listTraceSources"];
    const harness = makeHarness({ runner, list });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "readiness" });
    const stderr = harness.err.join("");
    expect(stderr).toContain("Failed to read the worker readiness trace");
    expect(stderr).toContain("trace registry is unreadable");
    expect(stderr).toContain("committed agent files were preserved");
    expect(stderr).toContain("mono-agent status");
  });

  it("fails before writing a plist when the durable runtime cannot be verified", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      ensureManagedRuntime: async () => { throw new Error("exact CLI SHA mismatch"); },
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "runtime" });
    expect(harness.written).toEqual([]);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join("")).toContain("exact CLI SHA mismatch");
  });

  it("fails closed when a live matching manifest is not owned by launchd", async () => {
    const { runner, calls } = makeRunner({ loaded: false });
    const target = makeTarget();
    const orphan = makeSource(target, { pid: 8765 });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [orphan]),
      isAlive: (pid) => pid === 8765,
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "ownership" });
    expect(harness.written).toEqual([]);
    expect(calls.map((call) => call[0])).not.toContain("bootstrap");
    expect(harness.err.join("")).toContain("Refusing to launch a second worker");
  });

  it("requires trace pid ownership by the live launchd service", async () => {
    const { runner } = makeRunner({ loaded: false, bootstrapPid: 4321 });
    const target = makeTarget();
    const source = makeSource(target, { pid: 9876 });
    let lists = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => (lists += 1) === 1 ? [] : [source]),
      isAlive: (pid) => pid === 4321 || pid === 9876,
    });

    const code = await startBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 });

    expect(code).toBe(1);
    expect(harness.err.join("")).toContain("did not report ready");
  });

  it("requires a reachable TUI endpoint for guided/configuration handoffs", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget({ requireTui: true });
    const source = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/tui" } },
      },
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => [source]),
      probeTui: async () => false,
    });

    const code = await startBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 });

    expect(code).toBe(1);
    expect(harness.err.join("")).toContain("did not report ready");
  });

  it("rejects startup-complete metadata when a configured channel failed", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const source = makeSource(target, {
      metadata: { reason: "startup-complete", channels: { telegram: { kind: "failed", reason: "bind failed" } } },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [source]) });

    expect(await startBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
  });

  it("rejects a concurrent lifecycle command before runtime or plist mutation", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    let runtimeCalls = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => []),
      acquireLifecycleLock: async () => undefined,
      ensureManagedRuntime: async () => {
        runtimeCalls += 1;
        throw new Error("must not run");
      },
    });

    const result = await ensureBackgroundReady(target, harness.deps, POLL);

    expect(result).toEqual({ ok: false, action: "start", reason: "ownership" });
    expect(runtimeCalls).toBe(0);
    expect(harness.written).toEqual([]);
  });
});

describe("filesystem lifecycle lock", () => {
  it("does not steal a fresh ownerless lock during the mkdir-to-owner write window", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-lifecycle-lock-"));
    const target = makeTarget({
      paths: {
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        logDir: join(home, ".mono-agent", "logs"),
        plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
        stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
        stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
      },
    });
    const lockDir = join(home, ".mono-agent", "locks", `${target.label}.lock`);
    try {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });

      const acquired = await defaultBackgroundDeps().acquireLifecycleLock(target);

      expect(acquired).toBeUndefined();
      expect((await lstat(lockDir)).isDirectory()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not remove a live contender swapped in at the stale-lock rename boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-lifecycle-lock-race-"));
    const target = makeTarget({
      paths: {
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        logDir: join(home, ".mono-agent", "logs"),
        plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
        stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
        stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
      },
    });
    const lockDir = join(home, ".mono-agent", "locks", `${target.label}.lock`);
    const displaced = join(home, ".mono-agent", "locks", "old-dead-lock");
    try {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(join(lockDir, "owner.json"), JSON.stringify({
        pid: 1111,
        token: "dead",
        incarnation: processIncarnation("dead-owner"),
      }), "utf8");

      const acquired = await acquireFilesystemLifecycleLock(target, {
        pid: 3333,
        processIncarnation: processIncarnation("acquirer"),
        isSameProcessIncarnation: async (pid) => pid === 2222,
        randomToken: () => "race-token",
        beforeStaleLockRename: async () => {
          await rename(lockDir, displaced);
          await mkdir(lockDir, { mode: 0o700 });
          await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 2222, token: "live" }), "utf8");
        },
      });

      expect(acquired).toBeUndefined();
      expect(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"))).toMatchObject({
        pid: 2222,
        token: "live",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("recovers a stale lifecycle lock when an unrelated process reused the owner pid", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-lifecycle-lock-incarnation-"));
    const target = makeTarget({
      paths: {
        launchAgentsDir: join(home, "Library", "LaunchAgents"),
        logDir: join(home, ".mono-agent", "logs"),
        plistPath: join(home, "Library", "LaunchAgents", "agent.plist"),
        stdoutPath: join(home, ".mono-agent", "logs", "agent.out.log"),
        stderrPath: join(home, ".mono-agent", "logs", "agent.err.log"),
      },
    });
    try {
      const original = await acquireFilesystemLifecycleLock(target, {
        pid: 1111,
        processIncarnation: processIncarnation("original-owner"),
        randomToken: () => "original-token",
      });
      expect(original).toBeTypeOf("function");

      const replacement = await acquireFilesystemLifecycleLock(target, {
        pid: 2222,
        processIncarnation: processIncarnation("replacement-owner"),
        // PID-only liveness says the old number exists, but the OS birth
        // identity proves that process is not the lock creator.
        isProcessAlive: (pid) => pid === 1111,
        isSameProcessIncarnation: async () => false,
        randomToken: () => "replacement-token",
      });

      expect(replacement).toBeTypeOf("function");
      await replacement?.();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("LaunchAgent private filesystem boundary", () => {
  it.skipIf(process.platform === "win32")("rejects symlinked plist and log destinations without modifying their targets", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-launchd-paths-"));
    const outsidePlist = join(home, "outside.plist");
    const outsideLog = join(home, "outside.log");
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    const logDir = join(home, ".mono-agent", "logs");
    const plistPath = join(launchAgentsDir, "agent.plist");
    const logPath = join(logDir, "agent.out.log");
    try {
      await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      await writeFile(outsidePlist, "outside-plist\n", "utf8");
      await writeFile(outsideLog, "outside-log\n", "utf8");
      await symlink(outsidePlist, plistPath);
      await symlink(outsideLog, logPath);
      const deps = defaultBackgroundDeps();

      await expect(deps.writeFile(plistPath, "new-plist\n"))
        .rejects.toThrow("non-symbolic-link");
      await expect(deps.stat(logPath)).rejects.toMatchObject({ code: "ELOOP" });
      await expect(readFile(outsidePlist, "utf8")).resolves.toBe("outside-plist\n");
      await expect(readFile(outsideLog, "utf8")).resolves.toBe("outside-log\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("restartBackground", () => {
  it("keeps one lifecycle lock across stop, stopped-worker mutation, and start", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 4321, bootstrapPid: 4321 });
    const target = makeTarget();
    let lockAcquisitions = 0;
    let lockReleases = 0;
    let lockHeld = false;
    let mutationRan = false;
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target)]),
      acquireLifecycleLock: async () => {
        lockAcquisitions += 1;
        expect(lockHeld).toBe(false);
        lockHeld = true;
        return async () => {
          expect(lockHeld).toBe(true);
          lockHeld = false;
          lockReleases += 1;
        };
      },
    });

    const code = await forceRestartBackground(target, harness.deps, async () => {
      expect(lockHeld).toBe(true);
      mutationRan = true;
    }, POLL);

    expect(code).toBe(0);
    expect(mutationRan).toBe(true);
    expect(lockAcquisitions).toBe(1);
    expect(lockReleases).toBe(1);
    expect(lockHeld).toBe(false);
  });

  it("fully boots out and bootstraps an already-loaded service so the rewritten plist is loaded", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 4321 });
    const target = makeTarget();
    const oldSource = makeSource(target, { pid: 1111, startedAt: new Date(CLOCK_START - 1).toISOString() });
    const newSource = makeSource(target, { pid: 4321, startedAt: new Date(CLOCK_START + 1).toISOString() });
    const harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap") ? [newSource] : [oldSource]),
    });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const verbs = calls.map((call) => call[0]);
    expect(verbs).toContain("bootout");
    expect(verbs).toContain("bootstrap");
    expect(verbs).not.toContain("kickstart");
    expect(harness.out.join("")).toContain("restarted in the background");
  });

  it("waits for the new worker and ignores the previous instance's manifest", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    // Even a just-started previous process is not proof that this restart is ready.
    const oldSource = makeSource(target, { startedAt: new Date(CLOCK_START - 1).toISOString(), pid: 1111 });
    const newSource = makeSource(target, { startedAt: new Date(CLOCK_START + 50).toISOString(), pid: 2222 });
    let polls = 0;
    const harness = makeHarness({
      runner,
      list: listReturning(() => {
        polls += 1;
        return polls < 2 ? [oldSource] : [newSource];
      }),
    });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const stdout = harness.out.join("");
    expect(stdout).toContain("2222");
    expect(stdout).not.toContain("1111");
  });

  it("does not wait on a recycled pid from a cleanly stopped trace manifest", async () => {
    const { runner, calls } = makeRunner({ loaded: true, initialPid: 1111, bootstrapPid: 2222 });
    const target = makeTarget();
    const oldSource = makeSource(target, {
      pid: 1111,
      startedAt: new Date(CLOCK_START - 1).toISOString(),
    });
    const recycledStoppedSource = makeSource(target, {
      sourceId: "historical-stopped-source",
      pid: 9999,
      health: "stopped",
      status: "stopped",
      startedAt: new Date(CLOCK_START - 10_000).toISOString(),
    });
    const newSource = makeSource(target, {
      pid: 2222,
      startedAt: new Date(CLOCK_START + 1).toISOString(),
    });
    const harness = makeHarness({
      runner,
      list: listReturning(() => calls.some((call) => call[0] === "bootstrap")
        ? [newSource, recycledStoppedSource]
        : [oldSource, recycledStoppedSource]),
      // PID 9999 now belongs to unrelated live work. Restart must not treat a
      // historical stopped trace as ownership of that recycled process.
      isAlive: (pid) => pid === 9999 || runner.isAlive(pid),
    });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    expect(calls.map((call) => call[0])).toContain("bootstrap");
    expect(harness.err.join("")).not.toContain("9999");
  });
});

describe("stopBackground", () => {
  it("boots the service out and removes the plist", async () => {
    const { runner, calls } = makeRunner({ loaded: true });
    const target = makeTarget();
    const existing = makeSource(target, { pid: 4321 });
    const harness = makeHarness({ runner, list: listReturning(() => [existing]) });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(0);
    expect(calls.map((call) => call[0])).toContain("bootout");
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.removed).toContain(resolve(target.registryDir, `${existing.sourceId}.json`));
    expect(harness.out.join("")).toContain("Stopped");
  });

  it("tolerates a not-loaded bootout and unlinks a dead instance's manifest", async () => {
    const { runner } = makeRunner({ loaded: false, bootoutCode: 3 });
    const target = makeTarget();
    const existing = makeSource(target, { pid: 4321, health: "stale" });
    const harness = makeHarness({ runner, list: listReturning(() => [existing]), isAlive: () => false });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(0);
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.removed).toContain(resolve(target.registryDir, `${existing.sourceId}.json`));
    expect(harness.out.join("")).toContain("was not running");
  });

  it("reports failure when bootout errors and the service is still loaded", async () => {
    const { runner } = makeRunner({ loaded: true, bootoutCode: 1, bootoutKeepsLoaded: true });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]), isAlive: () => true });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(1);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain("Failed to prove");
    expect(harness.err.join("")).toContain("plist was preserved");
  });

  it("preserves the plist when launchd unloads but the recorded worker pid remains alive", async () => {
    const { runner } = makeRunner({ loaded: true, initialPid: 4321 });
    const target = makeTarget();
    const harness = makeHarness({
      runner,
      list: listReturning(() => [makeSource(target, { pid: 4321 })]),
      isAlive: () => true,
    });

    expect(await stopBackground(target, harness.deps, { timeoutMs: 300, intervalMs: 100 })).toBe(1);
    expect(harness.removed).not.toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain("Worker pid(s) 4321 are still alive");
  });
});

describe("statusBackground", () => {
  it("prints this config's instance plus a brief list of others", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, { pid: 4321 });
    const other = makeSource(target, {
      configPath: "/work/other/mono-agent.config.json",
      sourceId: "mono-agent-999999999999",
      pid: 9999,
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current, other]) });

    const code = await statusBackground(target, harness.deps);

    expect(code).toBe(0);
    const stdout = harness.out.join("");
    expect(stdout).toContain(target.label);
    expect(stdout).toContain("4321");
    expect(stdout).toContain("Other mono-agent instances");
    expect(stdout).toContain("/work/other/mono-agent.config.json");
  });

  it.skipIf(process.platform === "win32")("recognizes a legacy trace source recorded through a symlinked config alias", async () => {
    const home = await mkdtemp(join(tmpdir(), "mono-agent-status-alias-"));
    try {
      const agent = join(home, "agent");
      const alias = join(home, "agent-alias");
      await mkdir(agent, { mode: 0o700 });
      const canonicalConfig = join(agent, "mono-agent.config.json");
      await writeFile(canonicalConfig, "{}\n", "utf8");
      await symlink(agent, alias, "dir");

      const target = makeTarget({
        cwd: await realpath(agent),
        configPath: await realpath(canonicalConfig),
      });
      const legacy = makeSource(target, {
        configPath: join(alias, "mono-agent.config.json"),
      });
      const { runner } = makeRunner({ loaded: true });
      const harness = makeHarness({ runner, list: listReturning(() => [legacy]) });

      expect(await statusBackground(target, harness.deps)).toBe(0);
      const stdout = harness.out.join("");
      expect(stdout).toContain(target.label);
      expect(stdout).not.toContain("No running mono-agent instance");
      expect(stdout).not.toContain("Other mono-agent instances");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prints the observability exporter line with the local-artifacts note", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        observability: {
          endpoint: "http://127.0.0.1:6006/v1/traces",
          includeSensitiveData: false,
          jsonlArtifactsLocal: true,
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("observability");
    expect(stdout).toContain("http://127.0.0.1:6006/v1/traces");
    expect(stdout).toContain("JSONL artifacts remain local");
    expect(stdout).not.toContain("[WARN] includeSensitiveData=true");
  });

  it("prints a warning from persisted observability metadata when sensitive data export is enabled", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const endpoint = "http://127.0.0.1:6006/v1/traces";
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        observability: {
          endpoint,
          includeSensitiveData: true,
          jsonlArtifactsLocal: true,
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("[WARN] includeSensitiveData=true");
    expect(stdout).toContain(endpoint);
    expect(stdout).toContain("user input");
    expect(stdout).toContain("assistant replies");
    expect(stdout).toContain("tool args/results");
    expect(stdout).toContain("system prompt");
  });

  it("prints effective sandbox state from persisted metadata", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        sandbox: {
          configured: true,
          configuredMode: "native",
          effective: "unsafe-host-process",
          engine: "srt",
          engineAvailable: false,
          fallback: "unsafe-host-process",
          fallbackActive: true,
          unsafeAllowHostProcess: true,
          detail:
            "Sandbox unsafe-host-process fallback is active because engine \"srt\" is unavailable; all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
          warning:
            "WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("sandbox");
    expect(stdout).toContain("effective: unsafe-host-process");
    expect(stdout).toContain("engine: srt (absent)");
    expect(stdout).toContain("fallback active: yes");
    expect(stdout).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(stdout).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");
  });

  it("prints session status from persisted trace-source metadata", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "session-saved",
        session: {
          currentBucketId: "telegram:123#2026-07-06",
          state: "warm",
          event: "saved",
          providerSessionId: "ps-123",
          createdAt: CLOCK_START - 90_000,
          lastActivityAt: CLOCK_START - 1_000,
          snapshot: [{
            conversationId: "telegram:123#2026-07-06",
            providerSessionId: "ps-123",
            createdAt: CLOCK_START - 90_000,
            lastActivityAt: CLOCK_START - 1_000,
            busy: false,
          }],
          updatedAt: new Date(CLOCK_START).toISOString(),
          nextRolloverAt: "2026-07-07T00:00:00.000Z",
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("session");
    expect(stdout).toContain("bucket: telegram:123#2026-07-06");
    expect(stdout).toContain("state: warm");
    expect(stdout).toContain("age: 1m");
    expect(stdout).toContain("event: saved");
    expect(stdout).toContain("provider: ps-123");
    expect(stdout).toContain("next rollover: 2026-07-07T00:00:00.000Z");
  });

  it("derives cold status from an empty session snapshot while preserving eviction detail", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "session-evicted",
        session: {
          currentBucketId: "telegram:123#2026-07-06",
          state: "warm",
          event: "evicted",
          reason: "idle_timeout",
          providerSessionId: "ps-old",
          snapshot: [],
          updatedAt: new Date(CLOCK_START).toISOString(),
        },
      },
    });
    const harness = makeHarness({ runner, list: listReturning(() => [current]) });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("bucket: telegram:123#2026-07-06");
    expect(stdout).toContain("state: cold");
    expect(stdout).toContain("event: evicted");
    expect(stdout).toContain("reason: idle_timeout");
  });

  it("prints runs-health explanations from recent local summaries", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const current = makeSource(target, {
      metadata: {
        reason: "startup-complete",
        context: {
          selectedSkills: ["context-example", "todoist-cli"],
        },
      },
    });
    const startedAt = new Date(CLOCK_START - 5 * 60_000).toISOString();
    const runs: RecordedRunListItem[] = [
      makeRun({ runId: "run-live", status: "running", startedAt, updatedAt: startedAt }),
      makeRun({ runId: "run-usage", status: "failed", failureKind: "usage_limit", startedAt }),
      makeRun({ runId: "run-process", status: "interrupted", failureKind: "process_death", startedAt }),
      makeRun({ runId: "run-cancelled", status: "cancelled", startedAt }),
      makeRun({ runId: "run-provider-error", status: "failed", failureKind: "provider_error", startedAt }),
    ];
    const harness = makeHarness({
      runner,
      list: listReturning(() => [current]),
      listRecordedRuns: async (options) => {
        expect(options.artifactDir).toBe(current.artifactDir);
        expect(options.maxRuns).toBe(50);
        expect(options.scope).toBe("agent");
        return { totalRuns: 12, runs, warnings: [] };
      },
      isAlive: () => false,
    });

    await statusBackground(target, harness.deps);

    const stdout = harness.out.join("");
    expect(stdout).toContain("runs health");
    expect(stdout).toContain("Active skills: context-example, todoist-cli.");
    expect(stdout).toContain("Recorded runs: 12 total; showing 5 recent (max 50).");
    expect(stdout).toContain("Last runs: run-live running 5m ago");
    expect(stdout).toContain("Recent status counts: running=1, succeeded=0, failed=2, cancelled=1, interrupted=1.");
    expect(stdout).toContain("[WARN] Running summaries while process is gone: run-live running 5m ago.");
    expect(stdout).toContain("Usage limit [usage_limit, 1 recent]");
    expect(stdout).toContain("Process death [process_death, 1 recent]");
    expect(stdout).toContain("Cancelled [cancelled, 1 recent]");
    expect(stdout).toContain("Unclassified failure (provider_error) [provider_error (unclassified), 1 recent]");
    expect(stdout).toContain("The runtime hit a model, provider, turn, or context limit");
    expect(stdout).toContain("not yet part of the documented display taxonomy");
  });

  it("returns non-zero when no instance is running for this config", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    const code = await statusBackground(target, harness.deps);

    expect(code).toBe(1);
    expect(harness.out.join("")).toContain("No running mono-agent instance");
  });

  it("includes --config in the start hint for a non-default config", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget({ configPath: "/work/demo/custom.json" });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await statusBackground(target, harness.deps);

    expect(harness.out.join("")).toContain("mono-agent start --config /work/demo/custom.json");
  });

  it("preserves the explicit env file in a stopped-instance start hint", async () => {
    const { runner } = makeRunner({ loaded: false });
    const target = makeTarget({ envFile: "/work/demo/.env.operator" });
    const harness = makeHarness({ runner, list: listReturning(() => []) });

    await statusBackground(target, harness.deps);

    expect(harness.out.join("")).toContain("mono-agent start --env-file /work/demo/.env.operator");
  });
});

function makeRun(overrides: Partial<RecordedRunListItem>): RecordedRunListItem {
  return {
    runId: "run",
    conversationId: "chat",
    status: "succeeded",
    durationMs: 1000,
    eventCount: 1,
    updatedAt: new Date(CLOCK_START).toISOString(),
    ...overrides,
  };
}

describe("tailLogs", () => {
  it("tails the error then output log, following when asked", async () => {
    const target = makeTarget();
    const harness = makeHarness({ runner: makeRunner({ loaded: true }).runner, list: listReturning(() => []) });

    const code = await tailLogs(target, harness.deps, { follow: true, lines: 50 });

    expect(code).toBe(0);
    expect(harness.tailCalls[0]).toEqual(["-n", "50", "-F", target.paths.stderrPath, target.paths.stdoutPath]);
  });

  it("omits -F when not following", async () => {
    const target = makeTarget();
    const harness = makeHarness({ runner: makeRunner({ loaded: true }).runner, list: listReturning(() => []) });

    await tailLogs(target, harness.deps, { follow: false, lines: 200 });

    expect(harness.tailCalls[0]).toEqual(["-n", "200", target.paths.stderrPath, target.paths.stdoutPath]);
  });
});

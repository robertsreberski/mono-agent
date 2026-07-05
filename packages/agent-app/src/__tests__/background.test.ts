import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RecordedRunListItem, TraceSourceListItem } from "@mono-agent/observability";

import {
  LAUNCHD_LOG_MAX_BYTES,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "../background.js";
import type { BackgroundDeps, InstanceTarget } from "../background.js";
import type { LaunchctlRunner } from "../launchd.js";

const POLL = { timeoutMs: 5_000, intervalMs: 100 };
const CLOCK_START = 1_000_000;

function makeTarget(overrides: Partial<InstanceTarget> = {}): InstanceTarget {
  const label = "com.mono-agent.demo-0a1b2c3d";
  return {
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
    pathEnv: "/usr/bin:/bin",
    ...overrides,
  };
}

function makeSource(target: InstanceTarget, overrides: Partial<TraceSourceListItem> = {}): TraceSourceListItem {
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
    metadata: {
      reason: "startup-complete",
      channels: {
        telegram: { kind: "running" },
        slack: { kind: "waiting_for_config", reason: "Missing appToken" },
      },
    },
    ...overrides,
  } as TraceSourceListItem;
}

interface RunnerOptions {
  readonly loaded: boolean;
  readonly bootstrapCode?: number;
  readonly loadsAfterBootstrap?: boolean;
  readonly kickstartCode?: number;
  readonly bootoutCode?: number;
  /** Simulate a bootout that fails and leaves the service still loaded. */
  readonly bootoutKeepsLoaded?: boolean;
}

function makeRunner(opts: RunnerOptions): { runner: LaunchctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  const state = { loaded: opts.loaded };
  const runner: LaunchctlRunner = async (args) => {
    calls.push([...args]);
    switch (args[0]) {
      case "print":
        return { code: state.loaded ? 0 : 113, stdout: "", stderr: "" };
      case "bootstrap": {
        const code = opts.bootstrapCode ?? 0;
        if (opts.loadsAfterBootstrap ?? code === 0) {
          state.loaded = true;
        }
        return { code, stdout: "", stderr: "bootstrap detail" };
      }
      case "kickstart":
        return { code: opts.kickstartCode ?? 0, stdout: "", stderr: "" };
      case "bootout":
        if (!opts.bootoutKeepsLoaded) {
          state.loaded = false;
        }
        return { code: opts.bootoutCode ?? 0, stdout: "", stderr: "bootout detail" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
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
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const written: { path: string; data: string }[] = [];
  const removed: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const mkdirs: string[] = [];
  const tailCalls: string[][] = [];
  const fileSizes = new Map(Object.entries(opts.fileSizes ?? {}));
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
    isAlive: opts.isAlive ?? (() => false),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    spawnTail: async (args) => {
      tailCalls.push([...args]);
      return 0;
    },
  };
  return { deps, out, err, written, removed, renamed, mkdirs, tailCalls };
}

describe("startBackground", () => {
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
    const stdout = harness.out.join("");
    expect(stdout).toContain("started in the background");
    expect(stdout).toContain("4321");
    expect(stdout).toContain(target.label);
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
  });
});

describe("restartBackground", () => {
  it("kickstarts an already-loaded service instead of bootstrapping again", async () => {
    const { runner, calls } = makeRunner({ loaded: true });
    const target = makeTarget();
    const harness = makeHarness({ runner, list: listReturning(() => [makeSource(target)]) });

    const code = await restartBackground(target, harness.deps, POLL);

    expect(code).toBe(0);
    const verbs = calls.map((call) => call[0]);
    expect(verbs).toContain("kickstart");
    expect(verbs).not.toContain("bootstrap");
    expect(harness.out.join("")).toContain("restarted in the background");
  });

  it("waits for the new worker and ignores the previous instance's manifest", async () => {
    const { runner } = makeRunner({ loaded: true });
    const target = makeTarget();
    const oldSource = makeSource(target, { startedAt: new Date(CLOCK_START - 10_000).toISOString(), pid: 1111 });
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
});

describe("stopBackground", () => {
  it("boots the service out and removes the plist", async () => {
    const { runner, calls } = makeRunner({ loaded: true });
    const target = makeTarget();
    const existing = makeSource(target, { pid: 4321 });
    const harness = makeHarness({ runner, list: listReturning(() => [existing]), isAlive: () => true });

    const code = await stopBackground(target, harness.deps);

    expect(code).toBe(0);
    expect(calls.map((call) => call[0])).toContain("bootout");
    expect(harness.removed).toContain(target.paths.plistPath);
    // A live worker marks its own manifest stopped; we must not delete it.
    expect(harness.removed).not.toContain(resolve(target.registryDir, `${existing.sourceId}.json`));
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
    // The plist is still removed even when the running process won't stop.
    expect(harness.removed).toContain(target.paths.plistPath);
    expect(harness.err.join("")).toContain("Failed to stop");
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

import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectLegacyManagedWebLogArtifacts,
  maintainLegacyManagedWebLogArtifacts,
  startManagedWebLogMonitor,
} from "../managed-web-logs.js";
import type { LaunchdLogInspection } from "../launchd-logs.js";
import { managedWebPaths } from "../web-maintenance-paths.js";

const tempDirs: string[] = [];
const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-managed-web-logs-")));
  tempDirs.push(home);
  const paths = managedWebPaths(home);
  await mkdir(paths.launchd.logDir, { recursive: true, mode: 0o700 });
  return paths;
}

function inspection(needsMaintenance: boolean): LaunchdLogInspection {
  const stream = {
    activePath: "",
    files: [],
    activeBytes: 0,
    retainedBytes: 0,
    totalBytes: 0,
    byteAccountingComplete: true,
  };
  return {
    stdout: stream,
    stderr: stream,
    present: needsMaintenance,
    canMaintain: true,
    needsMaintenance,
    perAgentFileReasons: needsMaintenance ? ["stdout active exceeds maxBytes"] : [],
    sharedDirectoryNeedsMaintenance: false,
    pendingTransaction: false,
    pendingMaintenance: false,
    pendingPreparation: false,
    issues: [],
  };
}

describe("legacy managed web log cleanup", () => {
  it("removes exact owner files regardless of 0600/0644 mode and preserves unsafe near-matches", async () => {
    const paths = await fixture();
    const safe = join(paths.launchd.logDir, `web.out.log.retiring-${UUIDS[0]}`);
    const broadSafe = join(paths.launchd.logDir, `web.err.log.rollover-${UUIDS[1]}`);
    const near = join(paths.launchd.logDir, "web.out.log.retiring-not-a-uuid");
    const linkTarget = join(paths.launchd.logDir, "unrelated");
    const linked = join(paths.launchd.logDir, "web.err.log.retiring-33333333-3333-4333-8333-333333333333");
    const symbolic = join(paths.launchd.logDir, "web.out.log.rollover-44444444-4444-4444-8444-444444444444");
    await writeFile(safe, "safe", { mode: 0o600 });
    await writeFile(broadSafe, "broad", { mode: 0o644 });
    await writeFile(near, "near", { mode: 0o600 });
    await writeFile(linkTarget, "linked", { mode: 0o600 });
    await link(linkTarget, linked);
    await symlink(linkTarget, symbolic);

    const inspected = await inspectLegacyManagedWebLogArtifacts(paths.launchd);
    expect(inspected).toMatchObject({ needsMaintenance: true, canMaintain: true });
    expect(inspected.issues.join(" ")).toMatch(/not canonical|one regular/u);
    const maintained = await maintainLegacyManagedWebLogArtifacts(paths.launchd);

    await expect(lstat(safe)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(broadSafe)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(near)).resolves.toBeDefined();
    await expect(lstat(linked)).resolves.toBeDefined();
    await expect(lstat(symbolic)).resolves.toBeDefined();
    expect(maintained.refusals.join(" ")).toMatch(/not canonical|one regular/u);
  });

  it("fails closed when the bounded candidate inventory is exceeded", async () => {
    const paths = await fixture();
    for (let index = 0; index < 33; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      await writeFile(
        join(paths.launchd.logDir, `web.out.log.retiring-aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`),
        "legacy",
        { mode: 0o600 },
      );
    }
    const inspected = await inspectLegacyManagedWebLogArtifacts(paths.launchd);
    expect(inspected.canMaintain).toBe(false);
    expect(inspected.issues.join(" ")).toContain("exceeded 32");
    const maintained = await maintainLegacyManagedWebLogArtifacts(paths.launchd);
    expect(maintained.refusals.join(" ")).toContain("exceeded 32");
  });

  it("reports refused-only legacy artifacts without advertising removable maintenance", async () => {
    const paths = await fixture();
    const near = join(paths.launchd.logDir, "web.out.log.retiring-not-a-uuid");
    await writeFile(near, "preserve", { mode: 0o600 });

    const inspected = await inspectLegacyManagedWebLogArtifacts(paths.launchd);

    expect(inspected).toMatchObject({ needsMaintenance: false, canMaintain: true });
    expect(inspected.issues.join(" ")).toContain("not canonical");
    await expect(lstat(near)).resolves.toBeDefined();
  });
});

describe("startManagedWebLogMonitor", () => {
  it("wakes only the dedicated helper after cooldown and never stops or rotates the worker", async () => {
    vi.useFakeTimers();
    const paths = await fixture();
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner = vi.fn(async (args: readonly string[]) => {
      mutableCalls.push([...args]);
      if (args[0] === "print") return { code: 0, stdout: "state = waiting\n", stderr: "" };
      if (args[0] === "kickstart") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const monitor = startManagedWebLogMonitor(paths.launchd, {
      runner,
      getuid: () => 501,
      inspectLogs: async () => inspection(true),
      inspectLegacy: async () => ({ needsMaintenance: false, canMaintain: true, issues: [] }),
      stderr: () => undefined,
      monotonicNow: Date.now,
      wallClockNow: Date.now,
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(mutableCalls.some((args) => args[0] === "kickstart")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    monitor.stop();
    expect(mutableCalls.some((args) => args[0] === "kickstart"
      && args.some((value) => value.includes("com.mono-agent-web-maintenance")))).toBe(true);
    expect(mutableCalls.some((args) => args[0] === "bootout" || args[0] === "bootstrap")).toBe(false);
  });

  it("deduplicates 1000 consecutive failures to one bounded diagnostic line", async () => {
    vi.useFakeTimers();
    const paths = await fixture();
    const diagnostics: string[] = [];
    const monitor = startManagedWebLogMonitor(paths.launchd, {
      runner: async () => ({ code: 1, stdout: "", stderr: "" }),
      getuid: () => 501,
      inspectLogs: async () => { throw new Error(`token=secret\n${"x".repeat(2_000)}`); },
      inspectLegacy: async () => ({ needsMaintenance: false, canMaintain: true, issues: [] }),
      stderr: (line) => { diagnostics.push(line); },
      monotonicNow: Date.now,
      wallClockNow: Date.now,
    });
    await vi.advanceTimersByTimeAsync(1_000 * 5 * 60_000);
    monitor.stop();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.split("\n").filter(Boolean)).toHaveLength(1);
    expect(Buffer.byteLength(diagnostics[0] ?? "", "utf8")).toBeLessThanOrEqual(640);
    expect(diagnostics[0]).not.toContain("secret");
  });
});

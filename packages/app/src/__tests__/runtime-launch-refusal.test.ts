import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedRuntimeRefusalSection } from "../doctor/managed-startup.js";
import { deriveLaunchdLabel } from "../service/launchd/launchd.js";
import * as startupRefusal from "../service/launchd/launchd-snapshot-refusal.js";
import { clearLaunchdSnapshotRefusal, readLaunchdStartupRefusal, writeLaunchdStartupRefusal, SNAPSHOT_REFUSAL_MESSAGE } from "../service/launchd/launchd-snapshot-refusal.js";
import {
  refuseManagedRuntimeLaunch,
  RUNTIME_PROOF_REFUSAL_COOLDOWN_MS,
  waitForRuntimeProofRefusalCooldown,
} from "../service/managed-runtime/runtime-launch-refusal.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed startup refusal diagnostics", () => {
  it.each(["snapshot-refused", "runtime-proof-refused"] as const)("reports %s on macOS but does not even read leftover launchd state on Linux", async (reason) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "managed-startup-refusal-")));
    directories.push(root);
    const configPath = join(root, "example-agent.config.json");
    const target = { logDir: join(root, "logs") };
    await writeLaunchdStartupRefusal(deriveLaunchdLabel(configPath), target, reason);
    expect(await managedRuntimeRefusalSection(configPath, target, "darwin")).toMatchObject({
      id: "managed-runtime-launch", status: "error",
      details: [reason === "snapshot-refused" ? SNAPSHOT_REFUSAL_MESSAGE : startupRefusal.runtimeProofRefusalMessage(configPath)],
    });
    const read = vi.spyOn(startupRefusal, "readLaunchdStartupRefusal");
    expect(await managedRuntimeRefusalSection(configPath, target, "linux")).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("managed runtime launch refusal", () => {
  it("publishes durable failure immediately, validate reports remediation, then exits 78 after five minutes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-proof-refusal-")));
    directories.push(root);
    const target = { logDir: join(root, "logs") };
    const configPath = join(root, "example-agent.config.json");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let completed = false;
    const pending = refuseManagedRuntimeLaunch(configPath, target).then((code) => { completed = true; return code; });
    try {
      await vi.waitFor(async () => {
        expect(await readLaunchdStartupRefusal(deriveLaunchdLabel(configPath), target)).toBe("runtime-proof-refused");
      });
      expect(completed).toBe(false);
      expect(await managedRuntimeRefusalSection(configPath, target, "darwin")).toMatchObject({
        id: "managed-runtime-launch", status: "error",
        details: [expect.stringContaining(`mono-agent restart --config '${configPath}'`)],
      });
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Exiting after a five-minute cooldown (sooner if stopped); launchd will then retry."));
      // vi.waitFor advanced at most one second, far short of the retry boundary.
      await vi.advanceTimersByTimeAsync(RUNTIME_PROOF_REFUSAL_COOLDOWN_MS - 1_001);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await pending).toBe(78);
      expect(await readLaunchdStartupRefusal(deriveLaunchdLabel(configPath), target)).toBe("runtime-proof-refused");
      await clearLaunchdSnapshotRefusal(deriveLaunchdLabel(configPath), target);
      expect(await managedRuntimeRefusalSection(configPath, target, "darwin")).toBeUndefined();
    } finally {
      process.emit("SIGTERM");
      await pending;
    }
  });

  it("keeps the timer pending until the exact five-minute retry boundary", async () => {
    vi.useFakeTimers();
    let completed = false;
    const pending = waitForRuntimeProofRefusalCooldown().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(RUNTIME_PROOF_REFUSAL_COOLDOWN_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("ends the cooldown promptly on %s and cleans up all handles", async (signal) => {
    vi.useFakeTimers();
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const pending = waitForRuntimeProofRefusalCooldown();
    expect(vi.getTimerCount()).toBe(1);
    process.emit(signal);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });

  it("never converts state-publication failure or shutdown into exit zero", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-proof-refusal-")));
    directories.push(root);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pending = refuseManagedRuntimeLaunch(join(root, "config.json"), { logDir: join(root, "missing", "logs") });
    process.emit("SIGTERM");
    expect(await pending).toBe(78);
    expect(stderr).toHaveBeenCalledWith("Could not publish managed runtime-proof-refused status.\n");
  });
});

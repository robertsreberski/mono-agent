import { describe, expect, it, vi } from "vitest";

import {
  verifySupervisedRestart,
} from "../supervised-restart.js";
import { systemdUnitName } from "../systemd.js";
import { createSupervisedRestartAuthority } from "../supervised-restart-authority.js";
import { createSupervisedRestartLatch } from "../supervised-restart-latch.js";

const CONFIG_PATH = "/work/demo/mono-agent.config.json";
// The fragment check compares the loaded unit's basename against the unit name
// derived from this worker's config identity, so fixtures must carry the real
// name -- a hardcoded placeholder would exercise the mismatch path instead.
const EXPECTED_UNIT = systemdUnitName(CONFIG_PATH);

function launchctlPrint(options: {
  readonly pid?: number;
  readonly configPath?: string;
  readonly managedDefinition?: boolean;
}): string {
  const args = [
    "/usr/bin/env",
    "-i",
    "MONO_AGENT_MANAGED_WORKER=1",
    "PATH=/usr/bin:/bin",
    "/node",
    "/cli.js",
    "start",
    "--foreground",
    "--config",
    options.configPath ?? CONFIG_PATH,
    "--expected-background-snapshot",
    "snapshot1",
    "--expected-managed-runtime-launch",
    "proof1",
  ].map((argument) => `\t\t${argument}`).join("\n");
  return "gui/501/com.mono-agent.demo = {\n"
    + "\tpath = /home/u/Library/LaunchAgents/com.mono-agent.demo.plist\n"
    + "\tprogram = /usr/bin/env\n"
    + `\targuments = {\n${options.managedDefinition === false ? "\t\t/usr/bin/other\n" : args}\n\t}\n`
    + "\tlast exit code = (never exited)\n\n"
    + "\tsemaphores = {\n\t\tsuccessful exit => 0\n\t}\n"
    + "\tworking directory = /work/demo\n"
    + "\tstdout path = /work/demo/stdout.log\n"
    + "\tstderr path = /work/demo/stderr.log\n"
    + (options.pid === undefined ? "" : `\tpid = ${options.pid}\n`)
    + "}\n";
}

function launchdRunner(stdout: string, code = 0) {
  return vi.fn(async (_args: readonly string[]) => ({ code, stdout, stderr: "" }));
}

function systemdShow(properties: Record<string, string>, code = 0) {
  const stdout = Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n");
  return vi.fn(async (_command: string, _args: readonly string[]) => ({ code, stdout, stderr: "" }));
}

describe("verifySupervisedRestart", () => {
  it("re-checks a changed supervisor policy at POST and refuses stale acceptance", async () => {
    let policy = "on-failure";
    const latch = createSupervisedRestartLatch();
    const authority = createSupervisedRestartAuthority({
      configPath: CONFIG_PATH, startedAt: "boot-1", platform: "linux", pid: 777,
      systemdRun: async () => ({ code: 0, stderr: "", stdout: [
        "LoadState=loaded", "ActiveState=active", "MainPID=777",
        `FragmentPath=/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
        `ExecStart=argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
        `Restart=${policy}`,
      ].join("\n") }),
    }, latch);
    expect(await authority.verifyFresh?.()).toEqual({ supported: true });
    policy = "no";
    const current = await authority.verifyFresh!();
    expect(current.supported).toBe(false);
    expect(authority.accept(current).kind).toBe("refused");
    expect(latch.exitCode).toBe(0);
  });
  it("answers cached capability promptly and refuses a hanging fresh POST inspection", async () => {
    vi.useFakeTimers();
    try {
      const latch = createSupervisedRestartLatch();
      const authority = createSupervisedRestartAuthority({ configPath: CONFIG_PATH, startedAt: "boot-1",
        platform: "linux", pid: 777, systemdRun: () => new Promise(() => undefined) }, latch);
      await expect(authority.verify()).resolves.toEqual({ supported: false, reason: "Supervisor verification is pending." });
      const fresh = authority.verifyFresh!();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(fresh).resolves.toEqual({ supported: false, reason: "Supervisor verification timed out." });
      await expect(authority.verify()).resolves.toEqual({ supported: false, reason: "Supervisor verification timed out." });
      expect(latch.exitCode).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("returns the existing id to a concurrent verified request even if its token is not the latest", async () => {
    const latch = createSupervisedRestartLatch();
    const authority = createSupervisedRestartAuthority({ configPath: CONFIG_PATH, startedAt: "boot-1",
      platform: "linux", pid: 777, systemdRun: systemdShow({
        LoadState: "loaded", ActiveState: "active", MainPID: "777",
        FragmentPath: `/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
        ExecStart: `argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
        Restart: "on-failure",
      }) }, latch);
    const [first, second] = await Promise.all([authority.verifyFresh!(), authority.verifyFresh!()]);
    const accepted = authority.accept(first);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("expected acceptance");
    expect(authority.accept(second)).toEqual({ kind: "conflict", operationId: accepted.operationId });
    expect(latch.exitCode).toBe(42);
  });

  it("supports a launchd worker whose loaded service owns this PID with the expected definition", async () => {
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "darwin",
      pid: 4321,
      getuid: () => 501,
      launchdRunner: launchdRunner(launchctlPrint({ pid: 4321 })),
    });
    expect(verification).toEqual({ supported: true });
  });

  it("refuses when launchd owns a different PID for the same label", async () => {
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "darwin",
      pid: 9999,
      getuid: () => 501,
      launchdRunner: launchdRunner(launchctlPrint({ pid: 4321 })),
    });
    expect(verification).toEqual({
      supported: false,
      reason: "The supervised service does not own this process.",
    });
  });

  it("refuses when no launchd service is loaded for the worker label", async () => {
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "darwin",
      pid: 4321,
      getuid: () => 501,
      launchdRunner: launchdRunner("", 1),
    });
    expect(verification).toEqual({
      supported: false,
      reason: "No supervised service is registered for this worker.",
    });
  });

  it("refuses when the loaded definition is not a managed worker or names another config", async () => {
    const runner = launchdRunner(launchctlPrint({ pid: 4321, managedDefinition: false }));
    await expect(verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "darwin",
      pid: 4321,
      getuid: () => 501,
      launchdRunner: runner,
    })).resolves.toEqual({
      supported: false,
      reason: "The loaded service definition is not a managed mono-agent worker.",
    });
    await expect(verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "darwin",
      pid: 4321,
      getuid: () => 501,
      launchdRunner: launchdRunner(launchctlPrint({ pid: 4321, configPath: "/work/other/mono-agent.config.json" })),
    })).resolves.toEqual({
      supported: false,
      reason: "The loaded service definition does not match this worker.",
    });
  });

  it("refuses absent, changed, and misleading out-of-block launchd semaphore policy", async () => {
    const loaded = launchctlPrint({ pid: 4321 });
    for (const text of [
      loaded.replace("successful exit => 0", "successful exit => 1"),
      loaded.replace(/\tsemaphores = \{[\s\S]*?\t\}\n/u, ""),
      loaded.replace("successful exit => 0", "other flag => 0") + "successful exit => 0\n",
      loaded.replace("successful exit => 0", "successful exit => 0\n\t\tsuccessful exit => 1"),
    ]) {
      await expect(verifySupervisedRestart({
        configPath: CONFIG_PATH, startedAt: "boot-1", platform: "darwin", pid: 4321,
        getuid: () => 501, launchdRunner: launchdRunner(text),
      })).resolves.toEqual({ supported: false, reason: "The loaded launchd service does not verify relaunch on failure." });
    }
  });

  it("fails closed when the launchd check throws", async () => {
    const warn = vi.fn();
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "darwin",
      pid: 4321,
      getuid: () => 501,
      launchdRunner: vi.fn(async () => { throw new Error("launchctl unavailable"); }),
      logger: { warn },
    });
    expect(verification).toEqual({
      supported: false,
      reason: "The supervised-service check failed for this worker.",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("supports a systemd worker whose unit owns this PID while active", async () => {
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "linux",
      pid: 777,
      systemdRun: systemdShow({
        LoadState: "loaded",
        ActiveState: "active",
        SubState: "running",
        MainPID: "777",
        ExecMainStartTimestamp: "Thu 2026-09-18 08:00:00 UTC",
        UnitFileState: "enabled",
        FragmentPath: `/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
      ExecStart: `argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
        Restart: "on-failure",
      }),
    });
    expect(verification).toEqual({ supported: true });
  });

  it("refuses a systemd unit that is missing, foreign, or inactive", async () => {
    const base = {
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "linux" as const,
      pid: 777,
      configPath: CONFIG_PATH,
    };
    const active = {
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      MainPID: "777",
      ExecMainStartTimestamp: "Thu 2026-09-18 08:00:00 UTC",
      UnitFileState: "enabled",
      FragmentPath: `/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
      ExecStart: `argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
      Restart: "on-failure",
    };
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow({ ...active, LoadState: "not-found", MainPID: "0" }),
    })).resolves.toMatchObject({ supported: false });
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow({ ...active, MainPID: "778" }),
    })).resolves.toEqual({
      supported: false,
      reason: "The supervised service does not own this process.",
    });
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow({ ...active, ActiveState: "failed" }),
    })).resolves.toEqual({
      supported: false,
      reason: "The supervised service for this worker is not active.",
    });
  });

  it("refuses a loaded systemd unit that names another worker", async () => {
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "linux",
      pid: 777,
      systemdRun: systemdShow({
        LoadState: "loaded",
        ActiveState: "active",
        SubState: "running",
        MainPID: "777",
        ExecMainStartTimestamp: "Thu 2026-09-18 08:00:00 UTC",
        UnitFileState: "enabled",
        FragmentPath: "/home/u/.config/systemd/user/mono-agent-other.service",
        ExecStart: `argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
        Restart: "on-failure",
      }),
    });
    expect(verification).toEqual({
      supported: false,
      reason: "The loaded service definition does not match this worker.",
    });
  });

  it("refuses a loaded systemd unit whose executable identity does not match", async () => {
    await expect(verifySupervisedRestart({
      configPath: CONFIG_PATH, startedAt: "boot-1", platform: "linux", pid: 777,
      systemdRun: systemdShow({
        LoadState: "loaded", ActiveState: "active", MainPID: "777",
        FragmentPath: `/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
        Restart: "on-failure", ExecStart: "argv[]=/node /other start --foreground --config /other --expected-background-snapshot proof",
      }),
    })).resolves.toEqual({ supported: false, reason: "The loaded service definition does not match this worker." });
  });

  it("refuses a systemd unit whose relaunch policy would retire the worker", async () => {
    const base = {
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "linux" as const,
      pid: 777,
      configPath: CONFIG_PATH,
    };
    const active = {
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      MainPID: "777",
      ExecMainStartTimestamp: "Thu 2026-09-18 08:00:00 UTC",
      UnitFileState: "enabled",
      FragmentPath: `/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
      ExecStart: `argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
    };
    // `Restart=no` leaves exit 42 unrelaunched, so support must not be advertised.
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow({ ...active, Restart: "no" }),
    })).resolves.toEqual({
      supported: false,
      reason: "The supervised service is not configured to relaunch this worker (Restart=no).",
    });
    // `on-abnormal` relaunches signals but not a plain nonzero exit, so it
    // retires a supervised restart exactly like `no` does.
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow({ ...active, Restart: "on-abnormal" }),
    })).resolves.toMatchObject({ supported: false });
    // An unreadable policy fails closed, never supported.
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow(active),
    })).resolves.toEqual({
      supported: false,
      reason: "The supervised service is not configured to relaunch this worker (Restart=unknown).",
    });
    // `always` relaunches a nonzero exit like `on-failure` does.
    await expect(verifySupervisedRestart({
      ...base,
      systemdRun: systemdShow({ ...active, Restart: "always" }),
    })).resolves.toEqual({ supported: true });
  });

  it.each([
    { RestartPreventExitStatus: "42 SIGTERM" },
    { SuccessExitStatus: "1 42" },
  ])("refuses a loaded systemd unit that reclassifies restart exit 42: %j", async (override) => {
    await expect(verifySupervisedRestart({
      configPath: CONFIG_PATH, startedAt: "boot-1", platform: "linux", pid: 777,
      systemdRun: systemdShow({ LoadState: "loaded", ActiveState: "active", MainPID: "777",
        FragmentPath: `/home/u/.config/systemd/user/${EXPECTED_UNIT}`,
        ExecStart: `argv[]=/node /cli start --foreground --config ${CONFIG_PATH} --expected-background-snapshot proof`,
        Restart: "on-failure", ...override }),
    })).resolves.toEqual({ supported: false, reason: "The loaded systemd unit would not relaunch restart exit 42." });
  });

  it("reports unsupported without a user manager instead of throwing", async () => {
    const verification = await verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "linux",
      pid: 777,
      systemdRun: vi.fn(async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" })),
    });
    expect(verification).toEqual({
      supported: false,
      reason: "Agent restart needs a running systemd user manager.",
    });
  });

  it("reports unsupported on platforms without a supervised worker", async () => {
    await expect(verifySupervisedRestart({
      configPath: CONFIG_PATH,
      startedAt: "2026-09-18T08:00:00.000Z",
      platform: "win32",
      pid: 1,
    })).resolves.toEqual({
      supported: false,
      reason: "Agent restart is supported only on supervised macOS and Linux workers.",
    });
  });
});

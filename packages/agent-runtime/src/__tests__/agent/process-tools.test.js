import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { bashToolRun, execToolRun } from "../../agent/tools/index.js";
import { getPiBuiltinTools } from "../../agent/tools/pi-bridge.js";
import {
  killProcessGroup,
  startPreparedProcess,
} from "../../agent/tools/shared/process-runner.js";

const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-process-"));
  tempDirs.push(dir);
  return dir;
}

function options(workspace) {
  return { ctx: { workspace, sandbox: passthroughSandbox } };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("Exec", () => {
  it("keeps the disabled schema byte-identical and injects background only with a controller", () => {
    const withoutController = getPiBuiltinTools(["Exec", "Bash"]);
    const baseline = Object.fromEntries(withoutController.map((tool) => [tool.name, JSON.stringify(tool.parameters)]));
    expect(JSON.parse(baseline.Exec).properties).not.toHaveProperty("background");
    expect(JSON.parse(baseline.Bash).properties).not.toHaveProperty("background");

    const withController = getPiBuiltinTools(["Exec", "Bash"], {
      processJobsController: { start: vi.fn() },
    });
    expect(withController.find((tool) => tool.name === "Exec").parameters.properties.background)
      .toEqual(expect.objectContaining({ type: "boolean" }));
    expect(withController.find((tool) => tool.name === "Bash").parameters.properties.background)
      .toEqual(expect.objectContaining({ type: "boolean" }));
    expect(withController.find((tool) => tool.name === "Exec").parameters.properties.background.description)
      .toContain("Do not use for commands that daemonize");

    const disabledAgain = getPiBuiltinTools(["Exec", "Bash"]);
    expect(Object.fromEntries(disabledAgain.map((tool) => [tool.name, JSON.stringify(tool.parameters)]))).toEqual(baseline);
  });

  it("hands off the exact prepared command, returns before completion, and cleans up once", async () => {
    const workspace = tempWorkspace();
    const cleanup = vi.fn(async () => {});
    const preparedCommands = [];
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        const prepared = { ...command, args: command.args ?? [], sandboxed: true, sandboxSettingsPath: resolve(workspace, "settings.json"), cleanup };
        preparedCommands.push(prepared);
        return prepared;
      },
    };
    let terminal;
    const start = vi.fn(async (request) => {
      const handle = request.launch({ timeoutMs: 5_000, maxBufferBytes: 1024 });
      await handle.release();
      terminal = handle.completion.finally(async () => {
        await request.prepared.cleanup();
        await request.prepared.cleanup();
      });
      return { jobId: "pj_runtime", state: "running", startedAt: handle.startedAt };
    });
    const started = Date.now();
    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "setTimeout(() => process.stdout.write('done'), 180)"],
      background: true,
    }, { ctx: { workspace, sandbox }, processJobsController: { start } });

    expect(Date.now() - started).toBeLessThan(150);
    expect(result).toMatchObject({
      error: false,
      outcome: { status: "ok", code: "background_started", background: true, job_id: "pj_runtime" },
    });
    expect(JSON.parse(result.text)).toMatchObject({ job_id: "pj_runtime", state: "running" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0].prepared.command).toBe(preparedCommands[0].command);
    expect(start.mock.calls[0][0].prepared.sandboxSettingsPath).toBe(resolve(workspace, "settings.json"));
    expect(start.mock.calls[0][0].summary).toBe("Exec command (2 arguments; values redacted)");
    expect(start.mock.calls[0][0].summary).not.toContain(process.execPath);
    expect(cleanup).not.toHaveBeenCalled();
    await terminal;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("hands off and launches an unsandboxed background command with no sandbox settings path", async () => {
    const workspace = tempWorkspace();
    let completion;
    const start = vi.fn(async (request) => {
      expect(request.prepared.sandboxed).toBe(false);
      expect(request.prepared.sandboxSettingsPath).toBeUndefined();
      const handle = request.launch({ timeoutMs: 5_000, maxBufferBytes: 1024 });
      await handle.release();
      completion = handle.completion;
      return { jobId: "pj_unsandboxed", state: "running", startedAt: handle.startedAt };
    });

    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('unsandboxed handoff')"],
      background: true,
    }, {
      ctx: { workspace, sandbox: passthroughSandbox },
      processJobsController: { start },
    });

    expect(result).toMatchObject({
      error: false,
      outcome: { code: "background_started", job_id: "pj_unsandboxed" },
    });
    await expect(completion).resolves.toMatchObject({
      code: 0,
      stdout: "unsandboxed handoff",
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("cleans an unlaunched prepared command once when the controller returns an invalid result", async () => {
    const workspace = tempWorkspace();
    const cleanup = vi.fn(async () => {});
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], cleanup };
      },
    };

    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('must-not-run')"],
      background: true,
    }, {
      ctx: { workspace, sandbox },
      processJobsController: { start: vi.fn(async () => ({ invalid: true })) },
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { code: "process_job_controller_invalid" },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("makes cleanup failure authoritative for an invalid unlaunched controller result", async () => {
    const workspace = tempWorkspace();
    const privateText = `private-invalid-cleanup at ${resolve(workspace, "sandbox", "settings.json")}`;
    const cleanup = vi.fn(async () => { throw new Error(privateText); });
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], cleanup };
      },
    };

    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('must-not-run')"],
      background: true,
    }, {
      ctx: { workspace, sandbox },
      processJobsController: { start: vi.fn(async () => ({ invalid: true })) },
    });

    expect(result).toMatchObject({
      error: true,
      text: "Error: Process-job cleanup could not be confirmed.",
      outcome: { code: "process_job_cleanup_incomplete" },
    });
    expect(JSON.stringify(result)).not.toContain("private-invalid-cleanup");
    expect(JSON.stringify(result)).not.toContain(workspace);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("returns only a stable public code and generic message when background admission fails", async () => {
    const workspace = tempWorkspace();
    const cleanup = vi.fn(async () => {});
    const privateText = `arbitrary-admission-secret at ${resolve(workspace, "private", "state.json")}`;
    const failure = Object.assign(new Error(privateText), { code: "process_job_store_error" });
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], cleanup };
      },
    };

    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('must-not-run')"],
      background: true,
    }, {
      ctx: { workspace, sandbox },
      processJobsController: { start: vi.fn(async () => { throw failure; }) },
    });

    expect(result).toMatchObject({
      error: true,
      text: "Error: Process-job storage failed.",
      outcome: { code: "process_job_store_error" },
    });
    expect(JSON.stringify(result)).not.toContain("arbitrary-admission-secret");
    expect(JSON.stringify(result)).not.toContain(workspace);
  });

  it.each([
    ["throwing code accessor", Object.defineProperty(new Error("private-accessor-secret"), "code", {
      get() { throw new Error("private-getter-secret"); },
    })],
    ["hostile proxy", new Proxy(Object.assign(new Error("private-proxy-secret"), {
      code: "process_job_store_error",
    }), {})],
  ])("contains %s failures at the stable controller boundary", async (_label, failure) => {
    const workspace = tempWorkspace();
    const cleanup = vi.fn(async () => {});
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], cleanup };
      },
    };

    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('must-not-run')"],
      background: true,
    }, {
      ctx: { workspace, sandbox },
      processJobsController: { start: vi.fn(async () => { throw failure; }) },
    });

    expect(result).toMatchObject({
      error: true,
      text: "Error: The process-job controller is unavailable.",
      outcome: { code: "process_job_controller_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("does not clean underneath a launched handle when the controller result is invalid", async () => {
    const workspace = tempWorkspace();
    const cleanup = vi.fn(async () => {});
    let handle;
    let ownedPrepared;
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], cleanup };
      },
    };
    const controller = {
      async start(request) {
        ownedPrepared = request.prepared;
        handle = request.launch({ timeoutMs: 5_000 });
        return { invalid: true };
      },
    };

    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('owned')"],
      background: true,
    }, { ctx: { workspace, sandbox }, processJobsController: controller });

    expect(result).toMatchObject({
      error: true,
      outcome: { code: "process_job_controller_invalid" },
    });
    expect(cleanup).not.toHaveBeenCalled();
    await handle.release();
    await handle.completion;
    await ownedPrepared.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not spawn the target until the host releases its durable ownership gate", async () => {
    const workspace = tempWorkspace();
    const marker = resolve(workspace, "target-started");
    let terminal;
    const controller = {
      async start(request) {
        const handle = request.launch({ timeoutMs: 5_000 });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        expect(existsSync(marker)).toBe(false);
        await handle.release();
        terminal = handle.completion;
        return { jobId: "pj_gate", state: "running", startedAt: handle.startedAt };
      },
    };

    await execToolRun({
      executable: process.execPath,
      args: ["--eval", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
      background: true,
    }, { ...options(workspace), processJobsController: controller });
    await terminal;
    expect(existsSync(marker)).toBe(true);
  });

  it("binds the exact process environment at handoff rather than delayed launch", async () => {
    const workspace = tempWorkspace();
    const key = "MONO_AGENT_BACKGROUND_ENV_SNAPSHOT";
    const previous = process.env[key];
    process.env[key] = "value-at-handoff";
    let terminal;
    const controller = {
      async start(request) {
        process.env[key] = "changed-before-launch";
        const handle = request.launch({ timeoutMs: 5_000 });
        await handle.release();
        terminal = handle.completion;
        return { jobId: "pj_environment", state: "running", startedAt: handle.startedAt };
      },
    };
    try {
      await execToolRun({
        executable: process.execPath,
        args: ["--eval", `process.stdout.write(process.env.${key} ?? 'missing')`],
        background: true,
      }, { ...options(workspace), processJobsController: controller });
      await expect(terminal).resolves.toMatchObject({ stdout: "value-at-handoff" });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("keeps the attestable group leader alive when its owning host pipe disappears", async () => {
    if (process.platform === "win32") return;
    const runnerUrl = new URL("../../agent/tools/shared/process-runner.js", import.meta.url).href;
    const parentSource = [
      `import { startPreparedProcess } from ${JSON.stringify(runnerUrl)};`,
      "const target = \"setTimeout(() => process.stdout.write('x'.repeat(65536)), 200); setTimeout(() => {}, 5000)\";",
      "const handle = startPreparedProcess({ command: process.execPath, args: ['--eval', target] }, { waitForProcessGroup: true, timeoutMs: 10000 });",
      "await handle.release();",
      "process.stdout.write(String(handle.pid) + '\\n');",
      "setTimeout(() => process.exit(0), 50);",
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "--eval", parentSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let parentOutput = "";
    let parentError = "";
    parent.stdout.on("data", (chunk) => { parentOutput += chunk.toString("utf8"); });
    parent.stderr.on("data", (chunk) => { parentError += chunk.toString("utf8"); });
    await new Promise((resolvePromise, reject) => {
      parent.once("error", reject);
      parent.once("close", (code) => code === 0
        ? resolvePromise()
        : reject(new Error(`owner fixture exited ${String(code)}: ${parentError}`)));
    });
    const pgid = Number(parentOutput.trim());
    expect(Number.isSafeInteger(pgid) && pgid > 0).toBe(true);
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      expect(() => process.kill(pgid, 0)).not.toThrow();
    } finally {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("waits for an inherited-group descendant after the target leader exits", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const marker = resolve(workspace, "descendant-finished");
    let terminal;
    const controller = {
      async start(request) {
        const handle = request.launch({ timeoutMs: 5_000 });
        await handle.release();
        terminal = handle.completion;
        return { jobId: "pj_descendant", state: "running", startedAt: handle.startedAt };
      },
    };
    const target = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['--eval', `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 350)`, process.argv[1]], { stdio: 'ignore' });",
      "child.unref();",
    ].join("\n");

    await execToolRun({
      executable: process.execPath,
      args: ["--eval", target, marker],
      background: true,
    }, { ...options(workspace), processJobsController: controller });

    expect(existsSync(marker)).toBe(false);
    await terminal;
    expect(existsSync(marker)).toBe(true);
  });

  it("bounds deadline termination through SIGKILL for a long inherited-group descendant", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const childPidPath = resolve(workspace, "deadline-child.pid");
    const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const target = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['--eval', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
      "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
      "child.unref();",
    ].join("\n");
    const handle = startPreparedProcess({
      command: process.execPath,
      args: ["--eval", target, childPidPath],
    }, { waitForProcessGroup: true, timeoutMs: 400 });
    try {
      await handle.release();
      await waitForPath(childPidPath);
      const outcome = await within(handle.completion, 3_500);
      const childPid = Number(readFileSync(childPidPath, "utf8").trim());
      expect(outcome).toMatchObject({ timedOut: true, groupExitConfirmed: true });
      await waitForProcessExit(childPid);
    } finally {
      try { if (handle.pgid !== null) process.kill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("keeps live-leader cancellation authoritative across an over-limit event-loop stall and permits cleanup", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const treePath = resolve(workspace, "stalled-cancel-tree.json");
    const settingsPath = resolve(workspace, "settings.json");
    writeFileSync(settingsPath, "{}\n");
    const cleanup = vi.fn(async () => rmSync(settingsPath, { force: true }));
    const nativeKill = process.kill.bind(process);
    const probes = [];
    let handle;
    let terminal;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (handle?.pgid !== null && handle?.pgid !== undefined
        && pid === -handle.pgid && signal === 0) probes.push(pid);
      return nativeKill(pid, signal);
    });
    const controller = {
      async start(request) {
        handle = request.launch({ timeoutMs: 10_000 });
        terminal = (async () => {
          await handle.release();
          await waitForPath(treePath);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
          // The known group leader stayed live throughout the stall, so long
          // jobs need no 25 ms presence polling and cancellation remains safe.
          expect(probes).toHaveLength(0);
          handle.cancel();
          const outcome = await handle.completion;
          if (outcome.groupExitConfirmed) await request.prepared.cleanup();
          return outcome;
        })();
        return { jobId: "pj_stalled_cancel", state: "running", startedAt: handle.startedAt };
      },
    };
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], sandboxSettingsPath: settingsPath, cleanup };
      },
    };
    try {
      await execToolRun({
        executable: process.execPath,
        args: ["--eval", inheritedProcessTreeSource(), treePath],
        background: true,
      }, { ctx: { workspace, sandbox }, processJobsController: controller });
      const outcome = await within(terminal, 4_000);
      const tree = readProcessTree(treePath);
      expect(outcome).toMatchObject({ aborted: false, timedOut: false, groupExitConfirmed: true });
      await Promise.all([handle.pid, tree.target, tree.descendant].map(async (pid) => await waitForProcessExit(pid)));
      expect(cleanup).toHaveBeenCalledOnce();
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      kill.mockRestore();
      try { if (handle?.pgid !== null && handle?.pgid !== undefined) nativeKill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("keeps live-leader timeout authoritative across an over-limit event-loop stall and permits cleanup", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const treePath = resolve(workspace, "stalled-timeout-tree.json");
    const settingsPath = resolve(workspace, "settings.json");
    writeFileSync(settingsPath, "{}\n");
    const cleanup = vi.fn(async () => rmSync(settingsPath, { force: true }));
    let handle;
    let terminal;
    const controller = {
      async start(request) {
        const timeoutMs = 1_000;
        handle = request.launch({ timeoutMs });
        terminal = (async () => {
          await handle.release();
          await waitForPath(treePath);
          const pastDeadlineMs = Math.max(
            350,
            Date.parse(handle.startedAt) + timeoutMs - Date.now() + 300,
          );
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pastDeadlineMs);
          const outcome = await handle.completion;
          if (outcome.groupExitConfirmed) await request.prepared.cleanup();
          return outcome;
        })();
        return { jobId: "pj_stalled_timeout", state: "running", startedAt: handle.startedAt };
      },
    };
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], sandboxSettingsPath: settingsPath, cleanup };
      },
    };
    try {
      await execToolRun({
        executable: process.execPath,
        args: ["--eval", inheritedProcessTreeSource(), treePath],
        background: true,
      }, { ctx: { workspace, sandbox }, processJobsController: controller });
      const outcome = await within(terminal, 4_000);
      const tree = readProcessTree(treePath);
      expect(outcome).toMatchObject({ timedOut: true, groupExitConfirmed: true });
      await Promise.all([handle.pid, tree.target, tree.descendant].map(async (pid) => await waitForProcessExit(pid)));
      expect(cleanup).toHaveBeenCalledOnce();
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      try { if (handle?.pgid !== null && handle?.pgid !== undefined) process.kill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("re-attests and cancels an owned descendant group after the gate leader exits", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const childPidPath = resolve(workspace, "leader-exit-child.pid");
    const descendant = "setInterval(() => {}, 1000)";
    const target = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['--eval', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
      "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
      "child.unref();",
    ].join("\n");
    const handle = startPreparedProcess({
      command: process.execPath,
      args: ["--eval", target, childPidPath],
    }, { waitForProcessGroup: true, timeoutMs: 10_000 });
    try {
      await handle.release();
      await waitForPath(childPidPath);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      try { if (handle.pid !== null) process.kill(handle.pid, "SIGKILL"); } catch { /* leader already exited */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      handle.cancel();
      const outcome = await within(handle.completion, 3_000);
      const childPid = Number(readFileSync(childPidPath, "utf8").trim());
      expect(outcome.groupExitConfirmed).toBe(true);
      await waitForProcessExit(childPid);
    } finally {
      try { if (handle.pgid !== null) process.kill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("permanently revokes group authority after a post-exit over-limit observation gap", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const targetPidPath = resolve(workspace, "observation-gap-target.pid");
    const target = [
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const handle = startPreparedProcess({
      command: process.execPath,
      args: ["--eval", target, targetPidPath],
    }, { waitForProcessGroup: true, timeoutMs: 10_000 });
    const nativeKill = process.kill.bind(process);
    let leaderKilled = false;
    let postExitProbeObserved = false;
    const groupSignals = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (leaderKilled && pid === -(handle.pgid ?? 0) && signal === 0) postExitProbeObserved = true;
      if (pid === -(handle.pgid ?? 0) && signal !== 0) groupSignals.push(signal);
      return nativeKill(pid, signal);
    });
    try {
      await handle.release();
      await waitForPath(targetPidPath);
      leaderKilled = true;
      if (handle.pid !== null) nativeKill(handle.pid, "SIGKILL");
      await vi.waitFor(() => expect(postExitProbeObserved).toBe(true));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);

      handle.cancel();
      const outcome = await within(handle.completion, 3_500);
      const targetPid = Number(readFileSync(targetPidPath, "utf8").trim());
      expect(outcome).toMatchObject({ groupExitConfirmed: false });
      expect(outcome.spawnError?.message).toMatch(/identity could not be re-attested/u);
      expect(groupSignals).toEqual([]);
      expect(() => process.kill(targetPid, 0)).not.toThrow();
    } finally {
      kill.mockRestore();
      try { if (handle.pgid !== null) nativeKill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("never signals a numerically reused group after post-exit absence", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const targetPidPath = resolve(workspace, "reused-group-target.pid");
    const target = [
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const handle = startPreparedProcess({
      command: process.execPath,
      args: ["--eval", target, targetPidPath],
    }, { waitForProcessGroup: true, timeoutMs: 10_000 });
    const nativeKill = process.kill.bind(process);
    let reportPostExitAbsence = false;
    let absenceObserved = false;
    const groupSignals = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (reportPostExitAbsence && pid === -(handle.pgid ?? 0) && signal === 0) {
        reportPostExitAbsence = false;
        absenceObserved = true;
        queueMicrotask(() => handle.cancel());
        throw Object.assign(new Error("group absent"), { code: "ESRCH" });
      }
      if (pid === -(handle.pgid ?? 0) && signal !== 0) groupSignals.push(signal);
      return nativeKill(pid, signal);
    });
    try {
      await handle.release();
      await waitForPath(targetPidPath);
      reportPostExitAbsence = true;
      if (handle.pid !== null) nativeKill(handle.pid, "SIGKILL");
      await vi.waitFor(() => expect(absenceObserved).toBe(true));
      const outcome = await within(handle.completion, 3_000);
      // The still-live fixture stands in for a different group that reused the
      // number after the first proven absence. It must never receive a signal.
      const targetPid = Number(readFileSync(targetPidPath, "utf8").trim());
      expect(outcome.groupExitConfirmed).toBe(true);
      expect(groupSignals).toEqual([]);
      expect(() => nativeKill(targetPid, 0)).not.toThrow();
    } finally {
      kill.mockRestore();
      try { if (handle.pgid !== null) nativeKill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("does not restore group authority after a post-exit indeterminate observation", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const targetPidPath = resolve(workspace, "indeterminate-observation-target.pid");
    const target = [
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const handle = startPreparedProcess({
      command: process.execPath,
      args: ["--eval", target, targetPidPath],
    }, { waitForProcessGroup: true, timeoutMs: 10_000 });
    const nativeKill = process.kill.bind(process);
    let injectIndeterminateProbe = false;
    const groupSignals = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (injectIndeterminateProbe && pid === -(handle.pgid ?? 0) && signal === 0) {
        injectIndeterminateProbe = false;
        throw Object.assign(new Error("probe indeterminate"), { code: "EPERM" });
      }
      if (pid === -(handle.pgid ?? 0) && signal !== 0) groupSignals.push(signal);
      return nativeKill(pid, signal);
    });
    try {
      await handle.release();
      await waitForPath(targetPidPath);
      injectIndeterminateProbe = true;
      try { if (handle.pid !== null) nativeKill(handle.pid, "SIGKILL"); } catch { /* leader already exited */ }
      await vi.waitFor(() => expect(injectIndeterminateProbe).toBe(false));
      // Later successful presence probes must not refresh the revoked proof.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));

      handle.cancel();
      const outcome = await within(handle.completion, 3_500);
      const targetPid = Number(readFileSync(targetPidPath, "utf8").trim());
      expect(outcome).toMatchObject({ groupExitConfirmed: false });
      expect(groupSignals).toEqual([]);
      expect(() => nativeKill(targetPid, 0)).not.toThrow();
    } finally {
      kill.mockRestore();
      try { if (handle.pgid !== null) nativeKill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("settles a shutdown abort only after its long inherited group exits", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const childPidPath = resolve(workspace, "shutdown-child.pid");
    const target = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
      "child.unref();",
    ].join("\n");
    const shutdown = new AbortController();
    const handle = startPreparedProcess({
      command: process.execPath,
      args: ["--eval", target, childPidPath],
    }, { waitForProcessGroup: true, timeoutMs: 10_000, signal: shutdown.signal });
    try {
      await handle.release();
      await waitForPath(childPidPath);
      shutdown.abort(new Error("runtime shutdown"));
      const outcome = await within(handle.completion, 3_000);
      const childPid = Number(readFileSync(childPidPath, "utf8").trim());
      expect(outcome).toMatchObject({ aborted: true, groupExitConfirmed: true });
      await waitForProcessExit(childPid);
    } finally {
      try { if (handle.pgid !== null) process.kill(-handle.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("never falls back from an absent POSIX group to a potentially reused leader PID", () => {
    if (process.platform === "win32") return;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });

    killProcessGroup({ pid: 4321 }, "SIGTERM");

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-4321, "SIGTERM");
  });

  it("restores the explicit single-PID fallback for a live Node REPL child", () => {
    if (process.platform === "win32") return;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) throw Object.assign(new Error("group unavailable"), { code: "ESRCH" });
      return true;
    });

    killProcessGroup(
      { pid: 4321, exitCode: null, signalCode: null },
      "SIGTERM",
      { fallbackToChildPid: true },
    );

    expect(kill.mock.calls).toEqual([
      [-4321, "SIGTERM"],
      [4321, "SIGTERM"],
    ]);
  });

  it.each([
    ["exit code", { pid: 4321, exitCode: 0, signalCode: null }],
    ["signal code", { pid: 4321, exitCode: null, signalCode: "SIGTERM" }],
  ])("never falls back to a reaped Node REPL child PID with a recorded %s", (_label, child) => {
    if (process.platform === "win32") return;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) throw Object.assign(new Error("group unavailable"), { code: "ESRCH" });
      return true;
    });

    killProcessGroup(child, "SIGKILL", { fallbackToChildPid: true });

    expect(kill.mock.calls).toEqual([[-4321, "SIGKILL"]]);
  });

  it("preserves foreground behavior with an injected controller and narrows explicit background limits", async () => {
    const workspace = tempWorkspace();
    const controller = { start: vi.fn(async (request) => ({ jobId: "pj_limits", state: "queued", startedAt: null })) };
    const foreground = await execToolRun({ executable: process.execPath, args: ["--eval", "process.stdout.write('same')"] }, options(workspace));
    const injectedForeground = await execToolRun(
      { executable: process.execPath, args: ["--eval", "process.stdout.write('same')"] },
      { ...options(workspace), processJobsController: controller },
    );
    expect({ ...injectedForeground, outcome: { ...injectedForeground.outcome, durationMs: 0 } })
      .toEqual({ ...foreground, outcome: { ...foreground.outcome, durationMs: 0 } });
    expect(controller.start).not.toHaveBeenCalled();

    const exec = getPiBuiltinTools(["Exec"], {
      cwd: workspace,
      ctx: { workspace, sandbox: passthroughSandbox },
      processJobsController: controller,
      toolLimits: { bashTimeoutMs: 1_000, bashOutputLimitChars: 100 },
    }).find((tool) => tool.name === "Exec");
    await exec.execute("job-limits", {
      executable: process.execPath,
      args: ["--version"],
      timeout_ms: 9_999,
      max_output_chars: 9_999,
      background: true,
    });
    expect(controller.start).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1_000, maxOutputChars: 100 }));
  });

  it("lets the host defaults own omitted background limits", async () => {
    const workspace = tempWorkspace();
    const start = vi.fn(async () => ({ jobId: "pj_defaults", state: "queued", startedAt: null }));
    const exec = getPiBuiltinTools(["Exec"], {
      cwd: workspace,
      ctx: { workspace, sandbox: passthroughSandbox },
      processJobsController: { start },
    }).find((tool) => tool.name === "Exec");
    await exec.execute("job-defaults", {
      executable: process.execPath,
      args: ["--version"],
      background: true,
    });
    expect(start.mock.calls[0][0]).not.toHaveProperty("timeoutMs");
    expect(start.mock.calls[0][0]).not.toHaveProperty("maxOutputChars");
  });

  it("applies a request environment and PATH prepend only to the current tool run", async () => {
    const workspace = tempWorkspace();
    const ctx = {
      workspace,
      sandbox: passthroughSandbox,
      toolEnvironment: {
        schema: 1,
        values: { MULTICA_TASK_ID: "task-fixture" },
        pathPrepend: [workspace],
      },
    };
    const injected = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write(JSON.stringify({task:process.env.MULTICA_TASK_ID,path:process.env.PATH?.split(require('node:path').delimiter)[0]}))"],
    }, { ctx });
    expect(JSON.parse(injected.text)).toEqual({ task: "task-fixture", path: workspace });

    const clean = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write(process.env.MULTICA_TASK_ID ?? 'absent')"],
    }, options(workspace));
    expect(clean.text).toBe("absent");
  });
  it("passes argv literally without shell expansion", async () => {
    const workspace = tempWorkspace();
    const marker = resolve(workspace, "must-not-exist");
    const literal = `$(touch ${marker})`;
    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write(process.argv[1])", literal],
    }, options(workspace));

    expect(result).toMatchObject({
      error: false,
      outcome: { status: "ok", code: "ok", attempts: 1 },
    });
    expect(result.text).toBe(literal);
    expect(existsSync(marker)).toBe(false);
  });

  it("retains partial stdout and stderr with structured nonzero and timeout outcomes", async () => {
    const workspace = tempWorkspace();
    const failed = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
    }, options(workspace));
    expect(failed.text).toContain("Exit code 7");
    expect(failed.text).toContain("out");
    expect(failed.text).toContain("err");
    expect(failed).toMatchObject({
      error: true,
      outcome: { status: "error", code: "nonzero_exit", exitCode: 7 },
    });

    const timedOut = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "console.log('before-timeout'); setTimeout(() => {}, 5000)"],
      // Long enough for Node to boot and flush its line on a loaded CI runner, still far below the
      // child's 5s sleep so the timeout is what ends it. At 50ms this raced Node's own startup.
      timeout_ms: 1000,
    }, options(workspace));
    expect(timedOut.text).toContain("before-timeout");
    expect(timedOut).toMatchObject({
      error: true,
      outcome: { status: "error", code: "timeout", timedOut: true },
    });
  });

  it("reports sandbox cleanup failures without losing process output", async () => {
    const workspace = tempWorkspace();
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return {
          ...command,
          cleanup: async () => { throw new Error("cleanup broke"); },
        };
      },
    };
    const result = await execToolRun({
      executable: process.execPath,
      args: ["--eval", "process.stdout.write('retained output')"],
    }, { ctx: { workspace, sandbox } });

    expect(result.text).toContain("cleanup broke");
    expect(result.text).toContain("retained output");
    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "cleanup_failed", exitCode: 0 },
    });
  });
});

describe("Bash process outcomes and Pi bridge metadata", () => {
  it("cancels the detached descendant group before sandbox cleanup", async () => {
    if (process.platform === "win32") return;
    const workspace = tempWorkspace();
    const childPidPath = resolve(workspace, "child.pid");
    const cleanup = vi.fn(async () => {});
    let terminal;
    const controller = {
      async start(request) {
        const handle = request.launch({ timeoutMs: 10_000 });
        await handle.release();
        terminal = (async () => {
          const deadline = Date.now() + 3_000;
          while (!existsSync(childPidPath) && Date.now() < deadline) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
          handle.cancel();
          const outcome = await handle.completion;
          await request.prepared.cleanup();
          return outcome;
        })();
        return { jobId: "pj_tree", state: "running", startedAt: handle.startedAt };
      },
    };
    const sandbox = {
      ...passthroughSandbox,
      async prepareCommand({ command }) {
        return { ...command, args: command.args ?? [], sandboxed: true, cleanup };
      },
    };
    const result = await bashToolRun({
      command: `sleep 30 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
      background: true,
    }, { ctx: { workspace, sandbox }, processJobsController: controller });
    expect(result.outcome).toMatchObject({ code: "background_started" });
    const outcome = await terminal;
    const childPid = Number(readFileSync(childPidPath, "utf8").trim());
    expect(outcome.signal).toBeTruthy();
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves the legacy Bash timeout warning on a successful background handoff", async () => {
    const workspace = tempWorkspace();
    const events = [];
    const start = vi.fn(async () => ({ jobId: "pj_legacy", state: "queued", startedAt: null }));
    const bash = getPiBuiltinTools(["Bash"], {
      cwd: workspace,
      onEvent: (event) => events.push(event),
      ctx: { workspace, sandbox: passthroughSandbox },
      processJobsController: { start },
    }).find((tool) => tool.name === "Bash");

    await bash.execute("bash-background-legacy", {
      command: "printf safe",
      timeout: 1,
      background: true,
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1_000 }));
    expect(events).toEqual([expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "deprecated_bash_timeout",
    })]);
  });

  it("makes the request environment available to Bash without enabling profiles", async () => {
    const workspace = tempWorkspace();
    const result = await bashToolRun({ command: "printf %s \"$MULTICA_AGENT_ID\"" }, {
      ctx: {
        workspace,
        sandbox: passthroughSandbox,
        toolEnvironment: { schema: 1, values: { MULTICA_AGENT_ID: "agent-fixture" } },
      },
    });
    expect(result.text).toBe("agent-fixture");
  });
  it("rejects non-string and NUL-containing commands before sandbox preparation", async () => {
    const workspace = tempWorkspace();
    const prepareCommand = vi.fn();
    const sandbox = { ...passthroughSandbox, prepareCommand };

    await expect(bashToolRun({ command: /** @type {any} */ (null) }, { ctx: { workspace, sandbox } }))
      .resolves.toMatchObject({ error: true, outcome: { code: "invalid_command" } });
    await expect(bashToolRun({ command: "printf\0unsafe" }, { ctx: { workspace, sandbox } }))
      .resolves.toMatchObject({ error: true, outcome: { code: "invalid_command" } });
    expect(prepareCommand).not.toHaveBeenCalled();
  });

  it("uses exact timeout_ms semantics and preserves partial shell output", async () => {
    const workspace = tempWorkspace();
    const result = await bashToolRun({
      command: `${JSON.stringify(process.execPath)} --eval "console.log('started'); setTimeout(() => {}, 5000)"`,
      // Same startup race as the Exec case above: the assertion needs the child's line, so the
      // budget must clear Node's boot time while staying well under the 5s sleep.
      timeout_ms: 1000,
    }, options(workspace));

    expect(result.text).toContain("started");
    expect(result).toMatchObject({
      error: true,
      outcome: {
        status: "error",
        code: "timeout",
        timedOut: true,
        legacyTimeoutUsed: false,
      },
    });
  });

  it("does not import parent Bash functions or startup option variables", async () => {
    const workspace = tempWorkspace();
    const functionKey = "BASH_FUNC_mono_agent_parent_fn%%";
    const originalFunction = process.env[functionKey];
    const originalShellopts = process.env.SHELLOPTS;
    process.env[functionKey] = "() { printf inherited; }";
    process.env.SHELLOPTS = "braceexpand:hashall:interactive-comments";
    try {
      const result = await bashToolRun({
        command: "if type mono_agent_parent_fn >/dev/null 2>&1; then exit 9; fi; printf clean",
      }, options(workspace));
      expect(result).toMatchObject({ error: false, outcome: { code: "ok" } });
      expect(result.text).toBe("clean");
    } finally {
      if (originalFunction === undefined) delete process.env[functionKey];
      else process.env[functionKey] = originalFunction;
      if (originalShellopts === undefined) delete process.env.SHELLOPTS;
      else process.env.SHELLOPTS = originalShellopts;
    }
  });

  it("emits one legacy-timeout warning and omits commands from raw result details", async () => {
    const workspace = tempWorkspace();
    const events = [];
    const bash = getPiBuiltinTools(["Bash"], {
      cwd: workspace,
      onEvent: (event) => events.push(event),
      ctx: { workspace, sandbox: passthroughSandbox },
    }).find((tool) => tool.name === "Bash");
    const result = await bash.execute("bash-1", {
      command: "printf safe",
      timeout: 1,
    });

    expect(result.content[0].text).toBe("safe");
    expect(result.details).toMatchObject({
      tool: "Bash",
      outcome: { status: "ok", legacyTimeoutUsed: true },
    });
    expect(result.details).not.toHaveProperty("params");
    expect(events).toEqual([expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "deprecated_bash_timeout",
    })]);
  });

  it("marks Exec and stateful tools sequential while safe read-only tools may overlap", () => {
    const safe = getPiBuiltinTools(["Read", "WebFetch", "Bash", "Exec"], {
      toolExecutionMode: "safe-parallel",
    });
    expect(safe.find((tool) => tool.name === "Read").executionMode).toBeUndefined();
    expect(safe.find((tool) => tool.name === "WebFetch").executionMode).toBeUndefined();
    expect(safe.find((tool) => tool.name === "Bash").executionMode).toBe("sequential");
    expect(safe.find((tool) => tool.name === "Exec").executionMode).toBe("sequential");

    const sequential = getPiBuiltinTools(["Read", "WebFetch"], {
      toolExecutionMode: "sequential",
    });
    expect(sequential.every((tool) => tool.executionMode === "sequential")).toBe(true);
  });
});

async function waitForPath(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function inheritedProcessTreeSource() {
  return [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ target: process.pid, descendant: child.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

function readProcessTree(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(value?.target) || value.target <= 0
    || !Number.isSafeInteger(value?.descendant) || value.descendant <= 0) {
    throw new Error("Process-tree fixture did not publish valid PIDs.");
  }
  return value;
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch { return; }
    if (Date.now() >= deadline) throw new Error(`Process ${String(pid)} did not exit.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${String(timeoutMs)}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

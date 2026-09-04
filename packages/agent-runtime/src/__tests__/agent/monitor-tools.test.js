import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { monitorStopToolRun, monitorToolRun } from "../../agent/tools/index.js";
import { getPiBuiltinTools } from "../../agent/tools/pi-bridge.js";

const tempDirs = [];
const NUL = String.fromCharCode(0);

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-monitor-"));
  tempDirs.push(dir);
  return dir;
}

function options(workspace, monitorsController) {
  return { ctx: { workspace, sandbox: passthroughSandbox }, monitorsController };
}

function startedResult(overrides = {}) {
  return {
    monitorId: "mon-1",
    state: "running",
    startedAt: new Date().toISOString(),
    maxRuntimeMs: 300_000,
    persistent: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("Monitor tool registration", () => {
  it("registers neither tool without a controller and both with one", () => {
    const withoutController = getPiBuiltinTools(["Monitor", "MonitorStop", "Bash"]);
    expect(withoutController.map((tool) => tool.name)).toEqual(["Bash"]);

    const withController = getPiBuiltinTools(["Monitor", "MonitorStop", "Bash"], {
      monitorsController: { start: vi.fn(), stop: vi.fn() },
    });
    expect(withController.map((tool) => tool.name).sort()).toEqual(["Bash", "Monitor", "MonitorStop"]);
  });

  it("states the host ceilings in the schema when the controller publishes limits", () => {
    const tools = getPiBuiltinTools(["Monitor"], {
      monitorsController: {
        start: vi.fn(),
        stop: vi.fn(),
        limits: {
          maxRuntimeMs: 3_600_000,
          persistentMaxRuntimeMs: 43_200_000,
          maxActivePerConversation: 3,
        },
      },
    });
    const monitor = tools.find((tool) => tool.name === "Monitor");
    expect(monitor.parameters.required.sort()).toEqual(["command", "description"]);
    expect(monitor.parameters.properties.timeout_ms.minimum).toBe(1_000);
    expect(monitor.parameters.properties.timeout_ms.description).toContain("1h (3600000 ms)");
    expect(monitor.parameters.properties.persistent.description).toContain("12h (43200000 ms)");
    expect(monitor.description).toContain("3 monitors at once");
  });

  it("omits an unstated ceiling instead of inventing one", () => {
    const tools = getPiBuiltinTools(["Monitor"], {
      monitorsController: { start: vi.fn(), stop: vi.fn() },
    });
    const monitor = tools.find((tool) => tool.name === "Monitor");
    expect(monitor.parameters.properties.timeout_ms.description).toContain("5m (300000 ms)");
    expect(monitor.parameters.properties.timeout_ms.description).not.toContain("This host allows");
    expect(monitor.description).not.toContain("monitors at once");
  });

  it("runs Monitor sequentially and keeps its parameters out of tool details", async () => {
    const workspace = tempWorkspace();
    const start = vi.fn(async () => startedResult());
    const tools = getPiBuiltinTools(["Monitor", "MonitorStop"], {
      cwd: workspace,
      ctx: { workspace, sandbox: passthroughSandbox },
      monitorsController: { start, stop: vi.fn() },
    });
    const monitor = tools.find((tool) => tool.name === "Monitor");
    expect(monitor.executionMode).toBe("sequential");
    expect(tools.find((tool) => tool.name === "MonitorStop").executionMode).toBe("sequential");

    const result = await monitor.execute("call-1", {
      command: "tail -f /dev/null",
      description: "Watching a placeholder stream",
    });
    expect(result.details.params).toBeUndefined();
    expect(result.details.tool).toBe("Monitor");
  });
});

describe("Monitor hand-off", () => {
  it("prepares the command exactly like Bash and returns a receipt without waiting", async () => {
    const workspace = tempWorkspace();
    const start = vi.fn(async () => startedResult({ maxRuntimeMs: 120_000 }));
    const result = await monitorToolRun(
      { command: "echo hi", description: "Watching a probe" },
      options(workspace, { start, stop: vi.fn() }),
    );

    expect(result.error).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0][0];
    expect(request.prepared.command).toBe("/bin/bash");
    expect(request.prepared.args).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
    expect(request.prepared.cwd).toBe(workspace);
    expect(request.prepared.env.BASH_ENV).toBe("/dev/null");
    expect(request.summary).not.toContain("echo hi");
    expect(request.timeoutMs).toBe(300_000);
    expect(request.persistent).toBe(false);

    const payload = JSON.parse(result.text.slice(result.text.indexOf("\n") + 1));
    expect(payload).toEqual({
      monitor_id: "mon-1",
      state: "running",
      started_at: expect.any(String),
      max_runtime_ms: 120_000,
      persistent: false,
    });
    expect(result.text).toContain("Do not poll it");
    expect(result.outcome.code).toBe("monitor_started");
  });

  it("omits the timeout entirely for a persistent watch", async () => {
    const workspace = tempWorkspace();
    const start = vi.fn(async () => startedResult({ maxRuntimeMs: 0, persistent: true }));
    await monitorToolRun(
      { command: "tail -f x", description: "Watching x", persistent: true, timeout_ms: 5_000 },
      options(workspace, { start, stop: vi.fn() }),
    );
    const request = start.mock.calls[0][0];
    expect(request.timeoutMs).toBeUndefined();
    expect(request.persistent).toBe(true);
  });

  it("clamps a below-minimum timeout to one second", async () => {
    const workspace = tempWorkspace();
    const start = vi.fn(async () => startedResult());
    await monitorToolRun(
      { command: "x", description: "Watching x", timeout_ms: 5 },
      options(workspace, { start, stop: vi.fn() }),
    );
    expect(start.mock.calls[0][0].timeoutMs).toBe(1_000);
  });

  it("requires a description and refuses a NUL command", async () => {
    const workspace = tempWorkspace();
    const controller = { start: vi.fn(), stop: vi.fn() };
    const missing = await monitorToolRun({ command: "x" }, options(workspace, controller));
    expect(missing.error).toBe(true);
    expect(missing.outcome.code).toBe("monitor_invalid");
    const nul = await monitorToolRun(
      { command: `x${NUL}y`, description: "Watching x" },
      options(workspace, controller),
    );
    expect(nul.error).toBe(true);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("refuses a workdir outside the workspace", async () => {
    const workspace = tempWorkspace();
    const controller = { start: vi.fn(), stop: vi.fn() };
    const result = await monitorToolRun(
      { command: "x", description: "Watching x", workdir: "/etc" },
      options(workspace, controller),
    );
    expect(result.error).toBe(true);
    expect(result.outcome.code).toBe("workdir_denied");
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("maps a controller failure code to its stable public message", async () => {
    const workspace = tempWorkspace();
    const start = vi.fn(async () => {
      throw Object.assign(new Error("internal detail that must not leak"), {
        code: "monitor_conversation_capacity",
      });
    });
    const result = await monitorToolRun(
      { command: "x", description: "Watching x" },
      options(workspace, { start, stop: vi.fn() }),
    );
    expect(result.error).toBe(true);
    expect(result.outcome.code).toBe("monitor_conversation_capacity");
    expect(result.text).toBe("Error: This conversation reached its monitor capacity.");
    expect(result.text).not.toContain("internal detail");
  });

  it("rejects a malformed controller start result", async () => {
    const workspace = tempWorkspace();
    const result = await monitorToolRun(
      { command: "x", description: "Watching x" },
      options(workspace, { start: async () => ({ monitorId: "" }), stop: vi.fn() }),
    );
    expect(result.error).toBe(true);
    expect(result.outcome.code).toBe("monitor_controller_invalid");
  });
});

describe("MonitorStop", () => {
  it("reports a stop it actually requested", async () => {
    const stop = vi.fn(async () => ({ monitorId: "mon-1", state: "running", stopped: true }));
    const result = await monitorStopToolRun({ monitor_id: "mon-1" }, { monitorsController: { start: vi.fn(), stop } });
    expect(result.error).toBe(false);
    expect(result.text).toContain("one final wake");
    expect(JSON.parse(result.text.slice(result.text.indexOf("\n") + 1))).toEqual({
      monitor_id: "mon-1",
      state: "running",
      stopped: true,
    });
  });

  it("treats an already-terminal monitor as an idempotent success", async () => {
    const stop = vi.fn(async () => ({ monitorId: "mon-1", state: "exited", stopped: false }));
    const result = await monitorStopToolRun({ monitor_id: "mon-1" }, { monitorsController: { start: vi.fn(), stop } });
    expect(result.error).toBe(false);
    expect(result.outcome.code).toBe("monitor_stop_accepted");
    expect(result.text).toContain("already in a terminal state");
    expect(result.text).toContain("This is a success, not a failure.");
  });

  it("rejects a missing or oversized id before reaching the controller", async () => {
    const stop = vi.fn();
    const controller = { start: vi.fn(), stop };
    expect((await monitorStopToolRun({}, { monitorsController: controller })).outcome.code).toBe("monitor_invalid");
    expect((await monitorStopToolRun({ monitor_id: "x".repeat(257) }, { monitorsController: controller })).outcome.code)
      .toBe("monitor_invalid");
    expect(stop).not.toHaveBeenCalled();
  });

  it("errors without a controller instead of silently succeeding", async () => {
    const result = await monitorStopToolRun({ monitor_id: "mon-1" }, {});
    expect(result.error).toBe(true);
    expect(result.outcome.code).toBe("monitor_unsupported");
  });
});

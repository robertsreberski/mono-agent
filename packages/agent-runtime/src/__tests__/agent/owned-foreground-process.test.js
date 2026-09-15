import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execToolRun } from "../../agent/tools/exec.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { bashToolRun } from "../../agent/tools/bash.js";
import { runOwnedForegroundProcess } from "../../agent/tools/shared/owned-foreground-process.js";
import { configureToolRuntime, resetToolRuntime } from "../../agent/tools/shared/runtime-context.js";
import { buildTurnTools } from "../../ai/providers/pi-native/turn-runner.js";

const roots = [];
afterEach(async () => {
  resetToolRuntime();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(resolve(process.cwd(), ".owned-foreground-test-"));
  roots.push(root);
  configureToolRuntime({ workspace: root });
  return root;
}
const result = (patch = {}) => ({ code: 0, signal: null, stdout: "checked", stderr: "", aborted: false,
  timedOut: false, bufferExceeded: false, truncated: false, bytes: 7, storedBytes: 7,
  spawnError: null, durationMs: 1, groupExitConfirmed: true, ...patch });

describe("awaited owned foreground command seam", () => {
  it.each([["Exec", execToolRun, { executable: process.execPath, args: ["-e", "process.exit(0)"] }],
    ["Bash", bashToolRun, { command: "printf checked" }]])("keeps %s foreground results, identities and limits while transferring ownership", async (tool, run, params) => {
    const root = await workspace();
    const controller = { run: vi.fn(async (request) => { await request.prepared.cleanup(); return result(); }) };
    const value = await run({ ...params, workdir: root, timeout_ms: 180_000 }, {
      toolCallId: "host-call", ownedForegroundProcessController: controller, toolLimits: { bashTimeoutMs: 180_000 },
    });
    expect(value.text).toContain("checked");
    expect(value.outcome).toMatchObject({ status: "ok", exitCode: 0 });
    expect(value.outcome.background).toBeUndefined();
    expect(controller.run).toHaveBeenCalledOnce();
    expect(controller.run.mock.calls[0][0]).toMatchObject({ callId: "host-call", tool, timeoutMs: 180_000, prepared: { cwd: root } });
  });

  it("passes the controller and host call id through the actual Pi turn tool builder", async () => {
    const root = await workspace();
    const run = vi.fn(async (request) => { await request.prepared.cleanup(); return result(); });
    const forAttempt = vi.fn(() => ({ run }));
    const built = await buildTurnTools({}, { options: {
      allowedTools: ["Exec"], cwd: root, ownedForegroundProcesses: { forAttempt }, mcpServers: {},
    }, capabilities: { tool_use: true }, toolLimits: { bashTimeoutMs: 180_000 },
    runtime: { model: { id: "fake" } }, resolved: { model: "fake" }, onEvent() {}, runtimeWarnings: [] });
    try {
      const tool = built.tools.find((tool) => tool.name === "Exec");
      expect(tool.parameters.properties.background).toBeDefined();
      await tool.execute("pi-host-call", { executable: process.execPath, workdir: root });
      expect(forAttempt).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][0]).toMatchObject({ callId: "pi-host-call", prepared: { cwd: root } });
    } finally { await built.closeRunTools(); }
  });

  it("does not fall back or prematurely clean when the owner rejects with unresolved cleanup", async () => {
    const root = await workspace();
    const marker = resolve(root, "must-not-run");
    const controller = { run: vi.fn(async () => { throw new Error("private host failure"); }) };
    const cleanup = vi.fn(async () => {});
    const ctx = { workspace: root, sandbox: { ...passthroughSandbox, prepareCommand: async ({ command }) => ({ ...command, sandboxed: false, cleanup }) } };
    const value = await execToolRun({ executable: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong')`], workdir: root },
    { ownedForegroundProcessController: controller, toolCallId: "call", ctx });
    expect(value).toMatchObject({ error: true, outcome: { code: "owned_process_unavailable" } });
    expect(value.text).not.toContain("private host failure");
    expect(existsSync(marker)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("rejects missing/oversized host identity and cleans prepared state without handing off", async () => {
    const cleanup = vi.fn(async () => {});
    const run = vi.fn();
    for (const callId of [undefined, "", "é".repeat(129)]) {
      await expect(runOwnedForegroundProcess({ controller: { run }, tool: "Exec", callId,
        timeoutMs: 1, prepared: { command: "unused", args: [], cwd: process.cwd(), sandboxed: false, cleanup },
      })).rejects.toThrow(/identity/);
    }
    expect(run).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it("uses a one-shot real gated process and idempotent host cleanup", async () => {
    const root = await workspace();
    const marker = resolve(root, "released");
    const cleanup = vi.fn(async () => {});
    const value = await runOwnedForegroundProcess({ tool: "Exec", callId: "gated", timeoutMs: 5_000,
      prepared: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'); process.stdout.write('checked')`],
        cwd: root, sandboxed: false, cleanup },
      controller: { async run(request) {
        const handle = request.launch();
        expect(existsSync(marker)).toBe(false);
        expect(handle.pid).toBe(handle.pgid);
        expect(() => request.launch()).toThrow(/already launched/);
        try { await handle.release(); return await handle.completion; }
        finally { await request.prepared.cleanup(); await request.prepared.cleanup(); }
      } },
    });
    expect(value).toMatchObject({ code: 0, stdout: "checked", groupExitConfirmed: true });
    expect(await readFile(marker, "utf8")).toBe("done");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not report an exit-zero command as successful when group cleanup is unknown", async () => {
    const root = await workspace();
    const value = await execToolRun({ executable: process.execPath, workdir: root }, {
      toolCallId: "unknown", ownedForegroundProcessController: { run: async () => result({ groupExitConfirmed: false }) },
    });
    expect(value).toMatchObject({ error: true, outcome: { code: "owned_process_unavailable" } });
  });

  it.each([{ timedOut: true, code: null }, { aborted: true, code: null }, { code: 7 }])("preserves actual command failure: %j", async (patch) => {
    const root = await workspace();
    const value = await execToolRun({ executable: process.execPath, workdir: root }, {
      toolCallId: "failure", ownedForegroundProcessController: { run: async (request) => {
        await request.prepared.cleanup(); return result(patch);
      } },
    });
    expect(value.error).toBe(true);
    expect(value.outcome.exitCode).toBe(patch.code);
    expect(value.outcome.timedOut).toBe(patch.timedOut === true);
  });
});

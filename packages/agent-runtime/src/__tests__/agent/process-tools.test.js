import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { bashToolRun, execToolRun } from "../../agent/tools/index.js";
import { getPiBuiltinTools } from "../../agent/tools/pi-bridge.js";

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

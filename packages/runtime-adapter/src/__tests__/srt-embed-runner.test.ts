import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The embed runner is the parent of every sandboxed command, including every
 * stdio MCP server. mono-agent#669: it forwarded a signal to its child once and
 * never escalated, so a child that did not act on SIGTERM outlived the run —
 * the MCP stdio client SIGKILLs *this* process 2s after its SIGTERM, and a
 * SIGKILL here runs no handlers. Five MCP servers were orphaned to init that
 * way in one day, each reaped by hand.
 *
 * These drive the real runner as a subprocess against a stub SRT entry, because
 * the defect is entirely in process lifecycle: nothing about it is observable
 * from the module's exports.
 */

const RUNNER = fileURLToPath(new URL("../srt-embed-runner.mjs", import.meta.url));

// The runner refuses to launch on darwin unless SRT emitted the
// unrestricted-network profile marker, then rewrites that marker in place. The
// stub therefore has to carry it somewhere a shell will still parse afterwards:
// `:` is a no-op builtin, and the marker sits inside a single-quoted argument,
// so the multi-line rewrite stays one token.
const STUB_SRT = `
export const SandboxManager = {
  async initialize() {},
  async wrapWithSandbox(command) {
    return ": '(allow network*)' ; " + command;
  },
  cleanupAfterCommand() {},
};
`;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "srt-embed-runner-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runnerFixture(commandSource: string): Promise<{
  readonly entry: string;
  readonly settings: string;
  readonly script: string;
  readonly pidFile: string;
}> {
  const entry = join(workDir, "stub-srt.mjs");
  const settings = join(workDir, "settings.json");
  const script = join(workDir, "command.mjs");
  const pidFile = join(workDir, "pids.txt");
  await writeFile(entry, STUB_SRT, "utf8");
  await writeFile(settings, JSON.stringify({ filesystem: {} }), "utf8");
  await writeFile(script, commandSource, "utf8");
  return { entry, settings, script, pidFile };
}

function startRunner(entry: string, settings: string, command: readonly string[]) {
  const child = spawn(process.execPath, [RUNNER, entry, "--settings", settings, "--", ...command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stderr: () => stderr };
}

async function waitForPids(pidFile: string, count: number, budgetMs = 10_000): Promise<number[]> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    try {
      const pids = (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      if (pids.length >= count) return pids;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`command never reported ${count} pid(s)`);
}

async function waitForPid(pidFile: string): Promise<number> {
  const [pid] = await waitForPids(pidFile, 1);
  if (pid === undefined) throw new Error("command reported no pid");
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function settle(pid: number, budgetMs = 5_000): Promise<boolean> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (!alive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return alive(pid);
}

// A command that reports its pid and then refuses to die politely — the shape
// the orphaned MCP servers had, where SIGTERM arrived and nothing happened.
const IGNORES_SIGTERM = (pidFile: string) => `
import { appendFileSync } from "node:fs";
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
setInterval(() => {}, 1000);
`;

describe("srt-embed-runner child reaping", () => {
  it("escalates to SIGKILL when the child ignores the forwarded signal", async () => {
    const { entry, settings, script, pidFile } = await runnerFixture("");
    await writeFile(script, IGNORES_SIGTERM(pidFile), "utf8");
    const { child, exited } = startRunner(entry, settings, [process.execPath, script]);

    const commandPid = await waitForPid(pidFile);
    expect(alive(commandPid)).toBe(true);

    child.kill("SIGTERM");

    // The grace is 1s; the MCP stdio client would SIGKILL the runner at 2s.
    expect(await settle(commandPid)).toBe(false);
    await exited;
  }, 30_000);

  it("reaps a grandchild the command spawned, not just the command", async () => {
    // `shell: true` and SRT's own wrapper both put processes between the runner
    // and the real command, so signalling the direct child alone is not enough.
    const { entry, settings, script, pidFile } = await runnerFixture("");
    const grandchild = join(workDir, "grandchild.mjs");
    await writeFile(grandchild, IGNORES_SIGTERM(pidFile), "utf8");
    await writeFile(
      script,
      `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const { child, exited } = startRunner(entry, settings, [process.execPath, script]);

    const pids = await waitForPids(pidFile, 2);
    child.kill("SIGTERM");

    for (const pid of pids) {
      expect(await settle(pid), `pid ${pid} survived the escalation`).toBe(false);
    }
    await exited;
  }, 30_000);

  it("handles SIGHUP the same way", async () => {
    // A hangup used to tear down the runner while leaving the child behind.
    const { entry, settings, script, pidFile } = await runnerFixture("");
    await writeFile(script, IGNORES_SIGTERM(pidFile), "utf8");
    const { child, exited } = startRunner(entry, settings, [process.execPath, script]);

    const commandPid = await waitForPid(pidFile);
    child.kill("SIGHUP");

    expect(await settle(commandPid)).toBe(false);
    await exited;
  }, 30_000);

  it("lets a well-behaved child shut itself down instead of killing it", async () => {
    // The escalation must not convert clean shutdowns into kills: a command that
    // handles SIGTERM has to reach its own teardown code first.
    const { entry, settings, script, pidFile } = await runnerFixture("");
    const marker = join(workDir, "graceful.txt");
    await writeFile(
      script,
      `
import { appendFileSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(marker)}, "graceful");
  process.exit(0);
});
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const { child, exited } = startRunner(entry, settings, [process.execPath, script]);

    const commandPid = await waitForPid(pidFile);
    child.kill("SIGTERM");
    await exited;

    expect(await readFile(marker, "utf8")).toBe("graceful");
    expect(alive(commandPid)).toBe(false);
  }, 30_000);

  it("still reports an ordinary exit code with no signal involved", async () => {
    const { entry, settings, script } = await runnerFixture("");
    await writeFile(script, "process.exit(3);\n", "utf8");
    const { exited } = startRunner(entry, settings, [process.execPath, script]);

    const result = await exited;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(3);
  }, 30_000);
});

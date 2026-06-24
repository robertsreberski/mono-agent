import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-repo-guard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runCli repo-guard scan", () => {
  it("returns nonzero findings for tracked local files without printing matched values", async () => {
    const cwd = await tempDir();
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "tracked.md"), "hello local-agent-alpha\n", "utf8");
    await execFileAsync("git", ["add", "tracked.md"], { cwd });

    const result = await captureCli(() =>
      withCwd(cwd, () =>
        withCleanMonoAgentEnv(async () => {
          process.env.MONO_AGENT_REPO_VISIBLE_DENYLIST = JSON.stringify([
            { label: "agent-name", value: "local-agent-alpha" },
          ]);
          return await runCli(["repo-guard", "scan"]);
        }),
      ),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Repo-visible guard scan");
    expect(result.stdout).toContain("label=agent-name");
    expect(result.stdout).not.toContain("local-agent-alpha");
    expect(result.stderr).toBe("");
  });

  it("requires a repo when GitHub metadata scanning is requested", async () => {
    const result = await captureCli(() => withCleanMonoAgentEnv(() => runCli(["repo-guard", "scan", "--github"])));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--repo owner/name is required");
  });
});

async function captureCli(run: () => Promise<number>): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    return { code: await run(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function withCleanMonoAgentEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      previous.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of previous) {
      process.env[key] = value;
    }
  }
}

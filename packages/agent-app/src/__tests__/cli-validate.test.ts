import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";

let dir: string;
let previousCwd: string;
let previousMonoAgentEnv: Map<string, string>;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "agent-app-cli-validate-")));
  previousCwd = process.cwd();
  previousMonoAgentEnv = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      previousMonoAgentEnv.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      delete process.env[key];
    }
  }
  for (const [key, value] of previousMonoAgentEnv) {
    process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeConsumerConfig(
  consumerDir: string,
  fileName: string,
  json: Record<string, unknown>,
): Promise<string> {
  const configPath = join(consumerDir, fileName);
  await writeFile(configPath, JSON.stringify(json, null, 2), "utf8");
  return configPath;
}

async function captureRunCli(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
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
    const code = await runCli(argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe("runCli validate --consumer", () => {
  it("loads the consumer .env and config without changing the current directory", async () => {
    const invocationDir = join(dir, "invocation");
    const consumerDir = join(dir, "consumer");
    await mkdir(invocationDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(invocationDir, ".env"), "MONO_AGENT_MODEL=not-a-valid-model\n", "utf8");
    await writeFile(join(consumerDir, ".env"), "MONO_AGENT_MODEL=codex:gpt-5.5\n", "utf8");
    await writeFile(join(consumerDir, "IDENTITY.md"), "# Consumer\n", "utf8");
    await writeConsumerConfig(consumerDir, "mono-agent.config.json", {
      context: { identityPath: "./IDENTITY.md" },
    });

    process.chdir(invocationDir);

    const result = await captureRunCli(["validate", "--consumer", "../consumer"]);

    expect(result.code).toBe(0);
    expect(process.cwd()).toBe(invocationDir);
    expect(result.stdout).toContain(`Loaded ${join(consumerDir, "mono-agent.config.json")}.`);
    expect(result.stdout).toContain("Primary model codex:gpt-5.5");
    expect(result.stderr).toBe("");
  });

  it("resolves --config inside the consumer folder", async () => {
    const invocationDir = join(dir, "invocation");
    const consumerDir = join(dir, "consumer");
    await mkdir(invocationDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(consumerDir, ".env"), "MONO_AGENT_MODEL=codex:gpt-5.5\n", "utf8");
    await writeFile(join(consumerDir, "IDENTITY.alt.md"), "# Consumer\n", "utf8");
    const configPath = await writeConsumerConfig(consumerDir, "alternate.config.json", {
      context: { identityPath: "./IDENTITY.alt.md" },
    });

    process.chdir(invocationDir);

    const result = await captureRunCli(["validate", "--consumer", "../consumer", "--config", "alternate.config.json"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Loaded ${configPath}.`);
    expect(result.stderr).toBe("");
  });

  it("does not create missing consumer memory roots", async () => {
    const invocationDir = join(dir, "invocation");
    const consumerDir = join(dir, "consumer");
    const memoryDir = join(consumerDir, "missing-memory");
    await mkdir(invocationDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(consumerDir, "IDENTITY.md"), "# Consumer\n", "utf8");
    await writeConsumerConfig(consumerDir, "mono-agent.config.json", {
      runtime: { model: "codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "lite",
        path: "./missing-memory",
        writeMode: "append-host-summary",
      },
    });

    process.chdir(invocationDir);

    const result = await captureRunCli(["validate", "--consumer", "../consumer"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Consumer validation is read-only and did not create it");
    expect(await pathExists(memoryDir)).toBe(false);
  });
});

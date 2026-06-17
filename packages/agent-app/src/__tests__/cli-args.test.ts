import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCliEnvFile, parseCliArgs } from "../cli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cli-args-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseCliArgs", () => {
  it("parses init with model, fallbacks, and memory", () => {
    expect(
      parseCliArgs([
        "init",
        "--model",
        "claude:claude-sonnet-4-6",
        "--fallback-models",
        "pi:ollama:gemma4:31b, codex:gpt-5.5",
        "--memory",
        "journal",
      ]),
    ).toEqual({
      command: "init",
      model: "claude:claude-sonnet-4-6",
      fallbackModels: ["pi:ollama:gemma4:31b", "codex:gpt-5.5"],
      memory: "journal",
      force: false,
      foreground: false,
      follow: false,
    });
  });

  it("parses start with config and env file", () => {
    expect(
      parseCliArgs(["start", "--config", "agent.json", "--env-file", ".env.local"]),
    ).toEqual({
      command: "start",
      configPath: "agent.json",
      envFile: ".env.local",
      force: false,
      foreground: false,
      follow: false,
    });
  });

  it("parses start --foreground and -f as the blocking worker", () => {
    expect(parseCliArgs(["start", "--foreground"])).toMatchObject({ command: "start", foreground: true });
    expect(parseCliArgs(["start", "-f"])).toMatchObject({ command: "start", foreground: true });
    expect(parseCliArgs(["start"])).toMatchObject({ command: "start", foreground: false });
  });

  it("parses the background control commands with --config", () => {
    for (const command of ["restart", "stop", "status"] as const) {
      expect(parseCliArgs([command, "--config", "agent.json"])).toMatchObject({ command, configPath: "agent.json" });
    }
  });

  it("parses logs follow and lines, with -f meaning follow", () => {
    expect(parseCliArgs(["logs", "--follow"])).toMatchObject({ command: "logs", follow: true });
    expect(parseCliArgs(["logs", "-f"])).toMatchObject({ command: "logs", follow: true });
    expect(parseCliArgs(["logs", "--lines", "200"])).toMatchObject({ command: "logs", lines: 200, follow: false });
    expect(parseCliArgs(["logs"])).toMatchObject({ command: "logs", follow: false });
    expect(parseCliArgs(["logs"]).lines).toBeUndefined();
    expect(() => parseCliArgs(["logs", "--lines", "x"])).toThrow(/--lines/u);
    expect(() => parseCliArgs(["logs", "--lines", "0"])).toThrow(/--lines/u);
  });

  it("parses install-skill with target and force", () => {
    expect(parseCliArgs(["install-skill", "--target", "codex", "--force"])).toEqual({
      command: "install-skill",
      target: "codex",
      force: true,
      foreground: false,
      follow: false,
    });
    expect(parseCliArgs(["install-skill"])).toMatchObject({ command: "install-skill", force: false });
    expect(() => parseCliArgs(["install-skill", "--target", "browser"])).toThrow(/--target/u);
  });

  it("defaults to help and rejects unknown commands and flags", () => {
    expect(parseCliArgs([]).command).toBe("help");
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(() => parseCliArgs(["serve"])).toThrow(/Unknown command/u);
    expect(() => parseCliArgs(["start", "--what"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["start", "--port", "4100"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["init", "--memory", "vector"])).toThrow(/--memory/u);
  });

  it("accepts --memory bujo and --memory lite, rejects --memory markdown", () => {
    const bujoResult = parseCliArgs(["init", "--memory", "bujo"]);
    expect(bujoResult.command).toBe("init");
    expect(bujoResult.memory).toBe("bujo");

    const liteResult = parseCliArgs(["init", "--memory", "lite"]);
    expect(liteResult.command).toBe("init");
    expect(liteResult.memory).toBe("lite");

    expect(() => parseCliArgs(["init", "--memory", "markdown"])).toThrow(/--memory must be lite, journal, or bujo/u);
  });
});

describe("loadCliEnvFile", () => {
  it("loads vars from the file without overwriting exported ones, and ignores missing files", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      "MONO_AGENT_TEST_ENV_FILE_FRESH=from-file\nMONO_AGENT_TEST_ENV_FILE_PRESET=from-file\n",
      "utf8",
    );
    process.env.MONO_AGENT_TEST_ENV_FILE_PRESET = "from-shell";
    delete process.env.MONO_AGENT_TEST_ENV_FILE_FRESH;
    try {
      expect(loadCliEnvFile(envPath)).toBe(true);
      expect(process.env.MONO_AGENT_TEST_ENV_FILE_FRESH).toBe("from-file");
      expect(process.env.MONO_AGENT_TEST_ENV_FILE_PRESET).toBe("from-shell");
      expect(loadCliEnvFile(join(dir, "missing.env"))).toBe(false);
    } finally {
      delete process.env.MONO_AGENT_TEST_ENV_FILE_FRESH;
      delete process.env.MONO_AGENT_TEST_ENV_FILE_PRESET;
    }
  });
});

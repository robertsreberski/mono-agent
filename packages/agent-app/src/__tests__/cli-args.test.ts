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
      noConsole: false,
      force: false,
    });
  });

  it("parses start with config, port, env file, and --no-console", () => {
    expect(
      parseCliArgs(["start", "--config", "agent.json", "--port", "4100", "--no-console", "--env-file", ".env.local"]),
    ).toEqual({
      command: "start",
      configPath: "agent.json",
      port: 4100,
      envFile: ".env.local",
      noConsole: true,
      force: false,
    });
  });

  it("parses install-skill with target and force", () => {
    expect(parseCliArgs(["install-skill", "--target", "codex", "--force"])).toEqual({
      command: "install-skill",
      target: "codex",
      noConsole: false,
      force: true,
    });
    expect(parseCliArgs(["install-skill"])).toMatchObject({ command: "install-skill", force: false });
    expect(() => parseCliArgs(["install-skill", "--target", "browser"])).toThrow(/--target/u);
  });

  it("defaults to help and rejects unknown commands and flags", () => {
    expect(parseCliArgs([]).command).toBe("help");
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(() => parseCliArgs(["serve"])).toThrow(/Unknown command/u);
    expect(() => parseCliArgs(["start", "--what"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["start", "--port", "no"])).toThrow(/--port/u);
    expect(() => parseCliArgs(["init", "--memory", "vector"])).toThrow(/--memory/u);
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

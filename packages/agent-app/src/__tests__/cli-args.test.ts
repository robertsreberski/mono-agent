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
      positionals: [],
      force: false,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
    });
  });

  it("parses start with config and env file", () => {
    expect(
      parseCliArgs(["start", "--config", "agent.json", "--env-file", ".env.local"]),
    ).toEqual({
      command: "start",
      configPath: "agent.json",
      envFile: ".env.local",
      positionals: [],
      force: false,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
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
      positionals: [],
      force: true,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
    });
    expect(parseCliArgs(["install-skill"])).toMatchObject({ command: "install-skill", force: false });
    expect(() => parseCliArgs(["install-skill", "--target", "browser"])).toThrow(/--target/u);
  });

  it("parses backfill flags (--run/--all/--since/--until/--dry-run)", () => {
    expect(parseCliArgs(["backfill", "--all", "--dry-run"])).toMatchObject({
      command: "backfill",
      all: true,
      dryRun: true,
    });
    expect(
      parseCliArgs(["backfill", "--run", "run-x", "--since", "2026-06-01", "--until", "2026-06-30"]),
    ).toMatchObject({
      command: "backfill",
      run: "run-x",
      since: "2026-06-01",
      until: "2026-06-30",
      all: false,
      dryRun: false,
    });
  });

  it("parses audit-runs flags", () => {
    expect(
      parseCliArgs(["audit-runs", "--artifact-dir", "./runs", "--stale-after-ms", "1234", "--json"]),
    ).toMatchObject({
      command: "audit-runs",
      artifactDir: "./runs",
      staleAfterMs: 1234,
      json: true,
    });
    expect(
      parseCliArgs(["audit-runs", "--consumer", "../personal-agent", "--config", "agent.config.json"]),
    ).toMatchObject({
      command: "audit-runs",
      consumerPath: "../personal-agent",
      configPath: "agent.config.json",
    });
    expect(() => parseCliArgs(["audit-runs", "--stale-after-ms", "0"])).toThrow(/--stale-after-ms/u);
  });

  it("parses validate --consumer and keeps it validate/audit-runs scoped", () => {
    expect(parseCliArgs(["validate", "--consumer", "../personal-agent"])).toMatchObject({
      command: "validate",
      consumerPath: "../personal-agent",
    });
    expect(() => parseCliArgs(["validate", "--consumer"])).toThrow(/--consumer requires a value/u);
    expect(() => parseCliArgs(["start", "--consumer", "../personal-agent"])).toThrow(/--consumer/u);
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

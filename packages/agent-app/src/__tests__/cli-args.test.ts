import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeChannelStatus, loadCliEnvFile, monoAgentVersion, parseCliArgs, renderHelp } from "../cli.js";

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
  it("parses init with model, fallbacks, effort, and memory", () => {
    expect(
      parseCliArgs([
        "init",
        "--model",
        "claude:claude-sonnet-4-6",
        "--fallback-models",
        "pi:ollama:gemma4:31b, codex:gpt-5.5",
        "--auth",
        "--effort",
        "high",
        "--memory",
        "journal",
      ]),
    ).toEqual({
      command: "init",
      model: "claude:claude-sonnet-4-6",
      fallbackModels: ["pi:ollama:gemma4:31b", "codex:gpt-5.5"],
      auth: true,
      effort: "high",
      memory: "journal",
      positionals: [],
      force: false,
      foreground: false,
      follow: false,
      all: false,
      dryRun: false,
      includeMemory: false,
    });
  });

  it("normalizes setup to init and parses its preset/channel/dry-run flags", () => {
    expect(parseCliArgs(["setup", "--preset", "starter", "--with", "slack,cron", "--dry-run"])).toMatchObject({
      command: "init",
      preset: "starter",
      withChannels: ["slack", "cron"],
      dryRun: true,
    });
  });

  it("treats doctor as an alias of validate", () => {
    expect(parseCliArgs(["doctor"])).toMatchObject({ command: "validate" });
    expect(parseCliArgs(["doctor", "--consumer", "../agent-folder"])).toMatchObject({
      command: "validate",
      consumerPath: "../agent-folder",
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
      includeMemory: false,
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
      includeMemory: false,
    });
    expect(parseCliArgs(["install-skill"])).toMatchObject({ command: "install-skill", force: false });
    expect(() => parseCliArgs(["install-skill", "--target", "browser"])).toThrow(/--target/u);
  });

  it("parses backfill flags (--run/--all/--since/--until/--include-memory/--dry-run)", () => {
    expect(parseCliArgs(["backfill", "--all", "--dry-run"])).toMatchObject({
      command: "backfill",
      all: true,
      dryRun: true,
      includeMemory: false,
    });
    expect(
      parseCliArgs(["backfill", "--run", "run-x", "--since", "2026-06-01", "--until", "2026-06-30", "--include-memory"]),
    ).toMatchObject({
      command: "backfill",
      run: "run-x",
      since: "2026-06-01",
      until: "2026-06-30",
      all: false,
      dryRun: false,
      includeMemory: true,
    });
  });

  it("parses audit-runs flags", () => {
    expect(
      parseCliArgs(["audit-runs", "--artifact-dir", "./runs", "--stale-after-ms", "1234", "--include-memory", "--json"]),
    ).toMatchObject({
      command: "audit-runs",
      artifactDir: "./runs",
      staleAfterMs: 1234,
      includeMemory: true,
      json: true,
    });
    expect(
      parseCliArgs(["audit-runs", "--consumer", "../local-agent-alpha", "--config", "agent.config.json"]),
    ).toMatchObject({
      command: "audit-runs",
      consumerPath: "../local-agent-alpha",
      configPath: "agent.config.json",
    });
    expect(() => parseCliArgs(["audit-runs", "--stale-after-ms", "0"])).toThrow(/--stale-after-ms/u);
  });

  it("parses metrics flags and rejects invalid grouping dimensions", () => {
    expect(
      parseCliArgs([
        "metrics",
        "--artifacts",
        "./runs",
        "--since",
        "2026-06-01T00:00:00.000Z",
        "--until",
        "2026-06-30T00:00:00.000Z",
        "--by",
        "model",
        "--include-memory",
        "--json",
      ]),
    ).toMatchObject({
      command: "metrics",
      artifactDir: "./runs",
      since: "2026-06-01T00:00:00.000Z",
      until: "2026-06-30T00:00:00.000Z",
      groupBy: "model",
      includeMemory: true,
      json: true,
    });
    expect(parseCliArgs(["metrics", "--by", "channel"])).toMatchObject({ command: "metrics", groupBy: "channel" });
    expect(parseCliArgs(["metrics", "--by", "failureKind"])).toMatchObject({ command: "metrics", groupBy: "failureKind" });
    expect(() => parseCliArgs(["metrics", "--by", "status"])).toThrow(/--by/u);
  });

  it("parses validate --consumer and keeps it validate/audit-runs scoped", () => {
    expect(parseCliArgs(["validate", "--consumer", "../local-agent-alpha"])).toMatchObject({
      command: "validate",
      consumerPath: "../local-agent-alpha",
    });
    expect(() => parseCliArgs(["validate", "--consumer"])).toThrow(/--consumer requires a value/u);
    expect(() => parseCliArgs(["start", "--consumer", "../local-agent-alpha"])).toThrow(/--consumer/u);
  });

  it("defaults to help and rejects unknown commands and flags", () => {
    expect(parseCliArgs([]).command).toBe("help");
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(() => parseCliArgs(["serve"])).toThrow(/Unknown command/u);
    expect(() => parseCliArgs(["start", "--what"])).toThrow(/Unknown flag/u);
    // `--port` is a recognized (web-only) flag; it is rejected for non-web commands.
    expect(() => parseCliArgs(["start", "--port", "4100"])).toThrow(/only supported for/u);
    expect(() => parseCliArgs(["start", "--include-memory"])).toThrow(/--include-memory/u);
    expect(() => parseCliArgs(["validate", "--auth"])).toThrow(/--auth/u);
    expect(() => parseCliArgs(["init", "--memory", "vector"])).toThrow(/--memory/u);
    expect(() => parseCliArgs(["init", "--effort", "turbo"])).toThrow(/--effort/u);
  });

  it("parses --version, -v, and the bare `version` command", () => {
    expect(parseCliArgs(["--version"]).command).toBe("version");
    expect(parseCliArgs(["-v"]).command).toBe("version");
    expect(parseCliArgs(["version"]).command).toBe("version");
  });

  it("parses web command flags", () => {
    const result = parseCliArgs([
      "web",
      "--host",
      "0.0.0.0",
      "--port",
      "4599",
      "--no-open",
      "--allow-non-loopback",
      "--include-memory",
    ]);
    expect(result.command).toBe("web");
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(4599);
    expect(result.open).toBe(false);
    expect(result.allowNonLoopback).toBe(true);
    expect(result.includeMemory).toBe(true);
    expect(() => parseCliArgs(["web", "--port", "notaport"])).toThrow(/--port/u);
  });

  it("parses the web --max-runs cap and rejects bad or misplaced uses", () => {
    expect(parseCliArgs(["web", "--max-runs", "500"]).maxRunsPerInstance).toBe(500);
    expect(() => parseCliArgs(["web", "--max-runs", "0"])).toThrow(/--max-runs/u);
    expect(() => parseCliArgs(["web", "--max-runs", "nope"])).toThrow(/--max-runs/u);
    expect(() => parseCliArgs(["start", "--max-runs", "500"])).toThrow(/only supported for/u);
  });

  it("includes setup, presets, and web in the help screen", () => {
    expect(renderHelp()).toContain("mono-agent setup");
    expect(renderHelp()).toContain("mono-agent presets");
    expect(renderHelp()).toContain("mono-agent init [--preset");
    expect(renderHelp()).toContain("--effort writes runtime.effort, --auth runs supported provider auth/preflight");
    expect(renderHelp()).toContain("mono-agent web");
    expect(renderHelp()).toContain("--allow-non-loopback");
    expect(renderHelp()).toContain("--include-memory");
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

describe("monoAgentVersion", () => {
  it("reports this package's semver version", () => {
    expect(monoAgentVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});

describe("describeChannelStatus", () => {
  it("expands an object summary value instead of printing [object Object]", () => {
    const rendered = describeChannelStatus({
      kind: "running",
      summary: {
        invokeUrl: "http://127.0.0.1:9999/webhook/invoke",
        port: 9999,
        invokeUrls: { default: "http://127.0.0.1:9999/webhook/invoke" },
      },
    });
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toContain("invokeUrls={default: http://127.0.0.1:9999/webhook/invoke}");
    expect(rendered).toContain("port=9999");
  });

  it("renders a non-running channel as kind: reason", () => {
    expect(describeChannelStatus({ kind: "disabled", reason: "not enabled" })).toBe("disabled: not enabled");
  });
});

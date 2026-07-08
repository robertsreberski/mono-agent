import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import { validateMonoAgentFolder } from "../doctor.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-doctor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json, null, 2));
  return configPath;
}

function sectionById(report: Awaited<ReturnType<typeof validateMonoAgentFolder>>, id: string) {
  const section = report.sections.find((candidate) => candidate.id === id);
  expect(section, `section ${id}`).toBeDefined();
  return section!;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeRunSummary(artifactDir: string, name: string, summary: Record<string, unknown>): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

const availableSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return true;
  },
  async prepareCommand() {
    throw new Error("not used in validation");
  },
};

const unavailableSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return false;
  },
  async prepareCommand() {
    throw new Error("not used in validation");
  },
};

describe("validateMonoAgentFolder", () => {
  it("reports a ready config with runtime, fallback, and channel sections", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      context: { identityPath: "./IDENTITY.md" },
      webhook: { enabled: true },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(true);
    expect(sectionById(report, "core").status).toBe("ok");
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("ok");
    expect(runtime.details.join("\n")).toContain("Fallback model claude:claude-sonnet-4-6");
    expect(sectionById(report, "channel:webhook").status).toBe("ok");
    expect(report.sections.some((section) => section.id === "channel:a2a")).toBe(false);
    expect(sectionById(report, "channel:telegram").status).toBe("disabled");
  });

  it("reports adapter-derived send tools when enabled adapter configs are valid", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["SlackSendMessage", "TelegramSendMessage"] },
      slack: {
        enabled: true,
        botToken: "xoxb-test",
        appToken: "xapp-test",
        allowedChannelIds: ["C1"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toContain("SlackSendMessage");
    expect(tools.details.join("\n")).toContain("TelegramSendMessage");
  });

  it("fails when the identity file is missing", async () => {
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    const context = sectionById(report, "context");
    expect(context.status).toBe("error");
    expect(context.details.join("\n")).toContain("Identity file is missing");
  });

  it("fails when a selected skill has no SKILL.md", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md", skillsRoot: ".", selectedSkills: ["missing-skill"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "context").details.join("\n")).toContain("missing-skill");
  });

  it("reports core config errors without throwing", async () => {
    const configPath = await writeConfig({ context: { identityPath: "./IDENTITY.md" } });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    const core = sectionById(report, "core");
    expect(core.status).toBe("error");
    expect(core.details.join("\n")).toContain("MONO_AGENT_MODEL");
  });

  it("warns non-fatally when a secret is sourced from JSON", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "journal",
        path: dir,
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-json-secret",
        },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY).",
    ]);
  });

  it("does not add a secret-placement warning when the same secret is env-sourced", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "journal",
        path: dir,
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-env-secret" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(true);
    expect(report.sections.find((section) => section.id === "secret-placement")).toBeUndefined();
  });

  it("warns non-fatally for removed JSON memory ritual keys", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: dir,
        reflection: { cron: "ignored-secret-cron" },
        migration: { enabled: false },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.",
      "[WARN] memory.migration is removed and ignored; use memory.consolidation instead.",
    ]);
    expect(placement.details.join("\n")).not.toContain("ignored-secret-cron");
  });

  it("warns non-fatally for removed memory env keys without requiring a memory path", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const report = await validateMonoAgentFolder({
        env: {
          MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
          MONO_AGENT_MEMORY_MIGRATION_CRON: "ignored-secret-cron",
        },
        cwd: dir,
        configPath,
        liveness: false,
      });

      expect(report.ok).toBe(true);
      expect(sectionById(report, "memory").status).toBe("disabled");
      const placement = sectionById(report, "secret-placement");
      expect(placement.status).toBe("waiting");
      expect(placement.details).toEqual([
        "[WARN] MONO_AGENT_MEMORY_REFLECTION_ENABLED is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
        "[WARN] MONO_AGENT_MEMORY_MIGRATION_CRON is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
      ]);
      expect(placement.details.join("\n")).not.toContain("ignored-secret-cron");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns non-fatally when a channel secret (bot token) is sourced from JSON", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      telegram: { enabled: true, botToken: "123:json-bot-token", allowAllChats: true },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] telegram.botToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_TELEGRAM_BOT_TOKEN).",
    ]);
    expect(placement.details.join("\n")).not.toContain("json-bot-token");
  });

  it("warns when an external A2A driver reports JSON bearer tokens", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      channels: {
        plugins: [
          {
            package: "@mono-agent/a2a-adapter",
            config: {
              provider: {
                bearerToken: "provider-json-secret",
              },
              consumer: {
                bearerToken: "consumer-json-secret",
              },
            },
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] a2a.provider.bearerToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_A2A_BEARER_TOKEN).",
      "[WARN] a2a.consumer.bearerToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN).",
    ]);
    expect(placement.details.join("\n")).not.toContain("provider-json-secret");
    expect(placement.details.join("\n")).not.toContain("consumer-json-secret");
  });

  it("errors on an invalid per-trigger model/effort override at validate time", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      cron: {
        jobs: [
          { id: "digest", enabled: true, expression: "0 7 * * *", prompt: "Summarize.", model: "not-a-model" },
        ],
      },
      webhook: { enabled: true, effort: "extreme" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const cron = sectionById(report, "channel:cron");
    expect(cron.status).toBe("error");
    expect(cron.details.join("\n")).toContain('cron job "digest" has an invalid model override "not-a-model"');
    const webhook = sectionById(report, "channel:webhook");
    expect(webhook.status).toBe("error");
    expect(webhook.details.join("\n")).toContain('invalid effort override "extreme"');
  });

  it("accepts valid per-trigger model/effort overrides", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      cron: {
        jobs: [
          {
            id: "digest",
            enabled: true,
            expression: "0 7 * * *",
            prompt: "Summarize.",
            model: "claude:claude-opus-4-8",
            effort: "high",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "channel:cron").status).toBe("ok");
  });

  it("reports an effective native sandbox when the engine is available", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("ok");
    const text = sandbox.details.join("\n");
    expect(text).toContain('Sandbox is effective with native engine "fake-srt"');
    expect(text).toContain("commands run sandboxed");
  });

  it("warns non-fatally when unsafe sandbox fallback is active", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: {
        mode: "native",
        fallback: "unsafe-host-process",
        unsafeAllowHostProcess: true,
        denyWrite: [".env", "secrets/**"],
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: unavailableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("waiting");
    const text = sandbox.details.join("\n");
    expect(text).not.toContain("[WARN] WARNING:");
    expect(text).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(text).toContain("Unsafe sandbox fallback is active");
    expect(text).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");
  });

  it("reports fail-closed sandbox unavailability without failing validation", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: unavailableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("waiting");
    expect(sandbox.details.join("\n")).toContain("commands fail closed with sandbox_unavailable");
  });

  it("does not warn about a channel secret supplied via env", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      telegram: { enabled: true, allowAllChats: true },
    });

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(true);
    expect(report.sections.find((section) => section.id === "secret-placement")).toBeUndefined();
  });
});

describe("validateMonoAgentFolder — observability exporter section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function writeExporterConfig(exporters?: unknown): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    return writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      ...(exporters === undefined ? {} : { observability: { exporters } }),
    });
  }

  it("reports disabled when no exporter is configured", async () => {
    const configPath = await writeExporterConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("disabled");
    expect(section.details.join("\n")).toMatch(/no observability exporter/iu);
    expect(report.ok).toBe(true);
  });

  it("reports ok when the Phoenix endpoint is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("ok");
    const text = section.details.join("\n");
    expect(text).toContain("http://127.0.0.1:6006/v1/traces");
    expect(text).toMatch(/JSONL artifacts remain local/iu);
    expect(text).not.toContain("[WARN] includeSensitiveData=true");
    expect(report.ok).toBe(true);
  });

  it("warns when sensitive data export is enabled but keeps the report ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const endpoint = "http://127.0.0.1:6006/v1/traces";
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint, includeSensitiveData: true }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("ok");
    const text = section.details.join("\n");
    expect(text).toContain("[WARN] includeSensitiveData=true");
    expect(text).toContain(endpoint);
    expect(text).toContain("user input");
    expect(text).toContain("assistant replies");
    expect(text).toContain("tool args/results");
    expect(text).toContain("system prompt");
    expect(text).toMatch(/JSONL artifacts remain local/iu);
    expect(report.ok).toBe(true);
  });

  it("reports waiting (not error) when the endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("waiting");
    const text = section.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toMatch(/ECONNREFUSED|not reachable|unreachable/iu);
    expect(text).toMatch(/JSONL artifacts remain local/iu);
    expect(report.ok).toBe(true);
  });

  it("reports waiting (not a false ok) when the endpoint rejects the protobuf POST with 415", async () => {
    // The old OPTIONS probe treated this endpoint as healthy; the real export
    // POST returns 415 (wrong content type). The probe now POSTs protobuf, so it
    // catches the export incompatibility instead of reporting a false ok.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 415 }));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("waiting");
    const text = section.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toContain("HTTP 415");
    expect(report.ok).toBe(true);
  });

  it("POSTs application/x-protobuf when probing (exercises the real export wire format)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-protobuf");
  });

  it("reports waiting when the endpoint responds but with a non-ok status (wrong path)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/wrong" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("waiting");
    const text = section.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toContain("HTTP 404");
    // Still non-fatal: a wrong/unready endpoint never fails the report.
    expect(report.ok).toBe(true);
  });

  it("reports error (fails the report) for an invalid exporter type", async () => {
    const configPath = await writeExporterConfig([{ type: "bogus", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("error");
    expect(report.ok).toBe(false);
  });
});

describe("validateMonoAgentFolder — runs health section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function writeRunsConfig(artifactDirName = "artifacts"): Promise<{
    readonly artifactDir: string;
    readonly configPath: string;
  }> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const artifactDir = join(dir, artifactDirName);
    const configPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: { dir: `./${artifactDirName}` },
    });
    return { artifactDir, configPath };
  }

  it("reports effective artifact retention settings", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: {
        dir: "./artifacts",
        retention: { maxAgeDays: 12, maxCount: 34, dryRun: true },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.details[0]).toBe("Artifact retention: maxAgeDays=12, maxCount=34, dryRun=true.");
    expect(runs.details[1]).toBe("Memory artifact retention: maxAgeDays=7, maxCount=5000, dryRun=true.");
    expect(report.ok).toBe(true);
  });

  it("reports recent status counts and a failure-kind breakdown from summaries", async () => {
    const { artifactDir, configPath } = await writeRunsConfig();
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeRunSummary(artifactDir, "succeeded.summary.json", {
      runId: "run-succeeded",
      conversationId: "chat",
      status: "succeeded",
      startedAt,
      durationMs: 1000,
      eventCount: 2,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "running.summary.json", {
      runId: "run-running",
      conversationId: "chat",
      status: "running",
      startedAt,
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "failed.summary.json", {
      runId: "run-failed",
      conversationId: "chat",
      status: "failed",
      failureKind: "usage_limit",
      startedAt,
      durationMs: 1000,
      eventCount: 3,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "unknown-failure.summary.json", {
      runId: "run-unknown",
      conversationId: "chat",
      status: "failed",
      failureKind: "provider_error",
      startedAt,
      durationMs: 1000,
      eventCount: 3,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "cancelled.summary.json", {
      runId: "run-cancelled",
      conversationId: "chat",
      status: "cancelled",
      failureKind: "cancelled",
      startedAt,
      durationMs: 500,
      eventCount: 1,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "interrupted.summary.json", {
      runId: "run-interrupted",
      conversationId: "chat",
      status: "interrupted",
      failureKind: "process_death",
      startedAt,
      durationMs: 500,
      eventCount: 1,
      artifactPaths: [],
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("waiting");
    const text = runs.details.join("\n");
    expect(text).toContain(`Artifact dir: ${artifactDir}`);
    expect(text).toContain("Recorded runs: 6 total; showing 6 recent (max 50).");
    expect(text).toContain("Last runs:");
    expect(text).toContain("Recent status counts: running=1, succeeded=1, failed=2, cancelled=1, interrupted=1.");
    expect(text).toContain("[WARN] Recent non-successful runs:");
    expect(text).toContain("[WARN] Cancelled recent runs: 1.");
    expect(text).toContain("[WARN] Interrupted recent runs: 1.");
    expect(text).toContain("[WARN] Failure kinds: cancelled=1, process_death=1, provider_error=1, usage_limit=1.");
    expect(text).toContain("Usage limit [usage_limit, 1 recent]");
    expect(text).toContain("Process death [process_death, 1 recent]");
    expect(text).toContain("Cancelled [cancelled, 1 recent]");
    expect(text).toContain("Unclassified failure (provider_error) [provider_error (unclassified), 1 recent]");
    expect(report.ok).toBe(true);
  });

  it("reports the exact run total when the recent list is capped", async () => {
    const { artifactDir, configPath } = await writeRunsConfig();
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    for (let index = 0; index < 55; index += 1) {
      await writeRunSummary(artifactDir, `run-${index}.summary.json`, {
        runId: `run-${index}`,
        conversationId: "chat",
        status: "succeeded",
        startedAt,
        durationMs: 1000,
        eventCount: 1,
        artifactPaths: [],
      });
    }

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("ok");
    expect(runs.details.join("\n")).toContain("Recorded runs: 55 total; showing 50 recent (max 50).");
    expect(report.ok).toBe(true);
  });

  it("warns when a running summary is older than the staleness threshold", async () => {
    const { artifactDir, configPath } = await writeRunsConfig();
    const staleStartedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await writeRunSummary(artifactDir, "stale.summary.json", {
      runId: "run-stale",
      conversationId: "chat",
      status: "running",
      startedAt: staleStartedAt,
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("waiting");
    expect(runs.details.join("\n")).toContain("[WARN] Stale running runs older than 30m: run-stale");
    expect(report.ok).toBe(true);
  });

  it("treats missing and empty artifact directories as disabled and non-fatal", async () => {
    const { artifactDir, configPath } = await writeRunsConfig("missing-artifacts");

    const missing = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(missing, "runs").status).toBe("disabled");
    expect(sectionById(missing, "runs").details.join("\n")).toContain("No runs recorded yet.");
    expect(missing.ok).toBe(true);

    await mkdir(artifactDir, { recursive: true });
    const empty = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(empty, "runs").status).toBe("disabled");
    expect(sectionById(empty, "runs").details.join("\n")).toContain("No runs recorded yet.");
    expect(empty.ok).toBe(true);
  });

  it("does not add a network probe during liveness:false preflight", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { artifactDir, configPath } = await writeRunsConfig();
    await writeRunSummary(artifactDir, "succeeded.summary.json", {
      runId: "run-succeeded",
      conversationId: "chat",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      eventCount: 1,
      artifactPaths: [],
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("validateMonoAgentFolder — bujo memory checks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function writeMinimalConfig(extra: Record<string, unknown> = {}): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "./IDENTITY.md" },
        ...extra,
      }),
    );
    return configPath;
  }

  function stubFetch(models: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: models.map((name) => ({ name })) }),
      }),
    );
  }

  it("passes the bujo memory section when Ollama is reachable and the embeddings model is present", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(memory.details.join("\n")).toContain("bujo");
  });

  it("reports the supermemory backend (status=ok, no Ollama needed, container surfaced)", async () => {
    const configPath = await writeMinimalConfig({
      memory: {
        backend: "supermemory",
        mode: "lite",
        path: dir,
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("Backend: supermemory");
    expect(text).toContain("http://127.0.0.1:6767");
    expect(text).toContain("agent-alpha");
    // bujo-only "Mode:" line is not used for external backends.
    expect(text).not.toMatch(/^Mode:/mu);
  });

  it("warns (status=waiting, no throw) when Ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    // unreachable Ollama => waiting (not error, not a throw)
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/not reachable|unreachable|ECONNREFUSED/iu);
    // overall report is still "ok" — a warn is non-fatal
    expect(report.ok).toBe(true);
  });

  it("warns when the embeddings model is not yet pulled", async () => {
    stubFetch(["llama3:latest"]); // model present but NOT the embeddings model

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/nomic-embed-text/u);
    expect(text).toMatch(/not pulled|pull/iu);
    expect(report.ok).toBe(true);
  });

  it("warns when the chat LLM model is configured but not pulled", async () => {
    // Embeddings model present, chat model absent
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/qwen3:6b/u);
    expect(text).toMatch(/not pulled|pull/iu);
    expect(report.ok).toBe(true);
  });

  it("warns when the memory root is not writable", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);
    // A path *under an existing file* makes mkdir fail with ENOTDIR deterministically on every
    // platform and regardless of privileges. A hardcoded /proc path hangs on Linux CI runners.
    const blocker = join(dir, "blocker-bujo");
    await writeFile(blocker, "x");
    const unwritablePath = join(blocker, "root");

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: unwritablePath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/writable|mkdir/iu);
    expect(report.ok).toBe(true);
  });

  it("warns on journal mode when Ollama is unreachable (journal also needs embeddings)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/not reachable|unreachable|ECONNREFUSED/iu);
    expect(report.ok).toBe(true);
  });

  it("passes journal mode when Ollama is reachable and embeddings model is present", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(memory.details.join("\n")).toContain("journal");
  });

  it("does NOT probe Ollama when embeddings provider is openai", async () => {
    // fetch is NOT stubbed — if the Ollama probe were attempted it would fail and warn.
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).not.toMatch(/ollama/iu);
    expect(text).not.toMatch(/WARN/iu);
  });

  it("does NOT probe Ollama for an agent-host chat LLM when embeddings provider is openai", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("agent-host:pi:openai-codex:gpt-5.5");
    expect(text).not.toMatch(/pull|not pulled|WARN/iu);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT check an agent-host chat LLM against Ollama when embeddings provider is ollama", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "nomic-embed-text:v1.5" }] }),
    });
    vi.stubGlobal("fetch", fetch);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("agent-host:pi:openai-codex:gpt-5.5");
    expect(text).not.toMatch(/pi:openai-codex:gpt-5\.5.*pull|not pulled|WARN/iu);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks Ollama embeddings and chat models against their own endpoints", async () => {
    const fetch = vi.fn(async (url: string) => {
      const models = url.startsWith("http://localhost:11435/")
        ? [{ name: "qwen3.6:latest" }]
        : [{ name: "nomic-embed-text:v1.5" }];
      return {
        ok: true,
        json: async () => ({ models }),
      };
    });
    vi.stubGlobal("fetch", fetch);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://localhost:11434",
        },
        llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11435" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).not.toMatch(/not pulled|WARN/iu);
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.anything());
    expect(fetch).toHaveBeenCalledWith("http://localhost:11435/api/tags", expect.anything());
  });

  it("passes lite mode without any Ollama probe (lite needs no embeddings)", async () => {
    // fetch is NOT stubbed — if the probe were attempted it would throw
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: dir,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).toContain("lite");
    expect(report.ok).toBe(true);
  });

  it("warns for lite mode when the memory root is not writable", async () => {
    // See the bujo variant above: a path under an existing file fails mkdir with ENOTDIR
    // deterministically; a hardcoded /proc path hangs on Linux CI runners.
    const blocker = join(dir, "blocker-lite");
    await writeFile(blocker, "x");
    const unwritablePath = join(blocker, "root");

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: unwritablePath,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/writable|mkdir/iu);
    expect(report.ok).toBe(true);
  });

  it("does not create a missing lite memory root when filesystem writes are disabled", async () => {
    const memoryPath = join(dir, "missing-lite-memory");
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: memoryPath,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      allowFilesystemWrites: false,
    });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toContain("Consumer validation is read-only and did not create it");
    expect(await pathExists(memoryPath)).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("does not create a missing journal memory root when filesystem writes are disabled", async () => {
    const memoryPath = join(dir, "missing-journal-memory");
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: memoryPath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      allowFilesystemWrites: false,
    });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toContain("Consumer validation is read-only and did not create it");
    expect(await pathExists(memoryPath)).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("reports consolidation cadence for bujo with a chat LLM (auto-scheduled)", async () => {
    stubFetch(["nomic-embed-text:v1.5", "qwen3:6b"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toMatch(/consolidation/iu);
    expect(text).toContain("0 */2 * * *");
    expect(text).toMatch(/auto/iu);
  });

  it("reports no automatic consolidation for bujo without a chat LLM", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        // No llm config
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toMatch(/consolidation/iu);
    expect(text).toMatch(/not scheduled/iu);
    expect(text).toMatch(/no chat model/iu);
    expect(text).toMatch(/downgrades to journal/iu);
  });

  it("reports custom consolidation cron when configured", async () => {
    stubFetch(["nomic-embed-text:v1.5", "qwen3:6b"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
        consolidation: { cron: "0 */4 * * *" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("0 */4 * * *");
    expect(text).not.toMatch(/reflection|migration/iu);
  });
});

describe("validateMonoAgentFolder — liveness:false (start preflight)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the Phoenix probe — exporter stays ok and fetch is never called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "observability").status).toBe("ok");
    expect(report.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips the Ollama probe — memory stays ok, no WARNs, fetch never called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    // The descriptive (non-probe) detail lines still render.
    expect(memory.details.join("\n")).toContain("bujo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still flags the memory root as not writable (a local, non-network check)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: join(blocker, "root"),
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/writable|mkdir/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("yields the same ok verdict as a full run when only waiting differs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }] },
    });

    const live = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: true });
    const fast = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(live.ok).toBe(true);
    expect(fast.ok).toBe(true);
    // The full run downgrades the exporter to waiting; the fast run keeps it ok —
    // either way the report passes, which is what the gate relies on.
    expect(sectionById(live, "observability").status).toBe("waiting");
    expect(sectionById(fast, "observability").status).toBe("ok");
  });
});

describe("validateMonoAgentFolder — provider credentials section", () => {
  const FUTURE = 4_102_444_800_000; // 2100-01-01, comfortably valid
  const PAST = 1_000_000_000_000; // 2001-09, comfortably expired

  async function writeAuthStore(providers: Record<string, unknown>): Promise<string> {
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify(providers, null, 2));
    return authPath;
  }

  async function writeModelsStore(providerIds: string[]): Promise<void> {
    const models = { providers: Object.fromEntries(providerIds.map((id) => [id, {}])) };
    await writeFile(join(dir, "models.json"), JSON.stringify(models, null, 2));
  }

  async function writeCredConfig(extra: Record<string, unknown>): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    return writeConfig({
      context: { identityPath: "./IDENTITY.md" },
      ...extra,
    });
  }

  it("passes when the custom primary is in models.json and the OAuth fallback token is valid", async () => {
    const authPath = await writeAuthStore({ "openai-codex": { type: "oauth", expires: FUTURE, refresh: "r" } });
    await writeModelsStore(["opencode-go", "ollama"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6", fallbackModels: ["pi:openai-codex:gpt-5.5"] },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).toMatch(/Primary pi:opencode-go:kimi-k2\.6: provider `opencode-go` configured via pi models\.json/u);
    expect(text).toMatch(/Fallback pi:openai-codex:gpt-5\.5: OAuth credentials for `openai-codex` present \(token valid/u);
    expect(text).not.toMatch(/WARN/u);
    expect(report.ok).toBe(true);
  });

  it("flags an expired OAuth token as waiting with a re-auth hint (the 10-day silent-degradation case)", async () => {
    const authPath = await writeAuthStore({ "openai-codex": { type: "oauth", expires: PAST, refresh: "r" } });
    await writeModelsStore(["opencode-go"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6", fallbackModels: ["pi:openai-codex:gpt-5.5"] },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toMatch(/expired/u);
    expect(text).toMatch(/npx @earendil-works\/pi-ai login openai-codex/u);
    expect(text).not.toMatch(/pi auth login/u);
    // waiting is non-fatal — the report still passes, but the degradation is now visible.
    expect(report.ok).toBe(true);
  });

  it("flags a referenced OAuth provider that is absent from the auth store and models.json", async () => {
    const authPath = await writeAuthStore({ anthropic: { type: "oauth", expires: FUTURE } });
    await writeModelsStore(["opencode-go"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6", fallbackModels: ["pi:openai-codex:gpt-5.5"] },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/no Pi credentials found for provider `openai-codex`/u);
    expect(report.ok).toBe(true);
  });

  it("includes the agent-host memory LLM in the credential check", async () => {
    const authPath = await writeAuthStore({ "openai-codex": { type: "oauth", expires: PAST } });
    await writeModelsStore(["opencode-go"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    expect(creds.details.join("\n")).toMatch(/Memory LLM pi:openai-codex:gpt-5\.5: OAuth token for `openai-codex` expired/u);
  });

  // E1 (headline): a `claude:*` model with no discoverable env credential must WARN
  // at validate time so the fresh user isn't blindsided by the opaque first-turn crash.
  it("warns (waiting) when a claude:* model has no ANTHROPIC_API_KEY in the resolved env", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/\[WARN\] Primary claude:claude-sonnet-4-6: no SDK credential in the resolved env/u);
    expect(text).toMatch(/ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN/u);
    // The warning stays honest: a `claude /login` session and a Bedrock/Vertex
    // configuration authenticate outside the checked keys and can't be verified here.
    expect(text).toMatch(/claude \/login/u);
    expect(text).toMatch(/Bedrock\/Vertex/u);
    // waiting is non-fatal — validate still passes, but the trap is now visible.
    expect(report.ok).toBe(true);
  });

  it("does not warn when a claude:* model has ANTHROPIC_API_KEY set", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
    });

    const report = await validateMonoAgentFolder({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).not.toMatch(/WARN/u);
    expect(text).toMatch(/Primary claude:claude-sonnet-4-6: SDK credential present in the resolved env \(ANTHROPIC_API_KEY\)/u);
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN as a claude:* env credential", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
    });

    const report = await validateMonoAgentFolder({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details.join("\n")).toMatch(/SDK credential present in the resolved env \(CLAUDE_CODE_OAUTH_TOKEN\)/u);
  });

  it("warns (waiting) when a codex:* model has no OPENAI_API_KEY, naming the codex login path", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "codex:gpt-5.5" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/\[WARN\] Primary codex:gpt-5\.5: no SDK credential in the resolved env \(checked OPENAI_API_KEY\)/u);
    expect(text).toMatch(/codex login/u);
    expect(report.ok).toBe(true);
  });

  it("does not warn when a codex:* model has OPENAI_API_KEY set", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "codex:gpt-5.5" },
    });

    const report = await validateMonoAgentFolder({
      env: { OPENAI_API_KEY: "sk-test" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details.join("\n")).not.toMatch(/WARN/u);
  });

  // E2: a fully-valid `providers.local` ollama provider is keyless — with an empty
  // pi store it must NOT get the "no Pi credentials found" warning (the wrong advice).
  it("does not warn for a pi:ollama model configured via providers.local with an empty pi store", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:ollama:gemma4:31b" },
      providers: {
        local: [
          { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).not.toMatch(/WARN/u);
    expect(text).not.toMatch(/no Pi credentials found/u);
    expect(text).toMatch(/Primary pi:ollama:gemma4:31b: provider `ollama` configured via config providers\.local \(keyless local provider\)/u);
    expect(report.ok).toBe(true);
  });

  // Regression: a DISABLED providers.local entry must NOT report a clean OK — the
  // runtime throws `provider disabled: ollama` on the first turn, so the union
  // must name that rather than treating it as a keyless-provider success.
  it("warns (waiting) for a pi:ollama model whose providers.local entry is disabled", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:ollama:gemma4:31b" },
      providers: {
        local: [
          { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: false },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).not.toBe("ok");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/\[WARN\] Primary pi:ollama:gemma4:31b: provider `ollama` is configured in providers\.local but disabled/u);
    expect(text).toMatch(/provider disabled: ollama/u);
    // It must NOT claim the keyless-provider success path for a disabled provider.
    expect(text).not.toMatch(/keyless local provider/u);
  });
});

describe("validateMonoAgentFolder — tools guardrails & channel cross-checks", () => {
  async function writeToolsConfig(
    tools: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    return writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools,
      ...extra,
    });
  }

  it("flags an empty allowlist as waiting (the no-tools trap), never failing the report", async () => {
    const configPath = await writeToolsConfig({ allowedTools: [] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/cannot read files/u);
    // A deliberately chat-only agent is legitimate: waiting never fails validate.
    expect(report.ok).toBe(true);
  });

  it("renders allow-all ('*') cleanly as 'All tools allowed.' (status ok)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["*"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details).toContain("All tools allowed.");
    // Never the raw sentinel echo, and no "except" clause when nothing is disallowed.
    expect(tools.details.join("\n")).not.toMatch(/Allowed tools: \*/u);
    expect(tools.details.join("\n")).not.toMatch(/except/u);
    expect(report.ok).toBe(true);
  });

  it("folds disallowedTools into the allow-all line (no separate Disallowed line)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["*"], disallowedTools: ["Bash"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details).toContain("All tools allowed (except: Bash).");
    // The disallow list is folded into the allow-all line; it must not ALSO print separately.
    expect(tools.details.join("\n")).not.toMatch(/Disallowed tools:/u);
    expect(report.ok).toBe(true);
  });

  it("does not fire Direction B under allow-all (send tools are allowed by '*')", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["*"] },
      { telegram: { enabled: true, allowAllChats: true } },
    );

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(sectionById(report, "channel:telegram").status).not.toBe("disabled");
    const tools = sectionById(report, "tools");
    // Under allow-all every send tool is allowed, so the "enabled without a send tool" hint
    // must NOT fire and must not downgrade the status.
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toMatch(/telegram is enabled without/u);
    expect(report.ok).toBe(true);
  });

  it("passes a valid safe-tool allowlist (status ok)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["Read", "Glob", "Grep"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(report.ok).toBe(true);
  });

  it("flags an unknown tool name with a did-you-mean suggestion (waiting)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["read"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/Unknown tool name "read".*did you mean Read/u);
    expect(report.ok).toBe(true);
  });

  it("notes MemoryRecall as a harmless no-op (status ok) when recall is enabled", async () => {
    // recallTool enabled → MemoryRecall is auto-provisioned; listing it is redundant
    // but harmless, so it is an INFO note that does not downgrade the tools status.
    const configPath = await writeToolsConfig(
      { allowedTools: ["MemoryRecall", "Read"] },
      { memory: { mode: "lite", path: dir, recallTool: { enabled: true } } },
    );

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toMatch(/has no effect|already on/u);
    expect(report.ok).toBe(true);
  });

  it("flags MemoryRecall in allowedTools as waiting when recall is not enabled", async () => {
    // No recallTool.enabled → recall will not work despite the allowlist entry.
    const configPath = await writeToolsConfig({ allowedTools: ["MemoryRecall"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/recall will not work|recallTool/u);
    expect(report.ok).toBe(true);
  });

  it("skips MCP tool names (unvalidatable offline) but keeps ok when a real tool is present", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["mcp__foo__bar", "Read"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toMatch(/cannot be validated offline/u);
    expect(report.ok).toBe(true);
  });

  it("Direction A: warns when a send tool is allowed but its channel is disabled", async () => {
    // `Read` keeps the allowlist non-empty and known, so the ONLY reason for
    // waiting is the cross-check (not the empty-allowlist or unknown-name checks).
    const configPath = await writeToolsConfig({ allowedTools: ["TelegramSendMessage", "Read"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "channel:telegram").status).toBe("disabled");
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/telegram channel is disabled/u);
    expect(report.ok).toBe(true);
  });

  it("Direction B: hints (status unchanged) when a channel is enabled without a send tool allowed", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["Read", "Glob", "Grep"] },
      { telegram: { enabled: true, allowAllChats: true } },
    );

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(sectionById(report, "channel:telegram").status).not.toBe("disabled");
    const tools = sectionById(report, "tools");
    // A hint must NOT downgrade the status — replies still work.
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toMatch(/telegram is enabled without/u);
    expect(report.ok).toBe(true);
  });
});

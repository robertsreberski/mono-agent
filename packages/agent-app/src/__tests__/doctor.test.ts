import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(sectionById(report, "channel:a2a").status).toBe("disabled");
    expect(sectionById(report, "channel:telegram").status).toBe("disabled");
  });

  it("reports the operator console section", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      console: { port: 4321 },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });
    const consoleSection = sectionById(report, "console");
    expect(consoleSection.status).toBe("ok");
    expect(consoleSection.details.join("\n")).toContain("4321");

    const disabledPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      console: { enabled: false },
    });
    const disabledReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath: disabledPath });
    expect(sectionById(disabledReport, "console").status).toBe("disabled");
  });

  it("reports adapter-derived send tools when enabled adapter configs are valid", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["slack_send_message", "telegram_send_message"] },
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
    expect(tools.details.join("\n")).toContain("slack_send_message");
    expect(tools.details.join("\n")).toContain("telegram_send_message");
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

  it("reports ritual cadence for bujo with a chat LLM (auto-scheduled)", async () => {
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
    expect(text).toMatch(/rituals/iu);
    expect(text).toContain("0 3 * * *"); // default reflection cron
    expect(text).toContain("0 4 1 * *"); // default migration cron
    expect(text).toMatch(/auto/iu);
  });

  it("reports manual rituals for bujo without a chat LLM", async () => {
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
    expect(text).toMatch(/rituals/iu);
    expect(text).toMatch(/manual/iu);
    expect(text).toMatch(/no chat model/iu);
  });

  it("reports custom ritual crons when configured", async () => {
    stubFetch(["nomic-embed-text:v1.5", "qwen3:6b"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
        reflection: { cron: "0 2 * * *" },
        migration: { enabled: false },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("0 2 * * *"); // custom reflection cron
    expect(text).toMatch(/migration disabled/iu);
  });
});

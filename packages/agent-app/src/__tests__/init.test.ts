import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { initMonoAgentFolder } from "../init.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("initMonoAgentFolder", () => {
  it("scaffolds config, identity, and working dirs in an empty folder", async () => {
    const result = await initMonoAgentFolder({ dir, model: "pi:ollama:gemma4:31b" });

    expect(result.created).toContain(result.configPath);
    expect(result.created).toContain(result.identityPath);
    expect(result.knowledgeFiles).toEqual([]);

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.$schema).toBe(MONO_AGENT_CONFIG_SCHEMA_URL);
    expect(config.runtime.model).toBe("pi:ollama:gemma4:31b");
    expect(config.runtime.maxTurns).toBeUndefined();
    expect(config.context.identityPath).toBe("./IDENTITY.md");
    expect(config.webhook.enabled).toBe(true);
    expect(config.memory).toBeUndefined();

    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("# Identity");
  });

  it("merges --with core channels onto the default scaffold", async () => {
    const result = await initMonoAgentFolder({
      dir,
      model: "pi:ollama:gemma4:31b",
      withChannels: ["slack", "cron"],
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.slack).toEqual({ enabled: true });
    expect(config.cron).toEqual({ enabled: true });
  });

  it("writes fallback models and memory when requested", async () => {
    const result = await initMonoAgentFolder({
      dir,
      model: "claude:claude-sonnet-4-6",
      fallbackModels: ["pi:ollama:gemma4:31b"],
      memory: "journal",
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.runtime.fallbackModels).toEqual(["pi:ollama:gemma4:31b"]);
    expect(config.memory).toMatchObject({ mode: "journal", path: "./.mono-agent/memory" });
  });

  it("references existing knowledge files in the generated identity", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
    await writeFile(join(dir, "CLAUDE.md"), "# Claude\n");

    const result = await initMonoAgentFolder({ dir });

    expect(result.knowledgeFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("`AGENTS.md`");
    expect(identity).toContain("`CLAUDE.md`");
  });

  it("writes bujo memory config when memory is 'bujo'", async () => {
    const result = await initMonoAgentFolder({ dir, memory: "bujo" });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.memory).toMatchObject({ mode: "bujo" });
    // bujo uses a directory path (like journal), not a single file
    expect(config.memory.path).toContain(".mono-agent/memory");
  });

  it("writes lite memory config when memory is 'lite' (directory path, no Ollama needed)", async () => {
    const result = await initMonoAgentFolder({ dir, memory: "lite" });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.memory).toMatchObject({ mode: "lite" });
    // lite uses a directory path (all bujo-backed tiers do)
    expect(config.memory.path).toContain(".mono-agent/memory");
  });

  it("never overwrites existing files", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { model: "codex:gpt-5.5" } }));
    await writeFile(join(dir, "IDENTITY.md"), "# Mine\n");

    const result = await initMonoAgentFolder({ dir, model: "claude:claude-sonnet-4-6" });

    expect(result.skipped).toContain(configPath);
    expect(result.skipped).toContain(result.identityPath);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.model).toBe("codex:gpt-5.5");
    expect(await readFile(result.identityPath, "utf8")).toBe("# Mine\n");
  });
});

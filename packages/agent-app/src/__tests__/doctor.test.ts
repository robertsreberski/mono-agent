import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    expect(sectionById(report, "channel:telegram").status).toBe("waiting");
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

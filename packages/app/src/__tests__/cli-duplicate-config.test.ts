import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "../cli-args.js";
import { runValidate } from "../cli-validate-config-command.js";
import { validateMonoAgentFolder } from "../doctor.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function duplicateConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-duplicate-config-"));
  dirs.push(dir);
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, '{"runtime":{"model":"openai-codex:gpt-5.5"},"processJobs":{"maxActivePerConversation":2,"maxActivePerConversation":4}}');
  return { dir, configPath };
}

describe("duplicate config validation", () => {
  it("reports error-level core detail in doctor without loader warning", async () => {
    const { dir, configPath } = await duplicateConfig();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = await validateMonoAgentFolder({
      cwd: dir, configPath, env: {}, drivers: [], liveness: false, allowFilesystemWrites: false,
    });
    expect(report.structurallyValid).toBe(false);
    expect(report.sections.find((section) => section.id === "core")).toMatchObject({
      status: "error",
      details: expect.arrayContaining([expect.stringContaining("processJobs.maxActivePerConversation")]),
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it("keeps the duplicate detail when another config field is invalid", async () => {
    const { dir, configPath } = await duplicateConfig();
    await writeFile(configPath, '{"runtime":{"model":"openai-codex:gpt-5.5","permissionMode":"bypassPermissions"},"processJobs":{"enabled":true,"enabled":false}}');
    const report = await validateMonoAgentFolder({
      cwd: dir, configPath, env: {}, drivers: [], liveness: false, allowFilesystemWrites: false,
    });
    const details = report.sections.find((section) => section.id === "core")?.details.join(" ");
    expect(details).toContain("runtime.permissionMode");
    expect(details).toContain("processJobs.enabled");
  });

  it("prints the path and fails validate in human and JSON output", async () => {
    const { dir } = await duplicateConfig();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => { lines.push(String(value)); return true; });
    expect(await runValidate(parseCliArgs(["validate", "--consumer", dir]))).toBe(1);
    expect(lines.join("")).toContain("processJobs.maxActivePerConversation");
    lines.length = 0;
    expect(await runValidate(parseCliArgs(["validate", "--consumer", dir, "--json"]))).toBe(1);
    const json = JSON.parse(lines.join("")) as { ok: boolean; sections: { id: string; status: string; details: string[] }[] };
    expect(json.ok).toBe(false);
    expect(json.sections.find((section) => section.id === "core")?.details.join(" ")).toContain("processJobs.maxActivePerConversation");
  });
});

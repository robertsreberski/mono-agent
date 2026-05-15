import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadSelectedSkills, SkillActivationError } from "./index.js";

const tempDirs: string[] = [];
async function createSkillsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-test-"));
  tempDirs.push(root);
  await mkdir(join(root, "research"));
  await writeFile(join(root, "research", "SKILL.md"), "# Research\n\nFind source-backed evidence.\n\nDetails.", "utf8");
  await mkdir(join(root, "writing"));
  await writeFile(join(root, "writing", "SKILL.md"), "# Writing\n\nWrite concise plans.", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadSelectedSkills", () => {
  it("loads only configured skill bodies and context blocks", async () => {
    const root = await createSkillsRoot();

    const result = await loadSelectedSkills({ skillsRoot: root, names: ["writing"] });

    expect(result.index).toEqual([
      { name: "writing", description: "Write concise plans.", mainFile: join(root, "writing", "SKILL.md") },
    ]);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]?.content).toContain("# Skill: writing");
    expect(result.instructions[0]?.content).toContain("Write concise plans.");
  });

  it("returns empty context when no skills are configured", async () => {
    const result = await loadSelectedSkills({ skillsRoot: "/not/read", names: [] });
    expect(result).toEqual({ index: [], instructions: [], loaded: [] });
  });

  it("fails readably when configured skill is missing", async () => {
    const root = await createSkillsRoot();
    await expect(loadSelectedSkills({ skillsRoot: root, names: ["missing"] })).rejects.toBeInstanceOf(SkillActivationError);
  });

  it("caps selected skill body reads", async () => {
    const root = await createSkillsRoot();
    const result = await loadSelectedSkills({ skillsRoot: root, names: ["research"], maxBytes: 256 });
    expect(result.loaded[0]?.truncated).toBe(false);
  });
});

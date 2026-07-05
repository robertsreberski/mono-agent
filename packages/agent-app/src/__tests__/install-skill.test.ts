import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installComposerSkill } from "../install-skill.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "install-skill-test-"));
  tempDirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("installComposerSkill", () => {
  it("installs the bundled skill into both harness skill folders by default", async () => {
    const homeDir = await tempHome();
    const result = await installComposerSkill({ target: "both", force: false, homeDir });

    const claudeDir = join(homeDir, ".claude", "skills", "mono-agent-composer");
    const codexDir = join(homeDir, ".agents", "skills", "mono-agent-composer");
    expect(result.installed).toEqual([claudeDir, codexDir]);
    for (const dir of [claudeDir, codexDir]) {
      expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("mono-agent-composer");
      expect(await exists(join(dir, "agents", "openai.yaml"))).toBe(true);
      expect(await exists(join(dir, "references", "config-blueprint.md"))).toBe(true);
      expect(await exists(join(dir, "references", "validation.md"))).toBe(true);
    }
  });

  it("installs into a single target without touching the other", async () => {
    const homeDir = await tempHome();
    await installComposerSkill({ target: "claude", force: false, homeDir });

    expect(await exists(join(homeDir, ".claude", "skills", "mono-agent-composer", "SKILL.md"))).toBe(true);
    expect(await exists(join(homeDir, ".agents"))).toBe(false);
  });

  it("refuses to overwrite an existing install without force", async () => {
    const homeDir = await tempHome();
    await installComposerSkill({ target: "claude", force: false, homeDir });

    await expect(installComposerSkill({ target: "claude", force: false, homeDir })).rejects.toThrow(/--force/u);
    await expect(installComposerSkill({ target: "claude", force: true, homeDir })).resolves.toMatchObject({
      installed: [join(homeDir, ".claude", "skills", "mono-agent-composer")],
    });
  });

  it("fails clearly when the bundled skill source is missing", async () => {
    const homeDir = await tempHome();
    await expect(
      installComposerSkill({ target: "both", force: false, homeDir, sourceDir: join(homeDir, "nowhere") }),
    ).rejects.toThrow(/SKILL\.md/u);
  });
});

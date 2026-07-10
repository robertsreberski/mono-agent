import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initMonoAgentFolder } from "../init.js";
import {
  checkManagedProjectSkills,
  PROJECT_SKILL_MANIFEST_PATH,
  updateManagedProjectSkills,
} from "../project-skills.js";
import { defaultAnswers } from "../wizard/answers.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-project-skills-"));
  dirs.push(dir);
  await initMonoAgentFolder({
    dir,
    answers: defaultAnswers({ name: "Skill Test", purpose: "Test managed project skills." }),
  });
  return dir;
}

describe("managed project skills", () => {
  it("scaffolds both selected, indexed skills with a verified hash manifest", async () => {
    const dir = await scaffold();
    const config = JSON.parse(await readFile(join(dir, "mono-agent.config.json"), "utf8")) as {
      context: { skillsRoot: string; selectedSkills: string[]; skillDisclosure: string };
    };
    expect(config.context).toEqual({
      identityPath: "./IDENTITY.md",
      skillsRoot: "./skills",
      selectedSkills: ["mono-agent-configure", "mono-agent-memory"],
      skillDisclosure: "index",
    });
    expect((await checkManagedProjectSkills(dir)).ok).toBe(true);
    expect(await readFile(join(dir, "skills", "mono-agent-configure", "SKILL.md"), "utf8"))
      .toContain("ProposeAgentConfiguration");
  });

  it("detects an operator edit and refuses to overwrite it", async () => {
    const dir = await scaffold();
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    await writeFile(path, "# operator copy\n");
    const check = await checkManagedProjectSkills(dir);
    expect(check.statuses.find((entry) => entry.name === "mono-agent-configure")?.status).toBe("modified");
    await expect(updateManagedProjectSkills(dir)).rejects.toThrow(/operator-modified/u);
    expect(await readFile(path, "utf8")).toBe("# operator copy\n");
  });

  it("backs up and atomically refreshes unchanged stale managed copies", async () => {
    const dir = await scaffold();
    const manifestPath = join(dir, PROJECT_SKILL_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
    manifest.version = "0.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect((await checkManagedProjectSkills(dir)).statuses.every((entry) => entry.status === "stale")).toBe(true);

    const result = await updateManagedProjectSkills(dir);
    expect(result.ok).toBe(true);
    expect(result.updated).toHaveLength(2);
    expect(result.backupDir).toBeDefined();
    expect(await readFile(join(result.backupDir!, "mono-agent-memory", "SKILL.md"), "utf8"))
      .toContain("# Configure memory");
  });
});

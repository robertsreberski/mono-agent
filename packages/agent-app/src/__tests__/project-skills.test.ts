import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initMonoAgentFolder } from "../init.js";
import {
  activeProjectSkillSelections,
  assertManagedProjectSkillInitSafe,
  checkManagedProjectSkills,
  PROJECT_SKILL_MANIFEST_PATH,
  PROJECT_SKILL_VERSION,
  updateManagedProjectSkills,
} from "../project-skills.js";
import { defaultAnswers } from "../wizard/answers.js";

const dirs: string[] = [];
const RETIRED = "mono-agent-configure";
const LEGACY_BODY = "# Legacy managed configure skill\n";

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

async function installLegacy(
  dir: string,
  options: { readonly file?: string | false; readonly manifest?: boolean } = {},
): Promise<string> {
  const path = join(dir, "skills", RETIRED, "SKILL.md");
  const manifestPath = join(dir, PROJECT_SKILL_MANIFEST_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string;
    skills: Record<string, { sha256: string }>;
  };
  manifest.version = "1.2.0";
  if (options.manifest !== false) {
    manifest.skills[RETIRED] = { sha256: createHash("sha256").update(LEGACY_BODY).digest("hex") };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.file !== false) {
    await mkdir(join(dir, "skills", RETIRED), { recursive: true });
    await writeFile(path, options.file ?? LEGACY_BODY);
  }
  return path;
}

describe("managed project skills", () => {
  it("scaffolds only the selected indexed memory skill at bundle v2", async () => {
    const dir = await scaffold();
    const config = JSON.parse(await readFile(join(dir, "mono-agent.config.json"), "utf8")) as {
      context: { skillsRoot: string; selectedSkills: string[]; skillDisclosure: string };
    };
    expect(config.context).toEqual({
      identityPath: "./IDENTITY.md",
      skillsRoot: "./skills",
      selectedSkills: ["mono-agent-memory"],
      skillDisclosure: "index",
    });
    expect(PROJECT_SKILL_VERSION).toBe("2.0.0");
    expect((await checkManagedProjectSkills(dir)).ok).toBe(true);
    await expect(access(join(dir, "skills", RETIRED, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const memory = await readFile(join(dir, "skills", "mono-agent-memory", "SKILL.md"), "utf8");
    expect(memory).toContain("edit mono-agent.config.json directly");
    expect(memory).not.toContain("ProposeAgentConfiguration");
  });

  it("filters only the retired selector case-insensitively", () => {
    expect(activeProjectSkillSelections([RETIRED, "MONO-AGENT-CONFIGURE", "missing-skill", "mono-agent-memory"]))
      .toEqual(["missing-skill", "mono-agent-memory"]);
  });

  it.each([
    ["retired-managed", {}, false],
    ["retired-missing", { file: false }, false],
    ["retired-modified", { file: "# operator edit\n" }, true],
    ["retired-collision", { manifest: false }, true],
  ] as const)("reports %s and fails closed where required", async (status, options, unsafe) => {
    const dir = await scaffold();
    const path = await installLegacy(dir, options);
    const check = await checkManagedProjectSkills(dir);
    expect(check.statuses.find((entry) => entry.name === RETIRED)?.status).toBe(status);
    expect(check.ok).toBe(false);
    if (unsafe) {
      await expect(updateManagedProjectSkills(dir)).rejects.toThrow(/operator-modified/u);
      expect(await readFile(path, "utf8")).toBe("file" in options ? options.file : LEGACY_BODY);
    }
  });

  it("removes an exact manifest-owned legacy file and rewrites the manifest transactionally", async () => {
    const dir = await scaffold();
    const path = await installLegacy(dir);
    const result = await updateManagedProjectSkills(dir);
    expect(result.ok).toBe(true);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toMatch(/\/skills\/mono-agent-memory\/SKILL\.md$/u);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatch(/\/skills\/mono-agent-configure\/SKILL\.md$/u);
    expect(result.backupDir).toBeDefined();
    expect(await readFile(join(result.backupDir!, RETIRED, "SKILL.md"), "utf8")).toBe(LEGACY_BODY);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await checkManagedProjectSkills(dir)).statuses.map((entry) => entry.name)).toEqual(["mono-agent-memory"]);
  });

  it("cleans a manifest-only retired entry without claiming a file removal", async () => {
    const dir = await scaffold();
    await installLegacy(dir, { file: false });
    const result = await updateManagedProjectSkills(dir);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("refuses init until an exact managed retirement is explicitly migrated", async () => {
    const dir = await scaffold();
    await installLegacy(dir);
    await expect(assertManagedProjectSkillInitSafe(dir)).rejects.toThrow(/install-skill --project --update/u);
  });

  it("rejects a concurrent replacement before retiring the legacy file", async () => {
    const dir = await scaffold();
    const path = await installLegacy(dir);
    await expect(updateManagedProjectSkills(dir, {
      beforeRetire: async () => writeFile(path, "# concurrent operator edit\n"),
    })).rejects.toThrow(/left untouched|restored.*retryable/u);
    expect(await readFile(path, "utf8")).toBe("# concurrent operator edit\n");
  });

  it("restores a retired file when manifest activation fails after deletion", async () => {
    const dir = await scaffold();
    const path = await installLegacy(dir);
    await expect(updateManagedProjectSkills(dir, {
      beforeActivate: async (target) => {
        if (target.endsWith(".mono-agent-managed.json")) throw new Error("injected manifest failure");
      },
    })).rejects.toThrow(/restored.*retryable/u);
    expect(await readFile(path, "utf8")).toBe(LEGACY_BODY);
  });

  it("rejects linked legacy files and symlinked skills parents", async () => {
    const dir = await scaffold();
    const path = await installLegacy(dir);
    await link(path, join(dir, "legacy-link"));
    await expect(checkManagedProjectSkills(dir)).rejects.toThrow(/one link/u);

    const external = await mkdtemp(join(tmpdir(), "mono-agent-external-skills-"));
    dirs.push(external);
    await rm(join(dir, "legacy-link"));
    await rm(join(dir, "skills"), { recursive: true, force: true });
    await symlink(external, join(dir, "skills"), "dir");
    await expect(checkManagedProjectSkills(dir)).rejects.toThrow(/real directory|symbolic link/u);
    expect(await readdir(external)).toEqual([]);
  });
});

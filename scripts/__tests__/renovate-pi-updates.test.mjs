import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const renovateConfigPath = ".github/renovate.json";
const expectedPiPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];

describe("Pi dependency update automation", () => {
  it("opens at most one grouped stable draft PR and never automerges it", async () => {
    const config = await readRenovateConfig();
    const disableRuleIndex = config.packageRules.findIndex(
      (rule) =>
        rule.enabled === false &&
        rule.matchManagers?.includes("npm") &&
        rule.matchPackageNames?.includes("*"),
    );
    const piRuleIndex = config.packageRules.findIndex(
      (rule) => rule.description === "Propose the synchronized Pi stack as one reviewed migration",
    );
    const piRule = config.packageRules[piRuleIndex];

    expect(config.enabledManagers).toEqual(["npm"]);
    expect(config.dependencyDashboard).toBe(false);
    expect(config.lockFileMaintenance).toEqual({ enabled: false });
    expect(config.branchConcurrentLimit).toBe(1);
    expect(config.prConcurrentLimit).toBe(1);
    expect(config.prHourlyLimit).toBe(1);

    expect(disableRuleIndex).toBeGreaterThanOrEqual(0);
    expect(piRuleIndex).toBeGreaterThan(disableRuleIndex);
    expect(piRule).toMatchObject({
      enabled: true,
      matchManagers: ["npm"],
      matchDatasources: ["npm"],
      groupName: "Pi dependencies",
      groupSlug: "pi-dependencies",
      minimumGroupSize: 3,
      rangeStrategy: "pin",
      respectLatest: true,
      ignoreUnstable: true,
      minimumReleaseAge: "0 days",
      prCreation: "immediate",
      draftPR: true,
      automerge: false,
      reviewers: ["robertsreberski"],
    });
    expect([...piRule.matchPackageNames].sort()).toEqual(expectedPiPackages);
  });

  it("keeps the Copilot handoff manual and pins every migration gate", async () => {
    const config = await readRenovateConfig();
    const piRule = config.packageRules.find(
      (rule) => rule.description === "Propose the synchronized Pi stack as one reviewed migration",
    );
    const notes = piRule.prBodyNotes.join("\n");

    expect(notes).toContain("copy the following into a new PR comment");
    expect(notes).toContain("@copilot Treat this as a Pi compatibility migration");
    expect(notes).toContain("skills/pi-upstream-recon/SKILL.md");
    expect(notes).toContain("all three Pi packages must resolve to the identical stable version");
    expect(notes).toContain("pnpm run verify:all");
    expect(notes).toContain("real authenticated Pi model smoke test");
    expect(notes).toContain("interactive TUI smoke test");
    expect(notes).toContain("Human review and merge are always required");
  });

  it("covers every exact-pinned direct Pi dependency in workspace manifests", async () => {
    const config = await readRenovateConfig();
    const piRule = config.packageRules.find(
      (rule) => rule.description === "Propose the synchronized Pi stack as one reviewed migration",
    );
    const manifests = await readWorkspaceManifests();
    const directPiDependencies = [];

    for (const { path, manifest } of manifests) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(manifest[section] ?? {})) {
          if (!name.startsWith("@earendil-works/pi-")) {
            continue;
          }
          directPiDependencies.push({ path, section, name, version });
        }
      }
    }

    expect([...new Set(directPiDependencies.map(({ name }) => name))].sort()).toEqual(
      expectedPiPackages,
    );
    expect([...piRule.matchPackageNames].sort()).toEqual(expectedPiPackages);
    expect(directPiDependencies).toHaveLength(4);
    for (const dependency of directPiDependencies) {
      expect(dependency.version, `${dependency.path} ${dependency.name}`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
  });
});

async function readRenovateConfig() {
  return JSON.parse(await readFile(renovateConfigPath, "utf8"));
}

async function readWorkspaceManifests() {
  const paths = ["package.json"];
  for (const workspaceRoot of ["packages", "extras"]) {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(join(workspaceRoot, entry.name, "package.json"));
      }
    }
  }

  return Promise.all(
    paths.map(async (path) => ({
      path,
      manifest: JSON.parse(await readFile(path, "utf8")),
    })),
  );
}

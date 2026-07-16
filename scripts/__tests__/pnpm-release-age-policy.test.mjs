import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NO_RELEASE_AGE_POLICY_COMMENT,
  inspectPnpmReleaseAgePolicy,
} from "../pnpm-release-age-policy.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("pnpm release-age policy", () => {
  it("keeps the checked-in workspace honest when no cooldown is enforced", async () => {
    const workspaceSource = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const guidance = await readFile(join(repoRoot, "skills/pi-upstream-recon/SKILL.md"), "utf8");

    expect(inspectPnpmReleaseAgePolicy(workspaceSource, packageJson.packageManager)).toEqual({
      claimsNoPolicy: true,
      hasExclusions: false,
      issues: [],
      minimumReleaseAge: undefined,
    });
    expect(guidance).toContain("intentionally enforces no `minimumReleaseAge` today");
    expect(guidance).toContain("current unpinned `pnpm >=10` range is not enough");
  });

  it("does not hide release-age policy in a pnpm-version-dependent .npmrc", async () => {
    const npmrc = await readOptionalFile(join(repoRoot, ".npmrc"));

    expect(npmrc).not.toMatch(
      /^\s*minimum(?:ReleaseAge|-release-age)(?:Exclude|-exclude)?(?:\[\])?\s*=/mu,
    );
  });

  it("rejects exclusions without a positive cooldown", () => {
    const source = [
      `# ${NO_RELEASE_AGE_POLICY_COMMENT}`,
      "minimumReleaseAgeExclude:",
      "  - '@example/new-package@1.0.0'",
    ].join("\n");

    expect(inspectPnpmReleaseAgePolicy(source).issues).toEqual([
      "minimumReleaseAgeExclude requires a positive top-level minimumReleaseAge in pnpm-workspace.yaml.",
    ]);
  });

  it("accepts an explicitly enabled cooldown with narrowly scoped exclusions", () => {
    const source = [
      "minimumReleaseAge: 1440",
      "minimumReleaseAgeExclude:",
      "  - '@example/new-package@1.0.0'",
    ].join("\n");

    expect(inspectPnpmReleaseAgePolicy(source, "pnpm@10.28.2")).toEqual({
      claimsNoPolicy: false,
      hasExclusions: true,
      issues: [],
      minimumReleaseAge: 1440,
    });
  });

  it("rejects an enabled policy without a package-manager pin that can enforce it", () => {
    expect(inspectPnpmReleaseAgePolicy("minimumReleaseAge: 1440\n").issues).toEqual([
      "A positive minimumReleaseAge requires an exact packageManager pnpm pin; engines.pnpm alone is not enforced.",
    ]);
    expect(inspectPnpmReleaseAgePolicy(
      "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - package-a\n",
      "pnpm@10.18.0",
    ).issues).toEqual([
      "Configured release-age policy requires pnpm >=10.19.0.",
    ]);
    expect(inspectPnpmReleaseAgePolicy(
      "minimumReleaseAge: 1440\n",
      "pnpm@10.15.9",
    ).issues).toEqual([
      "Configured release-age policy requires pnpm >=10.16.0.",
    ]);
  });

  it("rejects zero, malformed, and stale-comment policy claims", () => {
    expect(inspectPnpmReleaseAgePolicy([
      "minimumReleaseAge: 0",
      "minimumReleaseAgeExclude:",
      "  - package-a",
    ].join("\n")).issues).toEqual([
      "minimumReleaseAgeExclude requires a positive top-level minimumReleaseAge in pnpm-workspace.yaml.",
    ]);

    expect(inspectPnpmReleaseAgePolicy("minimumReleaseAge: tomorrow\n").issues).toEqual([
      "minimumReleaseAge must be a non-negative integer number of minutes.",
    ]);

    expect(inspectPnpmReleaseAgePolicy([
      `# ${NO_RELEASE_AGE_POLICY_COMMENT}`,
      "minimumReleaseAge: 1440",
    ].join("\n"), "pnpm@10.28.2").issues).toEqual([
      `Workspace comment says "${NO_RELEASE_AGE_POLICY_COMMENT}" but minimumReleaseAge is positive.`,
    ]);
  });
});

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

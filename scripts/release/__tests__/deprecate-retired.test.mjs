import fs from "node:fs";

import { describe, expect, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";
import { RETIRED_PACKAGES, retiredPackageProblems } from "../deprecate-retired.mjs";

describe("retired npm package deprecation", () => {
  test("points every retired name at a current publishable package", () => {
    expect(retiredPackageProblems()).toEqual([]);
  });

  test("flags a retired name that is published again or points nowhere", () => {
    const catalog = [
      { name: "@mono-agent/app", publishable: true },
      { name: "@mono-agent/old", publishable: true },
    ];
    expect(retiredPackageProblems([
      { name: "@mono-agent/old", replacement: "@mono-agent/app", message: "Use app." },
      { name: "@mono-agent/gone", replacement: "@mono-agent/missing", message: "" },
    ], catalog)).toEqual([
      "@mono-agent/old is still a publishable catalog package",
      "@mono-agent/gone points at @mono-agent/missing, which is not a publishable catalog package",
      "@mono-agent/gone needs a 1-1024 character message",
    ]);
  });

  test("covers every name the turn package rejects as renamed", () => {
    const source = fs.readFileSync(
      new URL("../../../packages/turn/src/host/package-renames.ts", import.meta.url),
      "utf8",
    );
    const renames = [...source.matchAll(/"(@mono-agent\/[^"]+)": "(@mono-agent\/[^"]+)"/gu)];
    expect(renames.length).toBeGreaterThan(0);
    for (const [, oldName, newName] of renames) {
      expect(RETIRED_PACKAGES).toContainEqual(expect.objectContaining({ name: oldName, replacement: newName }));
    }
    expect(packageCatalog.some((entry) => entry.name === "@mono-agent/turn")).toBe(true);
  });

  test("runs only on manual dispatch with the release token and a dry-run default", () => {
    const workflow = fs.readFileSync(
      new URL("../../../.github/workflows/npm-deprecate.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toMatch(/on:\n  workflow_dispatch:/u);
    expect(workflow).not.toMatch(/^\s+(push|pull_request|schedule):/mu);
    expect(workflow).toContain("default: true");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });
});

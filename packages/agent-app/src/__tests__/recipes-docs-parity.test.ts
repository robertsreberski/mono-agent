import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { recipeIds } from "../recipes/index.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this test until the pnpm workspace root (the dir with pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

/**
 * docs/reference/recipes.md is the human-facing catalog of the executable
 * recipes. Adding a recipe without its row there fails here — same contract as
 * the env-vars/feature-registry parity tests.
 */
describe("recipes docs parity", () => {
  const page = readFileSync(join(repoRoot(), "docs/reference/recipes.md"), "utf8");

  it("documents every recipe id from the catalog", () => {
    for (const id of recipeIds()) {
      expect(page, `docs/reference/recipes.md is missing recipe \`${id}\``).toContain(`\`${id}\``);
    }
  });

  it("does not document recipe ids that no longer exist", () => {
    const documented = [...page.matchAll(/^\| `([a-z0-9-]+)` \|/gmu)].map((match) => match[1]);
    expect(documented.length).toBeGreaterThan(0);
    const known = new Set(recipeIds());
    for (const id of documented) {
      expect(known, `docs/reference/recipes.md documents unknown recipe \`${id}\``).toContain(id);
    }
  });
});

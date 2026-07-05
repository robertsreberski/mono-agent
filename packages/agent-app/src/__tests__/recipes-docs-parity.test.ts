import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findRecipe, recipeIds, resolveRecipeInputs } from "../recipes/index.js";

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

  it("keeps the sandboxed-code playbook JSON aligned with the executable recipe", () => {
    const recipe = findRecipe("sandboxed-code-agent");
    if (recipe === undefined) {
      throw new Error("sandboxed-code-agent recipe not found");
    }
    const config = recipe.config(resolveRecipeInputs(recipe));
    const playbook = readFileSync(join(repoRoot(), "docs/playbooks/sandboxed-code-agent.md"), "utf8");
    const snippet = parseJsonBlock(playbook) as {
      readonly tools?: { readonly allowedTools?: readonly string[] };
      readonly sandbox?: {
        readonly mode?: string;
        readonly network?: { readonly mode?: string };
        readonly readableRoots?: readonly string[];
        readonly writableRoots?: readonly string[];
        readonly fallback?: string;
      };
    };

    expect(snippet.tools?.allowedTools).toEqual(config.tools?.allowedTools);
    expect(snippet.sandbox).toMatchObject({
      mode: config.sandbox?.mode,
      network: config.sandbox?.network,
      readableRoots: config.sandbox?.readableRoots,
      writableRoots: config.sandbox?.writableRoots,
      fallback: config.sandbox?.fallback,
    });
  });
});

function parseJsonBlock(markdown: string): unknown {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/u);
  if (match === null) {
    throw new Error("markdown page has no json code block");
  }
  return JSON.parse(match[1] ?? "");
}

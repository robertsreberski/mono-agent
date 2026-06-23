import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RECIPE_CATALOG, findRecipe, recipeIds, resolveRecipeInputs } from "../recipes/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-recipes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("recipe catalog", () => {
  it("exposes a non-empty, id-unique catalog", () => {
    expect(RECIPE_CATALOG.length).toBeGreaterThanOrEqual(11);
    const ids = recipeIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findRecipe resolves every catalog id and rejects unknown ids", () => {
    for (const id of recipeIds()) {
      expect(findRecipe(id)?.id).toBe(id);
    }
    expect(findRecipe("does-not-exist")).toBeUndefined();
  });

  it("maps every starter recipe to an existing playbook file", () => {
    const root = repoRoot();
    for (const recipe of RECIPE_CATALOG) {
      if (recipe.playbook === undefined) {
        continue;
      }
      const path = join(root, "docs/playbooks", recipe.playbook);
      expect(existsSync(path), `${recipe.id} -> ${recipe.playbook}`).toBe(true);
    }
  });

  it("never writes a secret value into the generated JSON", () => {
    for (const recipe of RECIPE_CATALOG) {
      const json = JSON.stringify(recipe.config(resolveRecipeInputs(recipe)));
      // Secrets only ever appear as .env placeholders, never inlined.
      expect(json).not.toMatch(/xoxb-|xapp-|sk-[A-Za-z0-9]/u);
    }
  });
});

describe("recipe configs validate against the real loader", () => {
  for (const recipe of RECIPE_CATALOG) {
    it(`${recipe.id} produces a config that loads`, async () => {
      const configPath = join(dir, "mono-agent.config.json");
      const json = recipe.config(resolveRecipeInputs(recipe));
      await writeFile(configPath, JSON.stringify(json, null, 2), "utf8");
      const config = await loadMonoAgentConfigWithSources({
        env: {},
        cwd: dir,
        jsonPath: configPath,
      });
      expect(config.runtime.model).toBeDefined();
    });
  }
});

describe("recipe .env.example only declares secret env vars", () => {
  for (const recipe of RECIPE_CATALOG.filter((entry) => entry.envExample !== undefined)) {
    it(`${recipe.id} env example references its declared secret env vars`, () => {
      const envText = recipe.envExample?.(resolveRecipeInputs(recipe)) ?? "";
      const secretVars = recipe.inputs
        .filter((input) => input.secret === true && input.envVar !== undefined)
        .map((input) => input.envVar as string);
      for (const envVar of secretVars) {
        expect(envText).toContain(envVar);
      }
    });
  }
});

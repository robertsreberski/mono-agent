import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs, renderRecipeList, renderRecipeShow } from "../cli.js";
import { initMonoAgentFolder } from "../init.js";
import { findRecipe, recipeIds } from "../recipes/index.js";

describe("parseCliArgs recipe flags", () => {
  it("collects positionals for `recipes show <id>`", () => {
    expect(parseCliArgs(["recipes", "show", "minimal-webhook"])).toMatchObject({
      command: "recipes",
      positionals: ["show", "minimal-webhook"],
    });
  });

  it("parses init --recipe --with --dry-run", () => {
    expect(parseCliArgs(["init", "--recipe", "full-safe", "--with", "slack,cron", "--dry-run"])).toMatchObject({
      command: "init",
      recipe: "full-safe",
      withChannels: ["slack", "cron"],
      dryRun: true,
    });
  });

  it("parses validate --recipe", () => {
    expect(parseCliArgs(["validate", "--recipe", "cron-digest"])).toMatchObject({
      command: "validate",
      recipe: "cron-digest",
    });
  });
});

describe("renderRecipeList", () => {
  it("lists every catalog recipe id", () => {
    const out = renderRecipeList();
    for (const id of recipeIds()) {
      expect(out).toContain(id);
    }
  });
});

describe("renderRecipeShow", () => {
  it("includes the generated config, env example, and checklist", () => {
    const recipe = findRecipe("personal-telegram-bujo");
    expect(recipe).toBeDefined();
    const out = renderRecipeShow(recipe!);
    expect(out).toContain("Generated mono-agent.config.json");
    expect(out).toContain("\"telegram\"");
    expect(out).toContain(".env.example");
    expect(out).toContain("MONO_AGENT_TELEGRAM_TOKEN");
    expect(out).toContain("Follow-up checklist");
    // The redacted token is never inlined into the generated JSON.
    expect(out).not.toMatch(/"botToken"\s*:\s*"\S/u);
  });

  it("lists scaffolded files for a recipe that emits them", () => {
    const recipe = findRecipe("cron-digest");
    const out = renderRecipeShow(recipe!);
    expect(out).toContain("Scaffolded files");
    expect(out).toContain("cron/digest.md");
  });
});

describe("init --recipe --dry-run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mono-agent-init-recipe-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("plans files without writing anything", async () => {
    const recipe = findRecipe("cron-digest")!;
    const result = await initMonoAgentFolder({ dir, recipe, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.created.some((path) => path.endsWith("mono-agent.config.json"))).toBe(true);
    expect(result.created.some((path) => path.endsWith("digest.md"))).toBe(true);
    // Nothing was actually written.
    expect(await readdir(dir)).toEqual([]);
    expect(existsSync(join(dir, "mono-agent.config.json"))).toBe(false);
  });

  it("writes the recipe config and scaffolds files for real", async () => {
    const recipe = findRecipe("cron-digest")!;
    const result = await initMonoAgentFolder({ dir, recipe });
    expect(result.dryRun).toBe(false);
    expect(existsSync(join(dir, "mono-agent.config.json"))).toBe(true);
    expect(existsSync(join(dir, "cron", "digest.md"))).toBe(true);
  });
});

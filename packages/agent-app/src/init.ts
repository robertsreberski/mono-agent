import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { writeMonoAgentConfigJson } from "@mono-agent/config";
import type { MonoAgentConfigJson } from "@mono-agent/config";

import { resolveRecipeInputs } from "./recipes/index.js";
import type { AgentRecipe, RecipeInputValues } from "./recipes/index.js";

/** Channels `--with` can switch on, merged onto a recipe's config. */
export const WITH_CHANNELS = ["telegram", "slack", "whatsapp", "a2a", "webhook", "openaiApi", "cron"] as const;
export type WithChannel = (typeof WITH_CHANNELS)[number];

export function isWithChannel(value: string): value is WithChannel {
  return (WITH_CHANNELS as readonly string[]).includes(value);
}

export interface InitMonoAgentFolderOptions {
  /** Folder the agent is constructed in. Defaults to process.cwd(). */
  readonly dir?: string;
  /** Primary runtime model reference written into the config. */
  readonly model?: string;
  /** Ordered backup model references written into the config. */
  readonly fallbackModels?: readonly string[];
  /** Memory strategy: omitted = no memory section. Ignored when a recipe is given. */
  readonly memory?: "lite" | "journal" | "bujo";
  /** When set, the config comes from this recipe instead of the default scaffold. */
  readonly recipe?: AgentRecipe;
  /** Prompted non-secret values to layer onto recipe defaults. Secret recipe inputs are ignored. */
  readonly recipeInputs?: RecipeInputValues;
  /** Additional channels to enable on top of the (recipe or default) config. */
  readonly withChannels?: readonly WithChannel[];
  /** Plan the scaffold and report it without writing anything. */
  readonly dryRun?: boolean;
}

export interface InitMonoAgentFolderResult {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  /** Files and directories created (or, with dryRun, that would be created). */
  readonly created: readonly string[];
  /** Files that already existed and were left untouched (absolute paths). */
  readonly skipped: readonly string[];
  /** Existing knowledge files the generated identity references. */
  readonly knowledgeFiles: readonly string[];
  /** True when nothing was written because dryRun was set. */
  readonly dryRun: boolean;
}

const DEFAULT_MODEL = "claude:claude-sonnet-4-6";
const KNOWLEDGE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md", "SOUL.md"];

/**
 * Non-destructively scaffolds a config-first mono-agent folder: a
 * `mono-agent.config.json` (from the default smoke scaffold or a recipe), an
 * `IDENTITY.md` seeded from any knowledge files already in the folder, the
 * `.mono-agent/` working directories, and — for recipes — a `.env.example` and
 * any recipe files. Existing files are never overwritten. With `dryRun`, nothing
 * is written and `created` reports what would have been.
 */
export async function initMonoAgentFolder(
  options: InitMonoAgentFolderOptions = {},
): Promise<InitMonoAgentFolderResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const dryRun = options.dryRun === true;
  const created: string[] = [];
  const skipped: string[] = [];

  const knowledgeFiles: string[] = [];
  for (const candidate of KNOWLEDGE_FILE_CANDIDATES) {
    if (await pathExists(join(dir, candidate))) {
      knowledgeFiles.push(candidate);
    }
  }

  async function planFile(path: string, write: () => Promise<unknown>): Promise<void> {
    if (await pathExists(path)) {
      skipped.push(path);
      return;
    }
    if (!dryRun) {
      await write();
    }
    created.push(path);
  }

  const identityPath = join(dir, "IDENTITY.md");
  await planFile(identityPath, () => writeFile(identityPath, identityTemplate(dir, knowledgeFiles), { flag: "wx" }));

  for (const subdir of [join(dir, ".mono-agent", "artifacts"), join(dir, ".mono-agent", "workspace")]) {
    await planFile(subdir, () => mkdir(subdir, { recursive: true }));
  }

  const skillsRootExists = await pathExists(join(dir, "skills"));
  const configJson = await resolveConfigJson(dir, options, skillsRootExists);
  const configPath = join(dir, "mono-agent.config.json");
  await planFile(configPath, () => writeMonoAgentConfigJson({ path: configPath, patch: configJson }));

  if (options.recipe !== undefined) {
    const inputs = resolveRecipeInputs(options.recipe, recipeOverrides(options.recipe, options));
    const envExample = options.recipe.envExample?.(inputs);
    if (envExample !== undefined && envExample.trim().length > 0) {
      const envExamplePath = join(dir, ".env.example");
      await planFile(envExamplePath, () => writeFile(envExamplePath, envExample, { flag: "wx" }));
    }
    for (const file of options.recipe.files?.(inputs) ?? []) {
      const filePath = join(dir, file.path);
      await planFile(filePath, async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, file.contents, { flag: "wx" });
      });
    }
  }

  return { dir, configPath, identityPath, created, skipped, knowledgeFiles, dryRun };
}

function recipeOverrides(recipe: AgentRecipe, options: InitMonoAgentFolderOptions): RecipeInputValues {
  const overrides: Record<string, string | undefined> = { ...(options.recipeInputs ?? {}) };
  for (const input of recipe.inputs) {
    if (input.secret === true) {
      delete overrides[input.id];
    }
  }
  if (options.model !== undefined) {
    overrides.model = options.model;
  }
  return overrides;
}

async function resolveConfigJson(
  dir: string,
  options: InitMonoAgentFolderOptions,
  skillsRootExists: boolean,
): Promise<MonoAgentConfigJson> {
  if (options.recipe !== undefined) {
    const inputs = resolveRecipeInputs(options.recipe, recipeOverrides(options.recipe, options));
    return withChannels(withRuntimeOverrides(options.recipe.config(inputs), options), options.withChannels ?? []);
  }
  return withChannels(configTemplate(dir, options, skillsRootExists), options.withChannels ?? []);
}

function withRuntimeOverrides(
  config: MonoAgentConfigJson,
  options: InitMonoAgentFolderOptions,
): MonoAgentConfigJson {
  const fallbackModels = (options.fallbackModels ?? []).filter((entry) => entry.trim().length > 0);
  if (fallbackModels.length === 0) {
    return config;
  }
  return {
    ...config,
    runtime: {
      ...(config.runtime ?? {}),
      fallbackModels,
    },
  } as MonoAgentConfigJson;
}

/** Switch on additional channels by merging `{ <channel>: { enabled: true } }`. */
function withChannels(
  config: MonoAgentConfigJson,
  channels: readonly WithChannel[],
): MonoAgentConfigJson {
  if (channels.length === 0) {
    return config;
  }
  const extra: Record<string, unknown> = {};
  for (const channel of channels) {
    extra[channel] = { enabled: true };
  }
  return { ...config, ...extra } as MonoAgentConfigJson;
}

function configTemplate(
  dir: string,
  options: InitMonoAgentFolderOptions,
  skillsRootExists: boolean,
): MonoAgentConfigJson {
  const fallbackModels = (options.fallbackModels ?? []).filter((entry) => entry.trim().length > 0);
  return {
    runtime: {
      model: options.model ?? DEFAULT_MODEL,
      ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
      workspace: ".",
    },
    context: {
      identityPath: "./IDENTITY.md",
      selectedSkills: [],
      ...(skillsRootExists ? { skillsRoot: "./skills" } : {}),
    },
    ...(options.memory === undefined
      ? {}
      : {
          memory: {
            mode: options.memory,
            path: "./.mono-agent/memory",
            writeMode: "append-host-summary" as const,
          },
        }),
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "./.mono-agent/artifacts",
    },
    traceability: {
      registryDir: "./.mono-agent/trace-sources",
      sourceLabel: `Mono Agent (${basename(dir)})`,
    },
    webhook: {
      enabled: true,
    },
  } as MonoAgentConfigJson;
}

function identityTemplate(dir: string, knowledgeFiles: readonly string[]): string {
  const knowledgeSection = knowledgeFiles.length === 0
    ? "This folder starts empty; describe the agent's purpose and boundaries here."
    : [
        "This folder already carries knowledge the agent must read and respect:",
        "",
        ...knowledgeFiles.map((file) => `- \`${file}\``),
      ].join("\n");

  return `# Identity

You are the mono agent constructed in \`${basename(dir)}\`.

## Role

Describe what this agent is for in one or two sentences.

## Knowledge

${knowledgeSection}

## Boundaries

- Work inside this folder unless the user explicitly widens the workspace.
- Confirm before destructive changes.
- Fail honestly: report runtime or tool errors instead of inventing results.
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

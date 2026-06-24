import { WITH_CHANNELS } from "./init.js";
import type { WithChannel } from "./init.js";
import { RECIPE_CATALOG } from "./recipes/index.js";
import type { AgentRecipe, RecipeInputValues, RecipeInput } from "./recipes/index.js";

export interface SetupPromptSource {
  question(prompt: string): Promise<string>;
}

export interface SecretChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly envVar?: string;
}

export interface CollectSetupOptions {
  readonly prompt: SetupPromptSource;
  readonly recipe?: AgentRecipe;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly withChannels?: readonly WithChannel[];
  readonly recipes?: readonly AgentRecipe[];
}

export interface CollectedSetupOptions {
  readonly recipe: AgentRecipe;
  readonly recipeInputs: RecipeInputValues;
  readonly fallbackModels: readonly string[];
  readonly withChannels: readonly WithChannel[];
  readonly secrets: readonly SecretChecklistItem[];
}

export async function collectSetupOptions(options: CollectSetupOptions): Promise<CollectedSetupOptions> {
  const recipes = options.recipes ?? RECIPE_CATALOG;
  const recipe = options.recipe ?? await promptForRecipe(options.prompt, recipes);
  const recipeInputs: Record<string, string | undefined> = {};
  const secrets: SecretChecklistItem[] = [];

  for (const input of recipe.inputs) {
    if (input.secret === true) {
      secrets.push(secretChecklistItem(input));
      continue;
    }
    const defaultValue = input.id === "model" && options.model !== undefined ? options.model : input.default;
    const answer = await options.prompt.question(inputPrompt(input, defaultValue));
    const value = answer.trim();
    if (value.length > 0) {
      recipeInputs[input.id] = value;
    } else if (defaultValue !== undefined) {
      recipeInputs[input.id] = defaultValue;
    }
  }

  const fallbackModels = await promptForFallbackModels(options.prompt, options.fallbackModels ?? []);
  const withChannels = await promptForWithChannels(options.prompt, options.withChannels ?? []);
  return { recipe, recipeInputs, fallbackModels, withChannels, secrets };
}

export function renderSetupRecipeMenu(recipes: readonly AgentRecipe[] = RECIPE_CATALOG): string {
  return recipes
    .map((recipe, index) => {
      const tags = recipe.tags.length === 0 ? "" : ` (${recipe.tags.join(", ")})`;
      return `${index + 1}. ${recipe.id} [risk: ${recipe.riskLevel}] - ${recipe.title}${tags}`;
    })
    .join("\n");
}

function inputPrompt(input: RecipeInput, defaultValue: string | undefined): string {
  const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
  return `${input.label}${suffix}\n${input.description}\n> `;
}

function secretChecklistItem(input: RecipeInput): SecretChecklistItem {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    ...(input.envVar === undefined ? {} : { envVar: input.envVar }),
  };
}

async function promptForRecipe(
  prompt: SetupPromptSource,
  recipes: readonly AgentRecipe[],
): Promise<AgentRecipe> {
  if (recipes.length === 0) {
    throw new Error("No setup recipes are available.");
  }
  for (;;) {
    const answer = await prompt.question(
      `Choose a recipe:\n${renderSetupRecipeMenu(recipes)}\nRecipe [1]: `,
    );
    const selected = parseRecipeChoice(answer, recipes);
    if (selected !== undefined) {
      return selected;
    }
  }
}

function parseRecipeChoice(answer: string, recipes: readonly AgentRecipe[]): AgentRecipe | undefined {
  const value = answer.trim();
  if (value.length === 0) {
    return recipes[0];
  }
  const index = Number(value);
  if (Number.isInteger(index) && index >= 1 && index <= recipes.length) {
    return recipes[index - 1];
  }
  return recipes.find((recipe) => recipe.id === value);
}

async function promptForWithChannels(
  prompt: SetupPromptSource,
  defaults: readonly WithChannel[],
): Promise<readonly WithChannel[]> {
  const defaultText = defaults.length === 0 ? "none" : defaults.join(",");
  for (;;) {
    const answer = await prompt.question(
      `Enable add-on channels (${WITH_CHANNELS.join(", ")}) [${defaultText}]: `,
    );
    const raw = answer.trim();
    if (raw.length === 0) {
      return defaults;
    }
    const parsed = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const invalid = parsed.filter((entry) => !(WITH_CHANNELS as readonly string[]).includes(entry));
    if (invalid.length === 0) {
      return parsed as WithChannel[];
    }
  }
}

async function promptForFallbackModels(
  prompt: SetupPromptSource,
  defaults: readonly string[],
): Promise<readonly string[]> {
  const defaultText = defaults.length === 0 ? "none" : defaults.join(",");
  const answer = await prompt.question(`Fallback models, comma-separated [${defaultText}]: `);
  const raw = answer.trim();
  if (raw.length === 0) {
    return defaults;
  }
  if (raw.toLowerCase() === "none") {
    return [];
  }
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

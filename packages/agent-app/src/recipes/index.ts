import { RECIPE_CATALOG } from "./catalog.js";
import type { AgentRecipe } from "./types.js";

export type {
  AgentRecipe,
  GeneratedFile,
  RecipeInput,
  RecipeInputValues,
  RecipeValidateExpectation,
} from "./types.js";
export { resolveRecipeInputs } from "./types.js";
export { RECIPE_CATALOG } from "./catalog.js";

/** id -> recipe, for O(1) lookup by the CLI. */
export const RECIPES: ReadonlyMap<string, AgentRecipe> = new Map(
  RECIPE_CATALOG.map((recipe) => [recipe.id, recipe]),
);

/** Look up a recipe by id, or undefined when unknown. */
export function findRecipe(id: string): AgentRecipe | undefined {
  return RECIPES.get(id);
}

/** Every recipe id, in catalog order. */
export function recipeIds(): readonly string[] {
  return RECIPE_CATALOG.map((recipe) => recipe.id);
}

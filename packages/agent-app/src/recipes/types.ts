import type { MonoAgentConfigJson } from "@mono-agent/config";

import type { ValidationStatus } from "../doctor.js";

/**
 * A value the recipe templates against. Non-secret inputs carry a default and
 * may be overridden from the CLI; secret inputs are never written into JSON —
 * they only emit a `.env.example` placeholder via {@link AgentRecipe.envExample}.
 */
export interface RecipeInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Default used when the CLI does not override the input. */
  readonly default?: string;
  /** Secret inputs are externalized to `.env.example`, never inlined in JSON. */
  readonly secret?: boolean;
  /** The `MONO_AGENT_*` env var a secret input maps to (for `.env.example`). */
  readonly envVar?: string;
}

/** Resolved input values keyed by {@link RecipeInput.id}. */
export type RecipeInputValues = Readonly<Record<string, string | undefined>>;

/** An auxiliary file a recipe scaffolds beside the config (e.g. a cron job markdown). */
export interface GeneratedFile {
  /** Path relative to the agent folder. */
  readonly path: string;
  readonly contents: string;
}

/**
 * A capability the recipe promises once secrets are filled in. `mono-agent
 * validate --recipe <id>` checks each expectation against the doctor report and
 * reports "selected recipe incomplete" when a required section is not yet at the
 * promised status (e.g. a channel still `waiting` on a token).
 */
export interface RecipeValidateExpectation {
  /** Doctor section id, e.g. `runtime`, `memory`, `channel:telegram`. */
  readonly sectionId: string;
  /** The status the section must reach for the recipe to be considered live. */
  readonly mustBe: ValidationStatus;
  /** Human note explaining what to do if the expectation is unmet. */
  readonly note?: string;
}

/**
 * A typed, testable blueprint that compiles to an ordinary
 * `mono-agent.config.json` plus optional `.env.example` placeholders and
 * follow-up files. Recipes never change runtime contracts — they only emit JSON
 * the existing loader already accepts — and never write secrets into the config.
 */
export interface AgentRecipe {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly riskLevel: "low" | "medium" | "high";
  /**
   * The `docs/playbooks/<playbook>.md` this recipe mirrors, parity-checked to
   * exist. The composite "full" blueprints have no single playbook and omit it.
   */
  readonly playbook?: string;
  readonly inputs: readonly RecipeInput[];
  /** Build the `mono-agent.config.json` contents from resolved inputs. */
  readonly config: (input: RecipeInputValues) => MonoAgentConfigJson;
  /** `.env.example` lines for the secrets this recipe needs (never in JSON). */
  readonly envExample?: (input: RecipeInputValues) => string;
  /** Extra files to scaffold (cron job markdown, etc.). */
  readonly files?: (input: RecipeInputValues) => readonly GeneratedFile[];
  /** Capabilities `validate --recipe` checks once secrets are supplied. */
  readonly validateExpectations: readonly RecipeValidateExpectation[];
}

/** Resolve declared input defaults, then layer CLI overrides on top. */
export function resolveRecipeInputs(
  recipe: AgentRecipe,
  overrides: RecipeInputValues = {},
): RecipeInputValues {
  const values: Record<string, string | undefined> = {};
  for (const input of recipe.inputs) {
    values[input.id] = overrides[input.id] ?? input.default;
  }
  // Preserve overrides that don't correspond to a declared input (forward-compat).
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in values)) {
      values[key] = value;
    }
  }
  return values;
}

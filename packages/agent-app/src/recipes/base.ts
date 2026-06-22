import type { MonoAgentConfigJson } from "@mono-agent/config";

import type { RecipeInput, RecipeInputValues } from "./types.js";

export const DEFAULT_MODEL = "claude:claude-sonnet-4-6";

/** The model input every recipe shares; overridable from `--model`. */
export const MODEL_INPUT: RecipeInput = {
  id: "model",
  label: "Model",
  description: "Primary runtime model reference, e.g. claude:claude-sonnet-4-6, codex:gpt-5.5, pi:ollama:gemma4:31b.",
  default: DEFAULT_MODEL,
};

/**
 * The adapter-neutral skeleton every recipe extends: runtime model, identity,
 * empty tool policy, local artifacts, and the trace registry. Recipes spread
 * this and add their channel / memory / sandbox / observability blocks. Mirrors
 * `init.ts`'s scaffold so a recipe-built folder matches a hand-init'd one.
 */
export function baseConfig(input: RecipeInputValues): MonoAgentConfigJson {
  return {
    runtime: {
      model: input.model ?? DEFAULT_MODEL,
      workspace: ".",
    },
    context: {
      identityPath: "./IDENTITY.md",
      selectedSkills: [],
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "./.mono-agent/artifacts",
    },
    traceability: {
      registryDir: "./.mono-agent/trace-sources",
    },
  } as MonoAgentConfigJson;
}

/** A `memory` block for the given tier, rooted at the standard memory path. */
export function memoryBlock(
  mode: "lite" | "journal" | "bujo",
): NonNullable<MonoAgentConfigJson["memory"]> {
  return {
    mode,
    path: "./.mono-agent/memory",
    writeMode: mode === "bujo" ? "capture" : "append-host-summary",
  };
}

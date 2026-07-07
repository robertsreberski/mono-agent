import type { MonoAgentConfigJson } from "@mono-agent/config";

import type { ModuleInput } from "./types.js";

export const DEFAULT_MODEL = "claude:claude-sonnet-4-6";

/** The model input every composed agent shares; overridable from the wizard/CLI. */
export const MODEL_INPUT: ModuleInput = {
  id: "model",
  label: "Model",
  description: "Primary runtime model reference, e.g. claude:claude-sonnet-4-6, codex:gpt-5.5, pi:ollama:llama3.1:8b.",
  default: DEFAULT_MODEL,
};

/** Context the base skeleton needs that is derived from the target folder, not from inputs. */
export interface BaseConfigContext {
  /** Basename of the agent folder → `traceability.sourceLabel`. */
  readonly dirBasename: string;
  /** Add `context.skillsRoot: "./skills"` only when a `skills/` directory exists. */
  readonly skillsRootExists: boolean;
}

/**
 * The adapter-neutral skeleton the composer builds on: runtime model, identity,
 * empty tool policy, local artifacts, and the trace registry. Returned WITHOUT
 * `$schema` (the composer adds it once at the end). Mirrors `init.ts`'s
 * `configTemplate` exactly for the fields it owns, so a composed default config
 * is byte-equal to today's scaffold EXCEPT `tools.allowedTools` (the composer
 * fills that from the wizard's tools selection). Modules add the
 * memory / channel / sandbox / observability blocks.
 */
export function baseConfig(
  ctx: BaseConfigContext,
  model: string,
  fallbackModels: readonly string[],
): MonoAgentConfigJson {
  return {
    runtime: {
      model,
      ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
      workspace: ".",
    },
    context: {
      identityPath: "./IDENTITY.md",
      selectedSkills: [],
      ...(ctx.skillsRootExists ? { skillsRoot: "./skills" } : {}),
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "./.mono-agent/artifacts",
      retention: {
        maxAgeDays: 365,
        maxCount: 50000,
        dryRun: false,
      },
    },
    traceability: {
      registryDir: "./.mono-agent/trace-sources",
      sourceLabel: `Mono Agent (${ctx.dirBasename})`,
    },
  };
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

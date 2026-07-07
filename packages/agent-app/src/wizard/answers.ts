import type { MonoAgentConfigJson } from "@mono-agent/config";

import { monoAgentConfigWithSchema } from "../config-reference.js";
import {
  ADAPTER_SEND_TOOL_NAMES,
  baseConfig,
  BUILTIN_TOOL_NAMES,
  type CapabilityModule,
  DEFAULT_MODEL,
  DEFAULT_SAFE_TOOLS,
  findModule,
  type GeneratedFile,
  type ModuleInputValues,
  type ModuleValidateExpectation,
  resolveModuleInputs,
} from "../modules/index.js";

/**
 * The complete set of choices the wizard (or a preset) makes. This is the single
 * input to {@link composeWizardPlan}: everything the composer needs to emit a full
 * `mono-agent.config.json`, `.env.example`, and follow-up files is derived from it.
 */
export interface WizardAnswers {
  readonly model: string;
  readonly fallbackModels: readonly string[];
  /** Channel module ids, e.g. `["channel:webhook","channel:telegram"]`. */
  readonly channels: readonly string[];
  /** Memory module id, or `undefined` for no memory section. */
  readonly memory?: string;
  readonly sandbox: boolean;
  readonly observability: boolean;
  /** Final tool selection written into `tools.allowedTools`. */
  readonly allowedTools: readonly string[];
  /** Per module id → non-secret input overrides. Secret inputs are stripped by the composer. */
  readonly moduleInputs: Readonly<Record<string, ModuleInputValues>>;
}

/** Folder-derived context the base skeleton needs (not from wizard inputs). */
export interface ComposeContext {
  readonly dirBasename: string;
  readonly skillsRootExists: boolean;
}

/**
 * One secret the composed agent still needs. The CLI prints the checklist as
 * `- <label>: <description>` and points the operator at `<envVar>` in `.env`.
 */
export interface SecretChecklistItem {
  readonly moduleId: string;
  readonly label: string;
  readonly envVar: string;
  readonly description: string;
}

/**
 * The single artifact of config generation: the JSON to write (with `$schema`),
 * the optional `.env.example`, follow-up files, the secret checklist, the selected
 * modules, the validate expectations, and any authoring warnings.
 */
export interface WizardPlan {
  readonly configJson: MonoAgentConfigJson;
  /** Joined module `envExampleLines` plus a trailing newline; `undefined` when none. */
  readonly envExample?: string;
  readonly files: readonly GeneratedFile[];
  readonly secrets: readonly SecretChecklistItem[];
  readonly selectedModules: readonly CapabilityModule[];
  readonly validateExpectations: readonly ModuleValidateExpectation[];
  readonly warnings: readonly string[];
}

/** Tools ordered canonically: built-ins first, then adapter send tools. */
const ORDERED_TOOL_NAMES: readonly string[] = [...BUILTIN_TOOL_NAMES, ...ADAPTER_SEND_TOOL_NAMES];

const ZERO_TOOLS_WARNING =
  "Zero tools selected — the agent will be chat-only: it cannot read files, run commands, or send proactive messages.";

/**
 * The module ids selected by these answers, in composer order: auto-derived
 * providers first (from a `pi:ollama:*`/`pi:lmstudio:*` model), then channels (in
 * answer order), then the memory tier, then sandbox, then observability.
 */
function selectedModuleIds(answers: WizardAnswers): readonly string[] {
  const ids: string[] = [];
  if (/^pi:ollama:/u.test(answers.model)) {
    ids.push("provider:ollama");
  }
  if (/^pi:lmstudio:/u.test(answers.model)) {
    ids.push("provider:lmstudio");
  }
  for (const channel of answers.channels) {
    ids.push(channel);
  }
  if (answers.memory !== undefined) {
    ids.push(answers.memory);
  }
  if (answers.sandbox) {
    ids.push("sandbox");
  }
  if (answers.observability) {
    ids.push("observability:phoenix");
  }
  return ids;
}

/** Resolve the selected module ids to modules, skipping unknown ids defensively. */
function selectedModules(answers: WizardAnswers): readonly CapabilityModule[] {
  const modules: CapabilityModule[] = [];
  for (const id of selectedModuleIds(answers)) {
    const module = findModule(id);
    if (module !== undefined) {
      modules.push(module);
    }
  }
  return modules;
}

/**
 * The recommended `allowedTools` for these answers: the read-only safe defaults
 * plus every selected module's `recommendedTools`, deduped and ordered by the
 * canonical BUILTIN∪ADAPTER position. Deterministic — no Set-iteration reliance.
 */
export function recommendedToolSelection(answers: WizardAnswers): readonly string[] {
  const union = new Set<string>(DEFAULT_SAFE_TOOLS);
  for (const module of selectedModules(answers)) {
    for (const tool of module.recommendedTools ?? []) {
      union.add(tool);
    }
  }
  return ORDERED_TOOL_NAMES.filter((name) => union.has(name));
}

const BASE_ANSWERS: WizardAnswers = {
  model: DEFAULT_MODEL,
  fallbackModels: [],
  channels: ["channel:webhook"],
  // `memory` is intentionally omitted (no memory section) — with
  // exactOptionalPropertyTypes an optional key must be absent, not `undefined`.
  sandbox: false,
  observability: false,
  allowedTools: [],
  moduleInputs: {},
};

/**
 * The wizard's starting answers with `overrides` shallow-merged on top. Unless an
 * explicit `allowedTools` override is supplied, `allowedTools` is recomputed from
 * {@link recommendedToolSelection} so selecting a channel/memory/sandbox auto-checks
 * its recommended tools. An explicit `[]` override is preserved (the chat-only case).
 */
export function defaultAnswers(overrides?: Partial<WizardAnswers>): WizardAnswers {
  const merged: WizardAnswers = { ...BASE_ANSWERS, ...overrides };
  const allowedTools = overrides?.allowedTools ?? recommendedToolSelection(merged);
  return { ...merged, allowedTools };
}

/** Overrides for one module: the shared model plus its non-secret input values. */
function moduleOverrides(module: CapabilityModule, answers: WizardAnswers): Record<string, string | undefined> {
  const overrides: Record<string, string | undefined> = {
    model: answers.model,
    ...(answers.moduleInputs[module.id] ?? {}),
  };
  // Defense in depth: a secret-declared value must never reach a fragment or the JSON.
  for (const input of module.inputs) {
    if (input.secret === true) {
      delete overrides[input.id];
    }
  }
  return overrides;
}

/** Merge a module fragment onto the working config, concatenating `channels.plugins`. */
function applyFragment(config: Record<string, unknown>, fragment: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "channels") {
      const existing = (config.channels as Record<string, unknown> | undefined) ?? {};
      const incoming = (value as Record<string, unknown> | undefined) ?? {};
      const existingPlugins = Array.isArray(existing.plugins) ? existing.plugins : [];
      const incomingPlugins = Array.isArray(incoming.plugins) ? incoming.plugins : [];
      const plugins = [...existingPlugins, ...incomingPlugins];
      config.channels = {
        ...existing,
        ...incoming,
        ...(plugins.length > 0 ? { plugins } : {}),
      };
      continue;
    }
    config[key] = value;
  }
}

/**
 * The single config-generation path: turn wizard answers into a complete
 * `WizardPlan`. Fragments are composed onto the adapter-neutral base skeleton;
 * secret inputs are stripped before any fragment runs, so a secret value can never
 * reach the JSON. The composed default config is byte-equal to today's `init.ts`
 * scaffold except `tools.allowedTools` (filled from the wizard's tools selection).
 */
export function composeWizardPlan(answers: WizardAnswers, ctx: ComposeContext): WizardPlan {
  const modules = selectedModules(answers);
  const config: Record<string, unknown> = {
    ...baseConfig(ctx, answers.model, answers.fallbackModels),
  };

  const files: GeneratedFile[] = [];
  const secrets: SecretChecklistItem[] = [];
  const envLines: string[] = [];
  const validateExpectations: ModuleValidateExpectation[] = [{ sectionId: "runtime", mustBe: "ok" }];
  let providerOllamaSelected = false;

  for (const module of modules) {
    if (module.id === "provider:ollama") {
      providerOllamaSelected = true;
    }
    const values = resolveModuleInputs(module, moduleOverrides(module, answers));
    applyFragment(config, module.configFragment(values));

    for (const line of module.envExampleLines?.(values) ?? []) {
      envLines.push(line);
    }
    for (const file of module.files?.(values) ?? []) {
      files.push(file);
    }
    for (const input of module.inputs) {
      if (input.secret === true && input.envVar !== undefined) {
        secrets.push({
          moduleId: module.id,
          label: input.label,
          envVar: input.envVar,
          description: input.description,
        });
      }
    }
    for (const expectation of module.validateExpectations) {
      validateExpectations.push(expectation);
    }
  }

  config.tools = {
    ...((config.tools as Record<string, unknown> | undefined) ?? {}),
    allowedTools: [...answers.allowedTools],
    disallowedTools: [],
  };

  // The local-ollama endpoint mirrors the old recipe: only when the ollama
  // provider is present AND memory embeddings actually target ollama.
  const memory = config.memory as (Record<string, unknown> & { embeddings?: Record<string, unknown> }) | undefined;
  if (providerOllamaSelected && memory?.embeddings !== undefined && memory.embeddings.provider === "ollama") {
    config.memory = {
      ...memory,
      embeddings: { ...memory.embeddings, endpoint: "http://localhost:11434" },
    };
  }

  const configJson = monoAgentConfigWithSchema(config as unknown as MonoAgentConfigJson);
  const envExample = envLines.length > 0 ? `${envLines.join("\n")}\n` : undefined;
  const warnings = answers.allowedTools.length === 0 ? [ZERO_TOOLS_WARNING] : [];

  return {
    configJson,
    ...(envExample === undefined ? {} : { envExample }),
    files,
    secrets,
    selectedModules: modules,
    validateExpectations: dedupeExpectations(validateExpectations),
    warnings,
  };
}

/** Dedupe validate expectations by `sectionId`, keeping the first occurrence. */
function dedupeExpectations(
  expectations: readonly ModuleValidateExpectation[],
): readonly ModuleValidateExpectation[] {
  const seen = new Set<string>();
  const out: ModuleValidateExpectation[] = [];
  for (const expectation of expectations) {
    if (seen.has(expectation.sectionId)) {
      continue;
    }
    seen.add(expectation.sectionId);
    out.push(expectation);
  }
  return out;
}

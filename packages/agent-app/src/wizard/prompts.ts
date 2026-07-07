import * as p from "@clack/prompts";

import { findModule, modulesByKind } from "../modules/catalog.js";
import { ADAPTER_SEND_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "../modules/known-tools.js";
import { PRESET_CATALOG } from "./presets.js";

/**
 * One `@clack/prompts` `select`/`multiselect` option. `value` is the machine key
 * the wizard maps back onto {@link WizardAnswers}; `label`/`hint` are display-only.
 */
export interface WizardSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * Thrown when a clack prompt returns its cancel symbol (Ctrl-C / Esc). The wizard
 * catches it once at the top and turns it into a clean `p.cancel` — nothing is
 * ever written, because {@link runInitWizard} only collects answers.
 */
export class WizardCancelled extends Error {
  constructor() {
    super("Wizard cancelled.");
    this.name = "WizardCancelled";
  }
}

/**
 * Unwrap a clack prompt result: return the value, or throw {@link WizardCancelled}
 * when the user cancelled (clack signals cancel with a sentinel symbol). Every
 * prompt result must pass through here so a single top-level catch handles cancel.
 */
export function guard<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    throw new WizardCancelled();
  }
  return value;
}

/** Human hints for the built-in tools, shown beside each tool in the multiselect. */
const BUILTIN_TOOL_HINTS: Readonly<Record<string, string>> = {
  Read: "read files",
  Write: "create/overwrite files",
  Edit: "edit files",
  Glob: "find files by pattern",
  Grep: "search file contents",
  Bash: "run shell commands (pair with the sandbox)",
  WebFetch: "fetch a URL",
  WebSearch: "search the web",
};

const ADAPTER_SEND_TOOL_SET: ReadonlySet<string> = new Set(ADAPTER_SEND_TOOL_NAMES);

/**
 * Channel options for the "how will you talk to this agent?" multiselect: every
 * channel module in catalog order (webhook first), value = module id.
 */
export function channelSelectOptions(): WizardSelectOption[] {
  return modulesByKind("channel").map((module) => ({
    value: module.id,
    label: module.title,
    hint: module.summary,
  }));
}

/**
 * Memory options: a leading "None (stateless)" whose empty-string value maps to
 * `memory: undefined`, then every memory module in catalog order.
 */
export function memorySelectOptions(): WizardSelectOption[] {
  return [
    { value: "", label: "None (stateless)", hint: "no cross-conversation memory" },
    ...modulesByKind("memory").map((module) => ({
      value: module.id,
      label: module.title,
      hint: module.summary,
    })),
  ];
}

/**
 * A short curated model menu plus an `__other__` escape hatch that prompts for a
 * free-form `provider:model` reference.
 */
export function modelSelectOptions(): WizardSelectOption[] {
  return [
    { value: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "default" },
    { value: "codex:gpt-5.5", label: "Codex GPT-5.5" },
    { value: "pi:ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local" },
    { value: "__other__", label: "Other…", hint: "type a provider:model reference" },
  ];
}

/**
 * The tools multiselect: all eight built-ins first (with per-tool hints), then the
 * adapter send tools contributed by the selected channels (deduped, in channel
 * order). Value = tool name — the exact `tools.allowedTools` entry.
 */
export function toolMultiselectOptions(selectedChannelIds: readonly string[]): WizardSelectOption[] {
  const options: WizardSelectOption[] = BUILTIN_TOOL_NAMES.map((name) => ({
    value: name,
    label: name,
    ...(BUILTIN_TOOL_HINTS[name] === undefined ? {} : { hint: BUILTIN_TOOL_HINTS[name] }),
  }));

  const seen = new Set<string>(BUILTIN_TOOL_NAMES);
  for (const channelId of selectedChannelIds) {
    const module = findModule(channelId);
    if (module === undefined) {
      continue;
    }
    for (const tool of module.recommendedTools ?? []) {
      if (!ADAPTER_SEND_TOOL_SET.has(tool) || seen.has(tool)) {
        continue;
      }
      seen.add(tool);
      options.push({
        value: tool,
        label: tool,
        hint: `${tool} — proactive sends (${module.title} is on)`,
      });
    }
  }
  return options;
}

/**
 * The "start from…" menu: every preset (labelled with its risk + description),
 * ending with a "Custom" escape hatch that walks the full step-by-step flow.
 */
export function presetSelectOptions(): WizardSelectOption[] {
  return [
    ...PRESET_CATALOG.map((preset) => ({
      value: preset.id,
      label: preset.title,
      hint: `${preset.riskLevel} · ${preset.description}`,
    })),
    { value: "__custom__", label: "Custom — pick capabilities yourself" },
  ];
}

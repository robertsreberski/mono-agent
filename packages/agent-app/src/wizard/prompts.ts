import * as p from "@clack/prompts";
import { EFFORT_LEVELS } from "@mono-agent/config";

import { findModule, modulesByKind } from "../modules/catalog.js";
import { ADAPTER_SEND_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "../modules/known-tools.js";
import { STATIC_MODEL_CANDIDATES, type WizardModelCandidate } from "./model-discovery.js";
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
 * The action each adapter send tool performs; the owning channel's title is appended
 * so the hint reads e.g. `proactive send (Telegram)`. Keyed by PascalCase tool name.
 */
const ADAPTER_SEND_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  SlackSendMessage: "proactive send",
  TelegramSendMessage: "proactive send",
  TelegramAskButtons: "ask via tappable buttons, blocking",
  TelegramSendFile: "send a document or photo",
};

/**
 * The channel-agnostic interaction tool. Always offered (even for a restricted agent)
 * because it asks the human through whichever channel is live and waits for the reply.
 */
const ASK_USER_OPTION: WizardSelectOption = {
  value: "AskUser",
  label: "AskUser",
  hint: "ask the human and wait for a typed reply (any channel)",
};

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
 * A discovered/ranked model menu plus an `__other__` escape hatch that prompts
 * for a free-form `provider:model` reference.
 */
export function modelSelectOptions(candidates: readonly WizardModelCandidate[] = STATIC_MODEL_CANDIDATES): WizardSelectOption[] {
  return [
    ...candidates.map((candidate) => ({
      value: candidate.value,
      label: candidate.label,
      ...(candidate.hint === undefined ? {} : { hint: candidate.hint }),
    })),
    { value: "__other__", label: "Other…", hint: "type a provider:model reference" },
  ];
}

/** Reasoning-effort choices. Empty value means no `runtime.effort` is written. */
export function effortSelectOptions(): WizardSelectOption[] {
  return [
    { value: "", label: "Default", hint: "leave runtime.effort unset" },
    ...EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
  ];
}

/**
 * The "choose specific" tools multiselect: all eight built-ins first (with per-tool
 * hints), then the adapter send tools contributed by the selected channels (deduped,
 * in channel order, each hint naming its channel + action), then the channel-agnostic
 * `AskUser`. Value = tool name — the exact `tools.allowedTools` entry. The always-on
 * tools (`MemoryRecall`/`ReadSkill`/MCP) are auto-provisioned and never listed here.
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
      // `AskUser` is channel-agnostic and appended once at the end, not per channel.
      if (!ADAPTER_SEND_TOOL_SET.has(tool) || seen.has(tool) || tool === "AskUser") {
        continue;
      }
      seen.add(tool);
      const action = ADAPTER_SEND_TOOL_ACTIONS[tool] ?? "channel action";
      options.push({ value: tool, label: tool, hint: `${action} (${module.title})` });
    }
  }

  options.push(ASK_USER_OPTION);
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

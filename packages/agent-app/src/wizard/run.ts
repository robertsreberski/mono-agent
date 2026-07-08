import { stat } from "node:fs/promises";
import { basename, join } from "node:path";

import * as p from "@clack/prompts";

import { findModule } from "../modules/catalog.js";
import { ALLOW_ALL_TOOLS, BUILTIN_TOOL_NAMES, isAllowAllTools } from "../modules/known-tools.js";
import { planProviderSetup, providerSetupActionCommandLine } from "../provider-setup.js";
import {
  alwaysOnTools,
  composeWizardPlan,
  defaultAnswers,
  recommendedToolSelection,
  type WizardAnswers,
} from "./answers.js";
import { findPreset, presetAnswers } from "./presets.js";
import {
  channelSelectOptions,
  effortSelectOptions,
  guard,
  memorySelectOptions,
  modelSelectOptions,
  presetSelectOptions,
  toolMultiselectOptions,
  WizardCancelled,
} from "./prompts.js";
import { discoverWizardModelCandidates, formatModelDiscoveryStatus } from "./model-discovery.js";

/** The outcome of a wizard run: collected answers, or a clean cancellation. */
export type WizardOutcome =
  | { readonly status: "answers"; readonly answers: WizardAnswers; readonly runProviderSetup: boolean }
  | { readonly status: "cancelled" };

/**
 * A mutable working copy of {@link WizardAnswers} the flow builds up prompt by
 * prompt. `memory` stays `string | undefined` here (unlike the exact-optional
 * `WizardAnswers`); {@link toWizardAnswers} folds `undefined` into an absent key.
 */
interface DraftAnswers {
  model: string;
  fallbackModels: string[];
  effort: string | undefined;
  channels: string[];
  memory: string | undefined;
  sandbox: boolean;
  observability: boolean;
  allowedTools: string[];
  moduleInputs: Record<string, Record<string, string>>;
}

const LOCAL_PROVIDER_MODEL = /^pi:(?:ollama|lmstudio):/u;
const SANDBOXABLE_TOOLS = new Set(["Bash", "Write", "Edit"]);

interface CollectedAnswers {
  readonly answers: WizardAnswers;
  readonly runProviderSetup: boolean;
}

/**
 * The interactive `init` wizard: a colourful, step-by-step flow that COLLECTS a
 * {@link WizardAnswers} and hands it back — it never writes anything. The caller
 * (`runInit`) does the scaffold/validate/print. Ctrl-C at any prompt unwinds
 * through {@link WizardCancelled} to a single clean `p.cancel`, so a cancelled
 * wizard leaves the folder untouched.
 */
export async function runInitWizard(ctx: { cwd: string }): Promise<WizardOutcome> {
  try {
    const result = await collectAnswers(ctx);
    return { status: "answers", answers: result.answers, runProviderSetup: result.runProviderSetup };
  } catch (error) {
    if (error instanceof WizardCancelled) {
      p.cancel("Cancelled — nothing was written.");
      return { status: "cancelled" };
    }
    throw error;
  }
}

/** Walk the flow (preset or custom), returning the fully collected answers. */
async function collectAnswers(ctx: { cwd: string }): Promise<CollectedAnswers> {
  p.intro("mono-agent init — let's build your agent");

  const choice = guard(
    await p.select({
      message: "Start from…",
      options: presetSelectOptions(),
      initialValue: "__custom__",
    }),
  );

  return choice === "__custom__"
    ? await collectCustom(ctx)
    : await collectFromPreset(ctx, choice);
}

/**
 * The full custom flow: model → effort → channels → memory → per-module inputs
 * → tools → sandbox (only if code tools were chosen) → observability → summary.
 */
async function collectCustom(ctx: { cwd: string }): Promise<CollectedAnswers> {
  const draft = draftFrom(defaultAnswers());

  // 1. Model.
  const discovery = await discoverWizardModelCandidates();
  p.note(formatModelDiscoveryStatus(discovery.statuses), "Model discovery");
  const model = guard(
    await p.select({
      message: "Which model?",
      options: modelSelectOptions(discovery.candidates),
      initialValue: "claude:claude-sonnet-4-6",
    }),
  );
  draft.model = model === "__other__"
    ? guard(
        await p.text({
          message: "Model reference",
          placeholder: "pi:ollama:llama3.1:8b",
          validate: (v) =>
            (v ?? "").trim().length === 0
              ? "Enter a provider:model reference (e.g. pi:ollama:llama3.1:8b)"
              : undefined,
        }),
      )
    : model;

  // Optional fallback chain.
  if (guard(await p.confirm({ message: "Add fallback models?", initialValue: false }))) {
    const raw = guard(
      await p.text({
        message: "Fallback models (comma-separated)",
        placeholder: "codex:gpt-5.5, pi:ollama:llama3.1:8b",
      }),
    );
    draft.fallbackModels = splitCsv(raw);
  }

  const effort = guard(
    await p.select({
      message: "Reasoning effort?",
      options: effortSelectOptions(),
      initialValue: "",
    }),
  );
  draft.effort = effort.length === 0 ? undefined : effort;

  // 2. Channels.
  const channels = guard(
    await p.multiselect({
      message: "How will you talk to this agent?",
      options: channelSelectOptions(),
      initialValues: ["channel:webhook"],
      required: false,
    }),
  );
  draft.channels = [...channels];

  // 3. Memory (before per-module inputs so a memory module's inputs are prompted).
  const memory = guard(
    await p.select({
      message: "Should the agent remember across conversations?",
      options: memorySelectOptions(),
      initialValue: "",
    }),
  );
  draft.memory = memory === "" ? undefined : memory;

  // 4. Per-module (non-secret) inputs for the chosen channels + memory.
  await promptModuleInputs(draft);

  // 5. Tools.
  await promptTools(draft);

  // 6. Sandbox — only meaningful once shell/file tools are in play. Allow-all
  // includes Bash/Write/Edit, so the sandbox question must still appear under it.
  if (isAllowAllTools(draft.allowedTools) || draft.allowedTools.some((tool) => SANDBOXABLE_TOOLS.has(tool))) {
    draft.sandbox = guard(
      await p.confirm({
        message: "Sandbox shell/file tools? (native srt, localhost-only network, fails closed if srt is missing)",
        initialValue: true,
      }),
    );
  }

  // 7. Observability.
  draft.observability = guard(
    await p.confirm({
      message: "Export traces to Phoenix (best-effort OTLP, sensitive data excluded)?",
      initialValue: false,
    }),
  );

  // 8. Summary + final confirm.
  const runProviderSetup = await confirmSummary(draft, ctx);
  return { answers: toWizardAnswers(draft), runProviderSetup };
}

/**
 * The preset flow: the preset fixes model/channels/memory/sandbox/observability,
 * so we only prompt its per-module inputs, let the operator adjust tools, and
 * confirm the summary.
 */
async function collectFromPreset(ctx: { cwd: string }, presetId: string): Promise<CollectedAnswers> {
  const preset = findPreset(presetId);
  // presetSelectOptions only offers known ids; guard defensively regardless.
  if (preset === undefined) {
    throw new WizardCancelled();
  }
  p.log.step(`Preset: ${preset.title}`);

  const draft = draftFrom(presetAnswers(preset));
  await promptModuleInputs(draft);
  await promptTools(draft);
  const runProviderSetup = await confirmSummary(draft, ctx);
  return { answers: toWizardAnswers(draft), runProviderSetup };
}

/**
 * Prompt every non-secret input of the selected channel + memory modules and store
 * the answers into `draft.moduleInputs`. Secret inputs are never prompted — they
 * only ever surface as `.env.example` placeholders.
 */
async function promptModuleInputs(draft: DraftAnswers): Promise<void> {
  const moduleIds = [...draft.channels, ...(draft.memory === undefined ? [] : [draft.memory])];
  for (const id of moduleIds) {
    const module = findModule(id);
    if (module === undefined) {
      continue;
    }
    for (const input of module.inputs) {
      if (input.secret === true) {
        continue;
      }
      const answer = guard(
        await p.text({
          message: `${module.title}: ${input.label}`,
          placeholder: input.description,
          ...(input.default === undefined ? {} : { defaultValue: input.default }),
        }),
      );
      const trimmed = answer.trim();
      if (trimmed.length > 0) {
        (draft.moduleInputs[module.id] ??= {})[input.id] = trimmed;
      }
    }
  }
}

/** Short reasons annotating each always-on tool in the framing note. */
const ALWAYS_ON_TOOL_REASONS: Readonly<Record<string, string>> = {
  MemoryRecall: "memory recall is on",
};

/** The always-on tool names annotated with their reason, e.g. `MemoryRecall (memory recall is on)`. */
function alwaysOnDisplay(alwaysOn: readonly string[]): string[] {
  return alwaysOn.map((tool) => {
    const reason = ALWAYS_ON_TOOL_REASONS[tool];
    return reason === undefined ? tool : `${tool} (${reason})`;
  });
}

/**
 * The channel-contributed send/ask tools for the enabled channels (PascalCase),
 * minus the channel-agnostic `AskUser` (surfaced on its own line). Reuses the
 * multiselect option builder so the framing note can never drift from the picker.
 */
function channelSendTools(channels: readonly string[]): string[] {
  return toolMultiselectOptions(channels)
    .slice(BUILTIN_TOOL_NAMES.length)
    .map((option) => option.value)
    .filter((value) => value !== "AskUser");
}

/**
 * The three tool families, explained before the allow-all decision so the operator
 * knows what "Allow all" turns on and what is unaffected by the choice:
 *   1. Always on — auto-provisioned, NOT gated by this choice (e.g. MemoryRecall).
 *   2. Built-ins — file/shell/web tools.
 *   3. Channel tools — the send/ask tools that came with the channels you enabled,
 *      plus AskUser (ask the human, any channel).
 */
function toolSituationFraming(draft: DraftAnswers, alwaysOn: readonly string[]): string {
  const sends = channelSendTools(draft.channels);
  const channelLine = sends.length > 0
    ? `Channel tools (from the channels you enabled): ${sends.join(", ")}, plus AskUser (ask the human, any channel).`
    : "Channel tools: AskUser (ask the human, any channel).";
  return [
    alwaysOn.length > 0
      ? `Always on (auto-provisioned, not affected by this choice): ${alwaysOnDisplay(alwaysOn).join(", ")}.`
      : "Always on (auto-provisioned): none for this setup.",
    "Built-ins: files (Read/Write/Edit/Glob/Grep), shell (Bash), web (WebFetch/WebSearch).",
    channelLine,
    '"Allow all" turns on every built-in and channel tool; you can turn specific tools off later via tools.disallowedTools.',
  ].join("\n");
}

/**
 * The tools step: frame the three tool families, then a single "Allow all tools?"
 * confirm (default yes → `["*"]`). Choosing "No" drops into the specific-tool
 * multiselect. Always-on tools (MemoryRecall/ReadSkill/MCP) are auto-provisioned and
 * are surfaced only for clarity — never gated by this choice.
 */
async function promptTools(draft: DraftAnswers): Promise<void> {
  const alwaysOn = alwaysOnTools(toWizardAnswers(draft));
  p.note(toolSituationFraming(draft, alwaysOn), "Tools");

  const allowAll = guard(
    await p.confirm({
      message: "Allow all tools? (recommended — the model can use every built-in and your channels' tools)",
      initialValue: true,
    }),
  );
  if (allowAll) {
    draft.allowedTools = [ALLOW_ALL_TOOLS];
    return;
  }

  await pickSpecificTools(draft);
}

/**
 * The "choose specific tools" multiselect, pre-checking the recommended selection for
 * the current capabilities. An empty selection loops back unless the operator confirms
 * the chat-only warning. The final list is ordered by the option order so
 * `tools.allowedTools` is deterministic regardless of toggle order.
 */
async function pickSpecificTools(draft: DraftAnswers): Promise<void> {
  const options = toolMultiselectOptions(draft.channels);
  const optionOrder = new Map(options.map((option, index) => [option.value, index]));
  const recommended = recommendedToolSelection(toWizardAnswers(draft));

  for (;;) {
    const tools = guard(
      await p.multiselect({
        message: "Which tools may the model call?",
        options,
        initialValues: [...recommended],
        required: false,
      }),
    );

    if (tools.length === 0) {
      const proceed = guard(
        await p.confirm({
          message:
            "⚠ Zero tools selected — the agent will be chat-only (cannot read files, run commands, or send proactively). Continue?",
          initialValue: false,
        }),
      );
      if (!proceed) {
        continue;
      }
    }

    draft.allowedTools = [...tools].sort(
      (a, b) => (optionOrder.get(a) ?? 0) - (optionOrder.get(b) ?? 0),
    );
    return;
  }
}

/**
 * Render the compact plan summary and ask for the single write-time confirmation.
 * Provider modules are implementation detail (auto-added for local models), so
 * they are excluded from the user-facing capabilities line. A "no" cancels.
 */
async function confirmSummary(draft: DraftAnswers, ctx: { cwd: string }): Promise<boolean> {
  if ([draft.model, ...draft.fallbackModels].some((model) => LOCAL_PROVIDER_MODEL.test(model))) {
    p.note(
      "A matching local provider block is added automatically.\nThe first turn may be slow while the model loads.",
      "Local model",
    );
  }

  const answers = toWizardAnswers(draft);
  const plan = composeWizardPlan(answers, {
    dirBasename: basename(ctx.cwd),
    skillsRootExists: await pathExists(join(ctx.cwd, "skills")),
  });

  const capabilities = plan.selectedModules
    .filter((module) => module.kind !== "provider")
    .map((module) => module.title);

  const writes = ["mono-agent.config.json", "IDENTITY.md"];
  if (plan.envExample !== undefined) {
    writes.push(".env.example");
  }
  for (const file of plan.files) {
    writes.push(file.path);
  }

  const secrets = plan.secrets.map((secret) => secret.envVar);
  const toolsLine = isAllowAllTools(draft.allowedTools)
    ? "all tools"
    : draft.allowedTools.length > 0
      ? draft.allowedTools.join(", ")
      : "none (chat-only)";
  const alwaysOn = alwaysOnTools(answers);
  const lines = [
    `Model:        ${draft.model}${draft.fallbackModels.length > 0 ? `  (fallbacks: ${draft.fallbackModels.join(", ")})` : ""}`,
    `Effort:       ${draft.effort ?? "default"}`,
    `Capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "none"}`,
    `Tools:        ${toolsLine}`,
    ...(alwaysOn.length > 0 ? [`Always on:    ${alwaysOnDisplay(alwaysOn).join(", ")}`] : []),
    `Writes:       ${writes.join(", ")}`,
    `Secrets:      ${secrets.length > 0 ? `${secrets.join(", ")} → .env.example` : "none"}`,
  ];
  p.note(lines.join("\n"), "Review");

  const setupPlan = planProviderSetup({
    modelRefs: [answers.model, ...answers.fallbackModels],
    cwd: ctx.cwd,
    ...(typeof plan.configJson.providers?.piAuthPath === "string" ? { piAuthPath: plan.configJson.providers.piAuthPath } : {}),
  });
  let runProviderSetup = false;
  if (setupPlan.actions.length > 0) {
    p.note(
      setupPlan.actions
        .map((action) => `${action.label}: ${providerSetupActionCommandLine(action)} (cwd: ${action.cwd})`)
        .join("\n"),
      "Provider setup",
    );
    runProviderSetup = guard(
      await p.confirm({
        message: "Run provider auth/preflight before writing files?",
        initialValue: false,
      }),
    );
  }

  if (!guard(await p.confirm({ message: "Write these files?", initialValue: true }))) {
    throw new WizardCancelled();
  }
  return runProviderSetup;
}

/** Seed a mutable draft from immutable answers (defaults or a preset). */
function draftFrom(answers: WizardAnswers): DraftAnswers {
  const moduleInputs: Record<string, Record<string, string>> = {};
  for (const [moduleId, values] of Object.entries(answers.moduleInputs)) {
    const bag: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        bag[key] = value;
      }
    }
    moduleInputs[moduleId] = bag;
  }
  return {
    model: answers.model,
    fallbackModels: [...answers.fallbackModels],
    effort: answers.effort,
    channels: [...answers.channels],
    memory: answers.memory,
    sandbox: answers.sandbox,
    observability: answers.observability,
    allowedTools: [...answers.allowedTools],
    moduleInputs,
  };
}

/**
 * Freeze a draft back into {@link WizardAnswers}. `memory` is omitted entirely when
 * undefined (exactOptionalPropertyTypes: an optional key must be absent, not
 * `undefined`).
 */
function toWizardAnswers(draft: DraftAnswers): WizardAnswers {
  return {
    model: draft.model,
    fallbackModels: [...draft.fallbackModels],
    ...(draft.effort === undefined ? {} : { effort: draft.effort }),
    channels: [...draft.channels],
    ...(draft.memory === undefined ? {} : { memory: draft.memory }),
    sandbox: draft.sandbox,
    observability: draft.observability,
    allowedTools: [...draft.allowedTools],
    moduleInputs: draft.moduleInputs,
  };
}

/** Split a comma-separated string into trimmed, non-empty entries. */
function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** True when `path` exists (a local mirror of the CLI's private helper). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

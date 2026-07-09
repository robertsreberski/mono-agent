import { stat } from "node:fs/promises";
import { basename, join } from "node:path";

import * as p from "@clack/prompts";

import { findModule } from "../modules/catalog.js";
import { ALLOW_ALL_TOOLS, BUILTIN_TOOL_NAMES, isAllowAllTools } from "../modules/known-tools.js";
import { isProviderSetupPiApiKeyAction, planProviderSetup, providerSetupActionCommandLine } from "../provider-setup.js";
import {
  alwaysOnTools,
  composeWizardPlan,
  defaultAnswers,
  recommendedToolSelection,
  type WizardAnswers,
} from "./answers.js";
import { findPreset, presetAnswers } from "./presets.js";
import {
  assertConcreteWizardModelRef,
  channelSelectOptions,
  CUSTOM_PI_MODEL_OPTION,
  effortSelectOptions,
  fallbackModelSelectOptions,
  guard,
  memorySelectOptions,
  modelSelectOptions,
  piModelSelectOptions,
  presetSelectOptions,
  toolMultiselectOptions,
  WizardCancelled,
} from "./prompts.js";
import {
  defaultEffortForModelRef,
  discoverWizardModelCandidates,
  formatModelDiscoveryStatus,
  type WizardModelCandidate,
} from "./model-discovery.js";

/** The outcome of a wizard run: collected answers, or a clean cancellation. */
export type WizardOutcome =
  | {
      readonly status: "answers";
      readonly answers: WizardAnswers;
      readonly runProviderSetup: boolean;
      readonly providerSetupSecrets: Readonly<Record<string, string>>;
      /** Required selected module secrets, kept in memory until secure init persists them. */
      readonly moduleSecrets: Readonly<Record<string, string>>;
    }
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

interface ModelResolutionOptions {
  readonly candidates: readonly WizardModelCandidate[];
  readonly excludedModels?: readonly string[];
  readonly context: "primary" | "fallback";
}

interface CollectedAnswers {
  readonly answers: WizardAnswers;
  readonly runProviderSetup: boolean;
  readonly providerSetupSecrets: Readonly<Record<string, string>>;
  readonly moduleSecrets: Readonly<Record<string, string>>;
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
    return {
      status: "answers",
      answers: result.answers,
      runProviderSetup: result.runProviderSetup,
      providerSetupSecrets: result.providerSetupSecrets,
      moduleSecrets: result.moduleSecrets,
    };
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
  return await collectInteractiveFromSeed(ctx, defaultAnswers());
}

async function resolveModelSelection(model: string, opts: ModelResolutionOptions): Promise<string> {
  if (model === "__pi_other__") {
    return await promptPiModelSelection(opts);
  }

  if (model === "__other__") {
    const resolved = guard(
      await p.text({
        message: opts.context === "primary" ? "Model reference" : "Fallback model reference",
        placeholder: "pi:ollama:llama3.1:8b",
        validate: validateFullModelReference,
      }),
    ).trim();
    assertConcreteWizardModelRef(resolved);
    return resolved;
  }

  assertConcreteWizardModelRef(model);
  return model;
}

async function promptPiModelSelection(opts: ModelResolutionOptions): Promise<string> {
  const options = piModelSelectOptions(opts.candidates, opts.excludedModels ?? []);
  const choice = guard(
    await p.select({
      message: opts.context === "primary" ? "Other Pi model" : "Other Pi fallback model",
      options,
      initialValue: options[0]?.value ?? CUSTOM_PI_MODEL_OPTION,
    }),
  );

  if (choice !== CUSTOM_PI_MODEL_OPTION) {
    assertConcreteWizardModelRef(choice);
    return choice;
  }

  return await promptManualPiModelRef();
}

async function promptManualPiModelRef(): Promise<string> {
  const provider = guard(
    await p.text({
      message: "Pi provider id",
      placeholder: "openai-codex",
      validate: (v) => {
        const value = (v ?? "").trim();
        if (value.length === 0) {
          return "Enter a Pi provider id (e.g. openai-codex, opencode-go, ollama, lmstudio)";
        }
        return value.includes(":") ? "Provider id cannot contain ':'." : undefined;
      },
    }),
  ).trim();
  const modelId = guard(
    await p.text({
      message: "Pi model id",
      placeholder: provider === "openai-codex" ? "gpt-5.5" : "llama3.1:8b",
      validate: (v) =>
        (v ?? "").trim().length === 0
          ? "Enter the provider-specific model id (e.g. gpt-5.5, kimi-k2.6, llama3.1:8b)"
          : undefined,
    }),
  ).trim();
  return `pi:${provider}:${modelId}`;
}

function validateFullModelReference(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    return "Enter a provider:model reference (e.g. pi:ollama:llama3.1:8b)";
  }
  if (trimmed.includes(",")) {
    return "Enter one model reference. Add more fallbacks one at a time.";
  }
  try {
    assertConcreteWizardModelRef(trimmed);
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a concrete model reference.";
  }
  return undefined;
}

/**
 * Build an ordered fallback chain one model at a time. Each step reuses the same
 * discovered model labels as the primary picker while hiding the selected primary
 * and any fallback already chosen. `Other…` is the explicit path for custom refs.
 */
async function promptFallbackModels(
  draft: DraftAnswers,
  candidates: readonly WizardModelCandidate[],
): Promise<void> {
  for (;;) {
    const choice = guard(
      await p.select({
        message: `Fallback model #${draft.fallbackModels.length + 1}`,
        options: fallbackModelSelectOptions(candidates, draft.model, draft.fallbackModels),
        initialValue: "__done__",
      }),
    );
    if (choice === "__done__") {
      return;
    }
    const resolved = await resolveModelSelection(choice, {
      candidates,
      excludedModels: [draft.model, ...draft.fallbackModels],
      context: "fallback",
    });
    if (resolved !== draft.model && !draft.fallbackModels.includes(resolved)) {
      draft.fallbackModels.push(resolved);
    }
  }
}

/**
 * Presets seed every choice, but do not silently freeze them. A first run must
 * still choose its model, channels, tool policy, and sandbox safety posture.
 */
async function collectFromPreset(ctx: { cwd: string }, presetId: string): Promise<CollectedAnswers> {
  const preset = findPreset(presetId);
  // presetSelectOptions only offers known ids; guard defensively regardless.
  if (preset === undefined) {
    throw new WizardCancelled();
  }
  p.log.step(`Preset: ${preset.title}`);

  return await collectInteractiveFromSeed(ctx, presetAnswers(preset));
}

/** Shared custom/preset first-run chooser; seed answers only set sensible defaults. */
async function collectInteractiveFromSeed(ctx: { cwd: string }, seed: WizardAnswers): Promise<CollectedAnswers> {
  const draft = draftFrom(seed);
  const discovery = await discoverWizardModelCandidates();
  const discoveredByValue = new Map(discovery.candidates.map((candidate) => [candidate.value, candidate]));
  p.note(formatModelDiscoveryStatus(discovery.statuses), "Model discovery");
  const model = guard(await p.select({
    message: "Which model?",
    options: modelSelectOptions(discovery.candidates),
    initialValue: draft.model,
  }));
  draft.model = await resolveModelSelection(model, { candidates: discovery.candidates, context: "primary" });
  draft.fallbackModels = [];
  if (guard(await p.confirm({ message: "Add fallback models?", initialValue: false }))) {
    await promptFallbackModels(draft, discovery.candidates);
  }
  const derivedEffort = discoveredByValue.get(draft.model)?.defaultEffort ?? defaultEffortForModelRef(draft.model);
  const effort = guard(await p.select({
    message: derivedEffort === undefined ? "Reasoning effort?" : `Reasoning effort? (derived from selected model: ${derivedEffort})`,
    options: effortSelectOptions(derivedEffort),
    initialValue: draft.effort ?? derivedEffort ?? "",
  }));
  draft.effort = effort.length === 0 ? undefined : effort;
  draft.channels = [...guard(await p.multiselect({
    message: "How will you talk to this agent?",
    options: channelSelectOptions({ readyOnly: true }),
    initialValues: draft.channels,
    required: false,
  }))];
  const memory = guard(await p.select({
    message: "Should the agent remember across conversations?",
    options: memorySelectOptions(),
    initialValue: draft.memory ?? "",
  }));
  draft.memory = memory === "" ? undefined : memory;
  await promptModuleInputs(draft);
  await promptTools(draft);
  if (isAllowAllTools(draft.allowedTools) || draft.allowedTools.some((tool) => SANDBOXABLE_TOOLS.has(tool))) {
    draft.sandbox = guard(await p.confirm({
      message: "Sandbox shell/file tools? (native srt, localhost-only network, fails closed if srt is missing)",
      initialValue: true,
    }));
  } else {
    draft.sandbox = false;
  }
  draft.observability = guard(await p.confirm({
    message: "Export traces to Phoenix (best-effort OTLP, sensitive data excluded)?",
    initialValue: draft.observability,
  }));
  const providerSetup = await confirmSummary(draft, ctx);
  const answers = toWizardAnswers(draft);
  return { answers, ...providerSetup, moduleSecrets: await promptRequiredModuleSecrets(answers) };
}

/**
 * Prompt every non-secret input of the selected channel + memory modules and store
 * the answers into `draft.moduleInputs`. Required secrets are collected only after
 * the write confirmation so they can never appear in the plan summary.
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

/** Collect only typed required secrets, masked and retained solely for this run. */
async function promptRequiredModuleSecrets(answers: WizardAnswers): Promise<Readonly<Record<string, string>>> {
  const plan = composeWizardPlan(answers, { dirBasename: "agent", skillsRootExists: false });
  const secrets: Record<string, string> = {};
  for (const secret of plan.secrets) {
    if (!secret.required) continue;
    secrets[secret.envVar] = guard(await p.password({
      message: `${secret.label} (${secret.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "This secret is required for the selected capability." : undefined,
      clearOnError: true,
    }));
  }
  return secrets;
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
async function confirmSummary(
  draft: DraftAnswers,
  ctx: { cwd: string },
): Promise<{ readonly runProviderSetup: boolean; readonly providerSetupSecrets: Readonly<Record<string, string>> }> {
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
  const providerSetupSecrets: Record<string, string> = {};
  if (setupPlan.actions.length > 0) {
    p.note(
      setupPlan.actions
        .map((action) => `${action.label}: ${providerSetupActionCommandLine(action)} (cwd: ${action.cwd})`)
        .join("\n"),
      "Provider setup",
    );
    runProviderSetup = guard(
      await p.confirm({
        message: setupPlan.actions.some((action) => action.id.startsWith("pi-login:"))
          ? "Run provider auth/preflight before writing files? (Pi OAuth setup can create/update the auth store)"
          : "Run provider auth/preflight before writing files?",
        initialValue: false,
      }),
    );
    if (runProviderSetup) {
      for (const action of setupPlan.actions) {
        if (!isProviderSetupPiApiKeyAction(action)) {
          continue;
        }
        providerSetupSecrets[action.id] = guard(
          await p.password({
            message: `${action.label} (${action.envVar})`,
            validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
            clearOnError: true,
          }),
        );
      }
    }
  }

  if (!guard(await p.confirm({ message: "Write these files?", initialValue: true }))) {
    throw new WizardCancelled();
  }
  return { runProviderSetup, providerSetupSecrets };
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
  for (const modelRef of [draft.model, ...draft.fallbackModels]) {
    assertConcreteWizardModelRef(modelRef);
  }
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

/** True when `path` exists (a local mirror of the CLI's private helper). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

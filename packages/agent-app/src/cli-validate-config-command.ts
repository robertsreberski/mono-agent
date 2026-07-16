import { basename, resolve } from "node:path";
import process from "node:process";

import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type { ConfigViewSection } from "@mono-agent/config";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
} from "./app-config.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { resolveChannelDrivers } from "./channels.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { findUnknownAppConfigWarnings } from "./config-reference.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type {
  ValidationReport,
  ValidationSection,
  ValidationStatus,
} from "./doctor.js";
import type { ModuleValidateExpectation } from "./modules/index.js";
import { composeWizardPlan } from "./wizard/answers.js";
import {
  findPreset,
  PRESET_CATALOG,
  presetAnswers,
  presetIds,
  RECIPE_TO_PRESET,
} from "./wizard/presets.js";
import type { WizardPreset } from "./wizard/presets.js";
import * as ui from "./ui.js";

interface ValidateContext {
  readonly cwd: string;
  readonly configPath: string;
  readonly envFilePath: string;
  readonly allowFilesystemWrites: boolean;
}

function resolveValidateContext(args: ParsedCliArgs, invocationCwd: string): ValidateContext {
  const cwd = resolve(invocationCwd, args.consumerPath ?? ".");
  return {
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
    envFilePath: resolve(cwd, args.envFile ?? ".env"),
    allowFilesystemWrites: args.consumerPath === undefined,
  };
}

export async function runValidate(args: ParsedCliArgs): Promise<number> {
  const context = resolveValidateContext(args, process.cwd());
  const report = await validateMonoAgentFolder({
    env: process.env,
    cwd: context.cwd,
    configPath: context.configPath,
    allowFilesystemWrites: context.allowFilesystemWrites,
  });

  const preset = resolveValidatePreset(args);
  if (preset === "unknown") {
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, sections: report.sections })}\n`);
    }
    return 1;
  }
  let presetResult:
    | {
        readonly id: string;
        readonly expectations: readonly {
          readonly sectionId: string;
          readonly expected: ValidationStatus;
          readonly actual: ValidationStatus | "missing";
          readonly met: boolean;
        }[];
      }
    | undefined;
  if (preset !== undefined) {
    const plan = composeWizardPlan(presetAnswers(preset), {
      dirBasename: basename(context.cwd),
      skillsRootExists: false,
    });
    presetResult = {
      id: preset.id,
      expectations: plan.validateExpectations.map((expectation) => {
        const actual = report.sections.find((entry) => entry.id === expectation.sectionId)?.status ?? "missing";
        return {
          sectionId: expectation.sectionId,
          expected: expectation.mustBe,
          actual,
          met: actual === expectation.mustBe,
        };
      }),
    };
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({
        ok: report.ok,
        sections: report.sections,
        preset: presetResult,
      })}\n`);
      return report.ok ? 0 : 1;
    }
    for (const section of report.sections) {
      process.stdout.write(formatSection(section));
    }
    process.stdout.write(renderPlanCompleteness(plan.validateExpectations, `Preset: ${preset.id}`, report));
  } else if (args.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: report.ok, sections: report.sections })}\n`);
    return report.ok ? 0 : 1;
  } else {
    for (const section of report.sections) {
      process.stdout.write(formatSection(section));
    }
  }

  const hasWaitingSections = report.sections.some((section) => section.status === "waiting");
  process.stdout.write(
    report.ok
      ? hasWaitingSections
        ? `\n${ui.style.yellow("⚠ Config is structurally valid, but needs attention before start.")}\n${ui.style.dim("Review the waiting sections above, then re-run mono-agent validate.")}\n`
        : `\n${ui.style.green("✓ Config is ready to start.")}\n${ui.style.dim("Run `mono-agent config` for the full field-by-field view.")}\n`
      : `\n${ui.hint("Fix the errors above, then re-run mono-agent validate.")}`,
  );
  process.stdout.write(
    ui.style.dim("Core sections activate by presence; channels need `enabled: true` — see docs/config (How sections activate).\n"),
  );
  return report.ok ? 0 : 1;
}

/**
 * Resolve the preset to check `validate` against: `--preset` wins, `--recipe` is a
 * deprecated alias. Returns the preset, `undefined` (no capability check), or
 * `"unknown"` after emitting the error/hint.
 */
function resolveValidatePreset(args: ParsedCliArgs): WizardPreset | undefined | "unknown" {
  if (args.preset !== undefined) {
    const preset = findPreset(args.preset);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Unknown preset \`${args.preset}\`.`));
      process.stderr.write(ui.hint(`Available presets: ${presetIds().join(", ")}. Run \`mono-agent presets list\`.`));
      return "unknown";
    }
    return preset;
  }
  if (args.recipe !== undefined) {
    const preset = RECIPE_TO_PRESET.get(args.recipe);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Recipe \`${args.recipe}\` was retired; validate against a preset instead.`));
      process.stderr.write(ui.hint(`Available presets: ${presetIds().join(", ")}. Run \`mono-agent presets list\`.`));
      return "unknown";
    }
    process.stderr.write(ui.hint(`--recipe is deprecated; using preset ${preset.id}. See \`mono-agent presets list\`.`));
    return preset;
  }
  return undefined;
}

/**
 * Capability-aware completeness check: for each capability a preset (or module
 * set) promises, report whether the matching doctor section reached the expected
 * status. `waiting` stays non-fatal (it never changes the validate exit code) but
 * is surfaced as "incomplete" so the operator knows what is left to wire up.
 */
export function renderPlanCompleteness(
  expectations: readonly ModuleValidateExpectation[],
  label: string,
  report: ValidationReport,
): string {
  let out = "\n" + ui.heading(label);
  let incomplete = 0;
  for (const expectation of expectations) {
    const section = report.sections.find((entry) => entry.id === expectation.sectionId);
    const status: ValidationStatus | "missing" = section?.status ?? "missing";
    const met = status === expectation.mustBe;
    if (!met) {
      incomplete += 1;
    }
    const badge = met ? ui.badge("ok") : ui.badge(status === "error" ? "error" : "waiting");
    out += `${badge}${ui.style.bold(expectation.sectionId)} ${ui.style.dim(`(${status}, expected ${expectation.mustBe})`)}\n`;
    if (!met && expectation.note !== undefined) {
      out += `    ${ui.style.dim(expectation.note)}\n`;
    }
  }
  out += incomplete === 0
    ? `${ui.style.green(`✓ ${label} is fully configured.`)}\n`
    : ui.style.yellow(`⚠ ${label} incomplete: ${incomplete} capability(ies) not yet live.\n`);
  return out;
}

export function riskColor(risk: WizardPreset["riskLevel"]): string {
  if (risk === "high") {
    return ui.style.red(risk);
  }
  if (risk === "medium") {
    return ui.style.yellow(risk);
  }
  return ui.style.green(risk);
}

/** `mono-agent presets list` — one block per preset. */
export function renderPresetList(): string {
  let out = ui.banner("mono-agent", "presets") + "\n";
  for (const preset of PRESET_CATALOG) {
    out += `${ui.style.bold(ui.style.cyan(preset.id))} ${ui.style.dim(`[${riskColor(preset.riskLevel)}]`)}\n`;
    out += `    ${preset.title}\n`;
    out += `    ${ui.style.dim(preset.description)}\n`;
  }
  out += "\n" + ui.style.dim("Scaffold one with: mono-agent init --preset <id>\n");
  out += ui.style.dim("Build interactively with: mono-agent init\n");
  return out;
}

/** `mono-agent presets show <id>` — description, composed JSON, env example, checklist. */
export function renderPresetShow(preset: WizardPreset): string {
  const plan = composeWizardPlan(presetAnswers(preset), { dirBasename: "your-agent", skillsRootExists: false });
  let out = ui.banner("mono-agent", `preset: ${preset.id}`) + "\n";
  out += `${ui.style.bold(preset.title)} ${ui.style.dim(`(risk: ${riskColor(preset.riskLevel)})`)}\n`;
  out += `${preset.description}\n`;
  if (preset.playbook !== undefined) {
    out += ui.style.dim(`Playbook: docs/playbooks/${preset.playbook}\n`);
  }
  out += "\n" + ui.heading("Generated mono-agent.config.json");
  out += JSON.stringify(plan.configJson, null, 2) + "\n";

  const envExample = plan.envExample;
  if (envExample !== undefined && envExample.trim().length > 0) {
    out += "\n" + ui.heading(".env.example");
    out += envExample.endsWith("\n") ? envExample : envExample + "\n";
  }

  if (plan.files.length > 0) {
    out += "\n" + ui.heading("Scaffolded files");
    for (const file of plan.files) {
      out += `  ${ui.style.cyan(file.path)}\n`;
    }
  }

  if (plan.validateExpectations.length > 0) {
    out += "\n" + ui.heading("Follow-up checklist");
    for (const expectation of plan.validateExpectations) {
      const note = expectation.note === undefined ? "" : ` — ${expectation.note}`;
      out += `  ${ui.style.gray("•")} ${expectation.sectionId} ${ui.style.dim(`must be ${expectation.mustBe}`)}${ui.style.dim(note)}\n`;
    }
  }
  return out;
}

/** Dispatch `mono-agent presets list|show <id>`. */
export function runPresets(args: ParsedCliArgs): number {
  const [sub, id] = args.positionals;
  if (sub === undefined || sub === "list") {
    process.stdout.write(renderPresetList());
    return 0;
  }
  if (sub === "show") {
    if (id === undefined) {
      process.stderr.write(ui.errorLine("Usage: mono-agent presets show <id>."));
      process.stderr.write(ui.hint(`Available: ${presetIds().join(", ")}.`));
      return 2;
    }
    const preset = findPreset(id);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Unknown preset \`${id}\`.`));
      process.stderr.write(ui.hint(`Available: ${presetIds().join(", ")}. Run \`mono-agent presets list\`.`));
      return 1;
    }
    process.stdout.write(renderPresetShow(preset));
    return 0;
  }
  process.stderr.write(ui.errorLine(`Unknown presets subcommand \`${sub}\`. Expected list or show.`));
  return 2;
}

const SOURCE_TAG: Record<ConfigViewSection["fields"][number]["source"], string> = {
  env: ui.style.green("[env]"),
  json: ui.style.cyan("[json]"),
  default: ui.style.dim("[default]"),
};

/**
 * Render the complete, source-annotated config view: every core section and
 * field with its resolved value and whether it came from an env var, the JSON
 * file, or the built-in default. This is the single discovery surface that
 * replaced the old partial config panes.
 */
export function renderConfigView(sections: readonly ConfigViewSection[]): string {
  let out = "";
  for (const section of sections) {
    const badgeStatus = section.status === "active" ? "ok" : "disabled";
    out += `${ui.badge(badgeStatus)}${ui.style.bold(section.label)}\n`;
    const width = section.fields.reduce((max, field) => Math.max(max, field.label.length), 0);
    for (const field of section.fields) {
      const tag = SOURCE_TAG[field.source];
      const lock = field.redacted === true ? ` ${ui.style.dim("(secret)")}` : "";
      const defaultRestatement = field.restatesDefault === true ? ` ${ui.style.dim("(same as default)")}` : "";
      out += `    ${ui.style.gray(field.label.padEnd(width))}  ${field.value}${lock}${defaultRestatement}  ${tag}\n`;
    }
  }
  return out;
}

/**
 * `mono-agent config`: print the resolved configuration field-by-field with the
 * source (env / json / default) of every value, then the channel summary. Read
 * only — edits go in mono-agent.config.json and take effect on the next restart.
 */
export async function runConfig(args: ParsedCliArgs): Promise<number> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, args.configPath ?? "mono-agent.config.json");
  const env = process.env;

  const jsonResult = await readMonoAgentConfigJson(configPath);
  let config;
  try {
    config = await loadAppCoreConfig({ env, cwd, configPath });
  } catch (error) {
    if (isAppCoreConfigError(error)) {
      process.stderr.write(ui.errorLine(error.message));
      if (jsonResult.missing) {
        process.stderr.write(ui.hint(`No mono-agent config found at ${configPath}. Run \`mono-agent init\` to scaffold one.`));
      } else {
        process.stderr.write(ui.hint("Fix the config above, then re-run `mono-agent config`."));
      }
      return 1;
    }
    throw error;
  }

  const sections = buildMonoAgentConfigView({
    redacted: redactMonoAgentConfig(config),
    json: jsonResult.json,
    env,
  });
  const drivers = await resolveChannelDrivers({ env, cwd, configPath });
  const channelViews = await collectChannelConfigViews(drivers, { env, cwd, configPath });

  process.stdout.write(ui.banner("mono-agent", "resolved config") + "\n");
  process.stdout.write(renderConfigView(sections));
  if (channelViews.length > 0) {
    process.stdout.write("\n" + ui.heading("Channels"));
    process.stdout.write(renderConfigView(channelViews));
  }
  for (const warning of [
    ...findUnknownAppConfigWarnings(jsonResult.json),
    ...findJsonSecretConfigWarnings([...sections, ...channelViews]),
    ...findRemovedConfigWarnings({ json: jsonResult.json, env }),
  ]) {
    process.stdout.write(`${ui.style.yellow(warning)}\n`);
  }

  const report = await validateMonoAgentFolder({ env, cwd, configPath, liveness: false, drivers });
  const channels = report.sections.filter((section) => section.id.startsWith("channel:"));
  if (channels.length > 0) {
    process.stdout.write("\n" + ui.heading("Channel status"));
    for (const section of channels) {
      process.stdout.write(formatSection(section));
    }
  }

  process.stdout.write(
    "\n" + ui.style.dim("Source precedence: [env] > [json] > [default]. Edit mono-agent.config.json and run `mono-agent restart` to apply.") + "\n",
  );
  return 0;
}

/** Render one validation section: a status badge, a bold label, and its details. */
export function formatSection(section: ValidationSection): string {
  let out = `${ui.badge(section.status)}${ui.style.bold(section.label)}\n`;
  for (const detail of section.details) {
    out += `    ${colorDetail(section.status, detail)}\n`;
  }
  return out;
}

function colorDetail(status: ValidationStatus, detail: string): string {
  if (status === "error") {
    return ui.style.red(detail);
  }
  if (detail.startsWith("[WARN]") || detail.startsWith("WARNING:")) {
    return ui.style.yellow(detail);
  }
  return ui.style.dim(detail);
}

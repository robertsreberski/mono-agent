#!/usr/bin/env node
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  buildMonoAgentConfigView,
  EFFORT_LEVELS,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  MAX_AGENT_NAME_LENGTH,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type { ConfigViewSection } from "@mono-agent/config";
import type { EffortLevel, RouteSafetyMode } from "@mono-agent/config";
import { listRecordedRuns } from "@mono-agent/observability";
import {
  describeSandboxEffectiveState,
  parseMonoRuntimeModelReference,
  sandboxEffectiveStateWarning,
} from "@mono-agent/runtime-adapter";

import { startMonoAgentApp } from "./app.js";
import type { ExporterStatus, MonoAgentApp, SandboxStatus } from "./app.js";
import {
  describeSensitiveDataExportWarning,
  isAppCoreConfigError,
  loadAppCoreConfig,
  phoenixAppBaseUrl,
} from "./app-config.js";
import { runAuditRuns } from "./audit-runs.js";
import { runBackfill } from "./backfill.js";
import {
  defaultBackgroundDeps,
  resolveInstanceTarget,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "./background.js";
import type { BackgroundDeps, InstanceTarget } from "./background.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { formatChannelFactValue } from "./channel-fact-format.js";
import { resolveChannelDrivers } from "./channels.js";
import type { ChannelStatus } from "./channels.js";
import { findUnknownAppConfigWarnings } from "./config-reference.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type { ValidationReport, ValidationSection, ValidationStatus } from "./doctor.js";
import {
  effectiveFirstRunEnvironment,
  evaluateFirstRunConfigurationReadiness,
  evaluateFirstRunReadiness,
  hasSensitivePersistedEnvironmentValue,
  piAuthPathBackgroundConflict,
  readCliConfigSnapshot,
  readCliDotenvFile,
  readCliDotenvSnapshot,
  resolveEffectivePiAuthPath,
  selectedSecretEnvironmentConflicts,
  selectedSecretValues,
  unexpectedPersistedMonoAgentOverrides,
  validateWizardPlanInStaging,
  withExactProcessEnvironment,
} from "./first-run-readiness.js";
import type { CliConfigSnapshot, CliDotenvSnapshot, CliEnvironment } from "./first-run-readiness.js";
import {
  initMonoAgentFolder,
  SecretEnvConcurrentModificationError,
  verifySecretEnvPersistenceGuard,
} from "./init.js";
import type { InitMonoAgentFolderResult } from "./init.js";
import { installComposerSkill } from "./install-skill.js";
import type { InstallSkillTarget } from "./install-skill.js";
import { checkManagedProjectSkills, updateManagedProjectSkills } from "./project-skills.js";
import { runMetrics } from "./metrics.js";
import type { ModuleValidateExpectation } from "./modules/index.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import { purgeSessions } from "./sessions.js";
import { composeWizardPlan, referencedSetupModelRefs } from "./wizard/answers.js";
import type { SecretChecklistItem, WizardAnswers, WizardPlan } from "./wizard/answers.js";
import { answersFromCli, isWithChannel } from "./wizard/from-flags.js";
import type { WithChannel } from "./wizard/from-flags.js";
import { findPreset, PRESET_CATALOG, presetAnswers, presetIds, RECIPE_TO_PRESET } from "./wizard/presets.js";
import type { WizardPreset } from "./wizard/presets.js";
import { runInitWizard, runSetupRepairWizard } from "./wizard/run.js";
import {
  detectProviderCredentialStates,
  executeProviderSetupPlan,
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
  providerSetupActionCommandLine,
} from "./provider-setup.js";
import type {
  CodexLoginMode,
  ProviderCredentialState,
  ProviderSetupPlan,
  ProviderSetupResult,
} from "./provider-setup.js";
import { readinessProbeTimeoutMs, runAllRouteReadinessProbe } from "./readiness-probe.js";
import type { ReadinessProbeResult, ReadinessRouteResult } from "./readiness-probe.js";
import {
  checkSandboxRuntime,
  sandboxRuntimeStatus,
  setupManagedSrt,
} from "./sandbox-manager.js";
import type {
  ManagedSrtSetupResult,
  SandboxCheckResult,
  SandboxRuntimeStatus,
} from "./sandbox-manager.js";
import * as p from "@clack/prompts";
import * as ui from "./ui.js";

const DEFAULT_LOG_LINES = 200;
// Node's maximum setInterval/setTimeout delay (2^31 - 1 ms, ~24.8 days). A
// referenced timer at this delay keeps the foreground event loop alive without
// busy-waiting; larger values silently overflow to a 1ms delay.
const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;
const BACKGROUND_COMMANDS = ["start", "restart", "stop", "status", "logs"] as const;
const KNOWN_COMMANDS = ["init", "setup", "validate", "doctor", "auth", "sandbox", "config", "recipes", "presets", "start", "restart", "stop", "status", "logs", "tui", "web", "install-skill", "backfill", "audit-runs", "metrics", "memory"] as const;

type ReadinessProbeFailure = Extract<ReadinessProbeResult, { readonly ok: false }>;

// `doctor`/`setup`/`recipes` never reach routing: parseCliArgs normalizes them to
// `validate`/`init`/`presets`. `help`/`version` are synthetic commands (not in
// KNOWN_COMMANDS) produced by the `--help`/`-h` and `--version`/`-v` flags before
// command validation.
type CliCommand = Exclude<(typeof KNOWN_COMMANDS)[number], "doctor" | "setup" | "recipes"> | "help" | "version";

interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly configPath?: string;
  readonly name?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly fallbacks?: readonly CliFallbackArg[];
  readonly routeSafety?: RouteSafetyMode;
  readonly effort?: string;
  readonly memory?: "lite" | "journal" | "bujo";
  /** init/validate: build/check against this preset id. */
  readonly preset?: string;
  /** init/validate: deprecated alias — maps to the preset that replaced the recipe. */
  readonly recipe?: string;
  /** init: additional channels to enable on top of the preset/default config. */
  readonly withChannels?: readonly string[];
  /** init: skip the interactive wizard and write the default/preset scaffold. */
  readonly yes?: boolean;
  /** init: opt in to running provider auth/preflight commands before writing files. */
  readonly auth?: boolean;
  /** auth: explicit destination for the Pi auth store. */
  readonly piAuthPath?: string;
  /** auth: explicitly read one API key from redirected standard input. */
  readonly apiKeyStdin?: boolean;
  /** init/auth: direct Codex browser callback or headless device-code flow. */
  readonly codexAuthMode?: CodexLoginMode;
  /** Non-flag arguments (e.g. `presets show <id>`). */
  readonly positionals: readonly string[];
  readonly envFile?: string;
  readonly target?: InstallSkillTarget;
  readonly force: boolean;
  /** start: run the blocking foreground worker instead of backgrounding. */
  readonly foreground: boolean;
  /** logs: keep streaming new output (tail -F). */
  readonly follow: boolean;
  /** logs: number of trailing lines to print. */
  readonly lines?: number;
  /** backfill: export exactly this run id. */
  readonly run?: string;
  /** backfill: export every recorded run. */
  readonly all: boolean;
  /** backfill: only runs whose startedAt is >= this ISO instant. */
  readonly since?: string;
  /** backfill: only runs whose startedAt is <= this ISO instant. */
  readonly until?: string;
  /** backfill: map + serialize but do not POST. */
  readonly dryRun: boolean;
  /** audit-runs/metrics/backfill/web: include memory-run artifacts. */
  readonly includeMemory: boolean;
  /** audit-runs: read this artifact directory directly. */
  readonly artifactDir?: string;
  /** metrics: group totals by this summary dimension. */
  readonly groupBy?: "model" | "channel" | "failureKind";
  /** validate/audit-runs: resolve config, env, artifacts, and checks relative to this consumer folder. */
  readonly consumerPath?: string;
  /** tui: connect to this running agent (label or sourceId) directly. */
  readonly agent?: string;
  /** tui: conversation id to chat under. */
  readonly conversation?: string;
  /** tui: build the current-folder responder in-process. */
  readonly local?: boolean;
  /** tui: start with the conversational configuration invitation. */
  readonly configure?: boolean;
  /** install-skill: operate on the current agent's managed project skills. */
  readonly project?: boolean;
  /** install-skill --project: report drift without writing. */
  readonly check?: boolean;
  /** install-skill --project: safely update unchanged managed copies. */
  readonly update?: boolean;
  /** audit-runs: override the stale-running cutoff interval. */
  readonly staleAfterMs?: number;
  /** audit-runs: print the full machine-readable report. */
  readonly json?: boolean;
  /** memory: max rows for search/top/entity preview. */
  readonly limit?: number;
  /** web: bind host (default 127.0.0.1). */
  readonly host?: string;
  /** web: bind port (default 4599). */
  readonly port?: number;
  /** web: `--no-open` sets this false to suppress the browser launch. */
  readonly open?: boolean;
  /** web: `--allow-non-loopback` permits a non-loopback bind. */
  readonly allowNonLoopback?: boolean;
  /** web: reveal a configured auth token only to an interactive terminal. */
  readonly showAuthUrl?: boolean;
  /** web: `--max-runs` caps the per-instance in-memory working set (default 200). */
  readonly maxRunsPerInstance?: number;
}

interface CliFallbackArg {
  readonly model: string;
  readonly effort?: EffortLevel;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", positionals: [], force: false, foreground: false, follow: false, all: false, dryRun: false, includeMemory: false };
  }
  if (command === "version" || command === "--version" || command === "-v") {
    return { command: "version", positionals: [], force: false, foreground: false, follow: false, all: false, dryRun: false, includeMemory: false };
  }
  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command \`${command}\`. Expected ${KNOWN_COMMANDS.join(", ")}.`);
  }
  // `doctor`/`setup`/`recipes` are aliases; normalize here so every downstream
  // path (routing, env-file resolution, --consumer) applies unchanged. `doctor`
  // → `validate`, `setup` → `init`, `recipes` → `presets`.
  const cmd = (
    command === "doctor"
      ? "validate"
      : command === "setup"
        ? "init"
        : command === "recipes"
          ? "presets"
          : command
  ) as CliCommand;
  const isLogs = cmd === "logs";

  let configPath: string | undefined;
  let name: string | undefined;
  let model: string | undefined;
  let fallbackModels: readonly string[] | undefined;
  const fallbacks: CliFallbackArg[] = [];
  let canAssignFallbackEffort = false;
  let routeSafety: RouteSafetyMode | undefined;
  let effort: string | undefined;
  let memory: "lite" | "journal" | "bujo" | undefined;
  let preset: string | undefined;
  let recipe: string | undefined;
  let withChannels: readonly string[] | undefined;
  let yes = false;
  let auth = false;
  let piAuthPath: string | undefined;
  let apiKeyStdin = false;
  let codexAuthMode: CodexLoginMode | undefined;
  const positionals: string[] = [];
  let envFile: string | undefined;
  let target: InstallSkillTarget | undefined;
  let force = false;
  let foreground = false;
  let follow = false;
  let lines: number | undefined;
  let run: string | undefined;
  let all = false;
  let since: string | undefined;
  let until: string | undefined;
  let dryRun = false;
  let includeMemory = false;
  let artifactDir: string | undefined;
  let groupBy: "model" | "channel" | "failureKind" | undefined;
  let consumerPath: string | undefined;
  let agent: string | undefined;
  let conversation: string | undefined;
  let local = false;
  let configure = false;
  let project = false;
  let check = false;
  let update = false;
  let staleAfterMs: number | undefined;
  let json = false;
  let limit: number | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let open: boolean | undefined;
  let allowNonLoopback: boolean | undefined;
  let showAuthUrl: boolean | undefined;
  let maxRunsPerInstance: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag !== "--fallback-effort") canAssignFallbackEffort = false;
    switch (flag) {
      case "--config":
        configPath = requireValue(rest, ++i, flag);
        break;
      case "--run":
        run = requireValue(rest, ++i, flag);
        break;
      case "--all":
        all = true;
        break;
      case "--since":
        since = requireValue(rest, ++i, flag);
        break;
      case "--until":
        until = requireValue(rest, ++i, flag);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--include-memory":
        includeMemory = true;
        break;
      case "--artifact-dir":
        artifactDir = requireValue(rest, ++i, flag);
        break;
      case "--artifacts":
        artifactDir = requireValue(rest, ++i, flag);
        break;
      case "--by": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "model" && raw !== "channel" && raw !== "failureKind") {
          throw new Error("--by must be model, channel, or failureKind.");
        }
        groupBy = raw;
        break;
      }
      case "--consumer":
        consumerPath = requireValue(rest, ++i, flag);
        break;
      case "--agent":
        agent = requireValue(rest, ++i, flag);
        break;
      case "--conversation":
        conversation = requireValue(rest, ++i, flag);
        break;
      case "--local":
        local = true;
        break;
      case "--configure":
        configure = true;
        break;
      case "--project":
        project = true;
        break;
      case "--check":
        check = true;
        break;
      case "--update":
        update = true;
        break;
      case "--stale-after-ms": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--stale-after-ms must be a positive integer.");
        }
        staleAfterMs = parsed;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--limit": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          throw new Error("--limit must be an integer between 1 and 100.");
        }
        limit = parsed;
        break;
      }
      case "--host":
        host = requireValue(rest, ++i, flag);
        break;
      case "--port": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error("--port must be an integer between 0 and 65535.");
        }
        port = parsed;
        break;
      }
      case "--no-open":
        open = false;
        break;
      case "--allow-non-loopback":
        allowNonLoopback = true;
        break;
      case "--show-auth-url":
        showAuthUrl = true;
        break;
      case "--max-runs": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--max-runs must be a positive integer.");
        }
        maxRunsPerInstance = parsed;
        break;
      }
      case "--model":
        model = requireValue(rest, ++i, flag);
        break;
      case "--name":
        name = requireValue(rest, ++i, flag).trim();
        if (
          Array.from(name).length === 0
          || Array.from(name).length > MAX_AGENT_NAME_LENGTH
          || /[\u0000-\u001f\u007f]/u.test(name)
        ) {
          throw new Error(`--name must be 1-${MAX_AGENT_NAME_LENGTH} characters on one line.`);
        }
        break;
      case "--fallback-models":
        fallbackModels = requireValue(rest, ++i, flag)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        break;
      case "--fallback": {
        const fallbackModel = requireValue(rest, ++i, flag).trim();
        if (fallbacks.some((entry) => entry.model === fallbackModel)) {
          throw new Error(`Duplicate --fallback model \`${fallbackModel}\`.`);
        }
        fallbacks.push({ model: fallbackModel });
        canAssignFallbackEffort = true;
        break;
      }
      case "--fallback-effort": {
        if (!canAssignFallbackEffort || fallbacks.length === 0) {
          throw new Error("--fallback-effort must immediately follow the --fallback it configures.");
        }
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "provider-default" && !(EFFORT_LEVELS as readonly string[]).includes(raw)) {
          throw new Error(`--fallback-effort must be provider-default or ${EFFORT_LEVELS.join(", ")}.`);
        }
        if (raw !== "provider-default") {
          const current = fallbacks[fallbacks.length - 1]!;
          fallbacks[fallbacks.length - 1] = {
            ...current,
            effort: raw as EffortLevel,
          };
        }
        canAssignFallbackEffort = false;
        break;
      }
      case "--route-safety": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "uniform" && raw !== "per-route-native") {
          throw new Error("--route-safety must be uniform or per-route-native.");
        }
        routeSafety = raw;
        break;
      }
      case "--effort": {
        const raw = requireValue(rest, ++i, flag);
        if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
          throw new Error(`--effort must be ${EFFORT_LEVELS.join(", ")}.`);
        }
        effort = raw;
        break;
      }
      case "--memory": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "lite" && raw !== "journal" && raw !== "bujo") {
          throw new Error("--memory must be lite, journal, or bujo.");
        }
        memory = raw;
        break;
      }
      case "--preset":
        preset = requireValue(rest, ++i, flag);
        break;
      case "--recipe":
        recipe = requireValue(rest, ++i, flag);
        break;
      case "--yes":
        yes = true;
        break;
      case "--auth":
        auth = true;
        break;
      case "--pi-auth-path":
        piAuthPath = requireValue(rest, ++i, flag);
        break;
      case "--api-key-stdin":
        apiKeyStdin = true;
        break;
      case "--codex-auth": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "browser" && raw !== "device") {
          throw new Error("--codex-auth must be browser or device.");
        }
        codexAuthMode = raw;
        break;
      }
      case "--with":
        withChannels = requireValue(rest, ++i, flag)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        break;
      case "--env-file":
        envFile = requireValue(rest, ++i, flag);
        break;
      case "--target": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "claude" && raw !== "codex" && raw !== "both") {
          throw new Error("--target must be claude, codex, or both.");
        }
        target = raw;
        break;
      }
      case "--force":
        force = true;
        break;
      case "--foreground":
        foreground = true;
        break;
      case "--follow":
        follow = true;
        break;
      // `-f` is foreground for start, follow for logs.
      case "-f":
        if (isLogs) {
          follow = true;
        } else {
          foreground = true;
        }
        break;
      case "--lines": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
          throw new Error("--lines must be a positive integer between 1 and 100000.");
        }
        lines = parsed;
        break;
      }
      default:
        if (flag === undefined) {
          break;
        }
        if (flag.startsWith("--")) {
          throw new Error(`Unknown flag \`${flag}\` for \`mono-agent ${command}\`.`);
        }
        // Non-flag tokens are positional arguments (e.g. `recipes show <id>`).
        positionals.push(flag);
        break;
    }
  }

  if (consumerPath !== undefined && cmd !== "validate" && cmd !== "audit-runs") {
    throw new Error("--consumer is only supported for `mono-agent validate` and `mono-agent audit-runs`.");
  }
  if ((local || configure) && cmd !== "tui") {
    throw new Error("--local and --configure are only supported for `mono-agent tui`.");
  }
  if (configure && !local) {
    throw new Error("--configure requires `mono-agent tui --local`.");
  }
  if ((project || check || update) && cmd !== "install-skill") {
    throw new Error("--project, --check, and --update are only supported for `mono-agent install-skill`.");
  }
  if ((check || update) && !project) {
    throw new Error("--check and --update require `mono-agent install-skill --project`.");
  }
  if (check && update) {
    throw new Error("Choose either --check or --update for project skills.");
  }

  if (
    (
      host !== undefined
      || port !== undefined
      || open !== undefined
      || allowNonLoopback !== undefined
      || showAuthUrl !== undefined
      || maxRunsPerInstance !== undefined
    ) &&
    cmd !== "web"
  ) {
    throw new Error("--host, --port, --no-open, --allow-non-loopback, --show-auth-url, and --max-runs are only supported for `mono-agent web`.");
  }
  if (includeMemory && cmd !== "audit-runs" && cmd !== "metrics" && cmd !== "backfill" && cmd !== "web") {
    throw new Error("--include-memory is only supported for `mono-agent audit-runs`, `mono-agent metrics`, `mono-agent backfill`, and `mono-agent web`.");
  }
  if (limit !== undefined && cmd !== "memory") {
    throw new Error("--limit is only supported for `mono-agent memory`.");
  }
  if (auth && cmd !== "init") {
    throw new Error("--auth is only supported for `mono-agent init`.");
  }
  if (piAuthPath !== undefined && cmd !== "auth") {
    throw new Error("--pi-auth-path is only supported for `mono-agent auth`.");
  }
  if (apiKeyStdin && cmd !== "auth") {
    throw new Error("--api-key-stdin is only supported for `mono-agent auth login <provider>`.");
  }
  if (codexAuthMode !== undefined && cmd !== "init" && cmd !== "auth") {
    throw new Error("--codex-auth is only supported for `mono-agent init` and `mono-agent auth login codex`.");
  }
  if (fallbackModels !== undefined && fallbacks.length > 0) {
    throw new Error("Use either legacy --fallback-models or repeated --fallback flags, not both.");
  }
  if (fallbackModels !== undefined && new Set(fallbackModels).size !== fallbackModels.length) {
    throw new Error("--fallback-models contains a duplicate model reference.");
  }
  const selectedFallbackModels = fallbackModels ?? fallbacks.map((fallback) => fallback.model);
  if (model !== undefined && selectedFallbackModels.includes(model)) {
    throw new Error(`Primary --model \`${model}\` cannot also be a fallback.`);
  }

  return {
    command: cmd,
    ...(configPath === undefined ? {} : { configPath }),
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(fallbacks.length === 0 ? {} : { fallbacks }),
    ...(routeSafety === undefined ? {} : { routeSafety }),
    ...(effort === undefined ? {} : { effort }),
    ...(memory === undefined ? {} : { memory }),
    ...(preset === undefined ? {} : { preset }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(yes ? { yes } : {}),
    ...(auth ? { auth } : {}),
    ...(piAuthPath === undefined ? {} : { piAuthPath }),
    ...(apiKeyStdin ? { apiKeyStdin } : {}),
    ...(codexAuthMode === undefined ? {} : { codexAuthMode }),
    positionals,
    ...(envFile === undefined ? {} : { envFile }),
    ...(target === undefined ? {} : { target }),
    force,
    foreground,
    follow,
    ...(lines === undefined ? {} : { lines }),
    ...(run === undefined ? {} : { run }),
    all,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    dryRun,
    includeMemory,
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(consumerPath === undefined ? {} : { consumerPath }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(json ? { json } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(agent === undefined ? {} : { agent }),
    ...(conversation === undefined ? {} : { conversation }),
    ...(local ? { local } : {}),
    ...(configure ? { configure } : {}),
    ...(project ? { project } : {}),
    ...(check ? { check } : {}),
    ...(update ? { update } : {}),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(open === undefined ? {} : { open }),
    ...(allowNonLoopback === undefined ? {} : { allowNonLoopback }),
    ...(showAuthUrl === undefined ? {} : { showAuthUrl }),
    ...(maxRunsPerInstance === undefined ? {} : { maxRunsPerInstance }),
  };
}

/**
 * Loads env vars from a dotenv file when it exists; already-set variables are
 * never overwritten, so exported shell variables take precedence. Returns
 * false when the file is missing or unreadable.
 */
export function loadCliEnvFile(path: string): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

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

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
}

interface HelpEntry {
  readonly signature: string;
  readonly lines: readonly string[];
}

const HELP_COMMANDS: readonly HelpEntry[] = [
  {
    signature: "mono-agent init [--preset <id>] [--with <csv>] [--yes] [--auth] [--dry-run]\n" +
      "                [--name <display-name>] [--model <ref>] [--effort <level>]\n" +
      "                [--fallback <ref> [--fallback-effort <provider-default|level>]]...\n" +
      "                [--fallback-models <csv>] [--route-safety uniform|per-route-native]\n" +
      "                [--codex-auth browser|device] [--memory lite|journal|bujo]",
    lines: [
      "Scaffold a mono-agent in the current folder. On a TTY with no flags, launches",
      "the step-by-step wizard; with --yes or any flag, writes the default/preset",
      "scaffold non-interactively. --preset seeds a blueprint, --with adds channels,",
      `Effort levels: ${EFFORT_LEVELS.join(", ")}; an omitted fallback effort uses that provider's default.`,
      "--auth runs supported provider auth/preflight before writing; --codex-auth device supports headless hosts.",
      "--dry-run previews only. Existing scaffold/config files are not overwritten;",
      "guided secret setup may securely update .env and .gitignore after explicit review.",
    ],
  },
  {
    signature: "mono-agent setup",
    lines: ["Alias of `init`."],
  },
  {
    signature: "mono-agent presets list | show <id>",
    lines: [
      "List the built-in setup presets, or show one's generated config,",
      ".env.example, and follow-up checklist.",
    ],
  },
  {
    signature: "mono-agent validate [--preset <id>] [--consumer <path>] [--config <path>] [--env-file <path>]",
    lines: [
      "Load every config section and report what would run, wait, or fail.",
      "--consumer validates another agent folder read-only, including its .env.",
      "With --preset, also report whether the preset's capabilities are live.",
      "`mono-agent doctor` is an alias for this command.",
    ],
  },
  {
    signature: "mono-agent auth login <provider|codex> [--pi-auth-path <path>] [--api-key-stdin]\n" +
      "                       [--codex-auth browser|device] [--config <path>]",
    lines: [
      "Run a supported bundled Pi provider login, or direct Codex browser/device login.",
      "Pi credentials are promoted with owner-only no-clobber checks.",
      "API-key providers prompt securely on a TTY; --api-key-stdin explicitly reads a redirected secret.",
      "Path precedence: --pi-auth-path, MONO_AGENT_PI_AUTH_PATH, providers.piAuthPath, then Pi's default.",
      "Supported Pi targets: anthropic, github-copilot, openai-codex, and opencode-go.",
    ],
  },
  {
    signature: "mono-agent sandbox status | setup | check",
    lines: [
      "Inspect, install, or functionally prove the pinned SRT sandbox runtime.",
      "Managed setup is macOS-only and installs into the user's cache; it never changes PATH,",
      "global npm packages, system packages, or another user's files.",
    ],
  },
  {
    signature: "mono-agent config [--config <path>] [--env-file <path>]",
    lines: [
      "Print the resolved config field-by-field, tagging each value with where",
      "it came from (env / json / default), plus the channel summary. Read-only.",
    ],
  },
  {
    signature: "mono-agent start [--config <path>] [--env-file <path>] [--foreground|-f]",
    lines: [
      "Start the agent as a background macOS service (launchd), print its",
      "instance info, and return. Re-running restarts the running instance.",
      "Refuses to start without a valid mono-agent.config.json in the folder.",
      "Use --foreground (-f) to run in the blocking foreground instead.",
    ],
  },
  {
    signature: "mono-agent restart [--config <path>] [--force]",
    lines: [
      "Restart the background instance for this config (starts it if stopped).",
      "--force also clears the persisted pi sessions so it starts with fresh",
      "conversations instead of resuming saved ones (durable memory is untouched).",
    ],
  },
  {
    signature: "mono-agent stop [--config <path>]",
    lines: ["Stop the background instance and remove its LaunchAgent."],
  },
  {
    signature: "mono-agent status [--config <path>]",
    lines: ["Show this config's instance plus any other running instances."],
  },
  {
    signature: "mono-agent logs [--config <path>] [--follow|-f] [--lines <n>]",
    lines: ["Print (and optionally follow) the background instance's log files."],
  },
  {
    signature: "mono-agent tui [--agent <label|sourceId>] [--conversation <id>]\n" +
      "               [--local [--configure]]",
    lines: [
      "Open the operator console from any directory: live chat with full",
      "thinking/tool/telemetry insight, recorded-run replay, and config view.",
      "Discovers running agents via the trace-source registry; one running",
      "agent connects directly, several open a picker.",
      "--local builds the current folder's responder in-process without a",
      "daemon; --configure starts the recorded local configuration invitation.",
    ],
  },
  {
    signature: "mono-agent web [--host <addr>] [--port <n>] [--no-open] [--allow-non-loopback] [--show-auth-url] [--include-memory] [--max-runs <n>]",
    lines: [
      "Serve the read-only Session Recorder web PWA from any directory: a live",
      "flight-recorder over every agent's runs (prompt, reasoning, tools, cost).",
      "Discovers running agents via the trace-source registry — the same",
      "mechanism as `tui` — and streams new/updated runs in real time.",
      "--include-memory also shows memory-maintenance runs. --max-runs (default",
      "200) bounds the in-memory working set; the UI still pages the full",
      "on-disk history via \"Load older\".",
      "Non-loopback mode uses MONO_AGENT_WEB_AUTH_TOKEN when set; otherwise",
      "it generates a token. --show-auth-url reveals a configured token only",
      "to an interactive terminal.",
    ],
  },
  {
    signature: "mono-agent install-skill [--target claude|codex|both] [--force]\n" +
      "                         --project (--check|--update)",
    lines: [
      "Copy the bundled mono-agent-composer skill into ~/.claude/skills and",
      "~/.agents/skills (default: both). Refuses to overwrite without --force.",
      "Project mode checks or safely updates the two managed skills generated",
      "by init; modified copies are never overwritten and updates retain backups.",
    ],
  },
  {
    signature:
      "mono-agent backfill (--run <id> | --all) [--since <iso>] [--until <iso>]\n" +
      "                    [--include-memory] [--dry-run] [--config <path>] [--env-file <path>]",
    lines: [
      "Export already-recorded agent-run artifacts to the configured Phoenix exporter",
      "with their historical timestamps. Trace ids are deterministic per run, so",
      "re-running overwrites rather than duplicating. --dry-run maps and",
      "serializes without sending. --include-memory adds memory-run artifacts",
      "for --all; explicit --run can target a memory run directly.",
    ],
  },
  {
    signature:
      "mono-agent audit-runs [--artifact-dir <path> | --consumer <path>]\n" +
      "                      [--include-memory] [--config <path>] [--env-file <path>] [--stale-after-ms <n>] [--json]",
    lines: [
      "Read local agent-run summary artifacts without rewriting them. Reports parse",
      "failures, status and failure-kind histograms, stale running summaries,",
      "and per-failure-kind rates. --include-memory includes memory-run artifacts.",
    ],
  },
  {
    signature:
      "mono-agent metrics [--artifacts <path>] [--since <iso>] [--until <iso>]\n" +
      "                   [--include-memory] [--by model|channel|failureKind] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Aggregate local agent-run summaries into status rates, failure-kind rates,",
      "duration percentiles, and total/per-run cost. Read-only and offline.",
      "--include-memory includes memory-run artifacts.",
    ],
  },
  {
    signature:
      "mono-agent memory [stats|today|show <date>|search <query>|top|audit|rebuild|rollback]\n" +
      "                  [--limit <n>] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Preview the configured memory store from an agent folder. Reads the",
      "memory block from mono-agent.config.json, not the standalone memory-bujo",
      "env workflow. Human-first output by default; audit --json is metadata-only.",
    ],
  },
];

const HELP_NOTES = `Background mode runs the agent under launchd, keeping it alive across logins
(auto-restarting only on crash) until you run stop. Secrets are read from the
.env file in the working directory, the same as foreground mode. The background
commands require macOS; elsewhere use start --foreground.

Init model references look like pi:<provider>:<model>, claude:claude-sonnet-4-6,
codex:gpt-5.6-terra, codex:gpt-5.6-sol, or opencode:<provider>:<model>. The init wizard
selects the live provider-declared default when available and falls back offline to
codex:gpt-5.6-terra. Direct and Pi OpenAI-Codex Sol choices remain selectable.
Direct GPT-5.6 routes require Codex CLI 0.144.0 or newer. Guided Pi authentication
covers Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go. Claude remains selectable;
direct opencode:<provider>:<model> refs are for
hand-authored runtime backend config and are rejected by guided selection/readiness.

Mixed fallback chains are allowed. runtime.routeSafety=uniform (the default)
requires one compatibility-preserving contract across every route;
per-route-native makes each route's exact safety boundary explicit (Pi SRT,
Claude provider-owned permissions, Codex native sandbox, or OpenCode native).

Native mono-agent srt policy is enforced by Pi-owned tools. In uniform mode,
Claude, direct Codex, and direct OpenCode cannot silently weaken that policy.
In per-route-native mode, validate reports each provider-owned safety contract
and rejects capabilities that the selected route cannot represent.
Direct OpenCode's bridge cannot enforce an explicit runtime.effort; omit effort and
configure runtime.permissionMode deliberately for hand-authored direct routes.
It is per-run/non-resumable and rejects MCP (including auto-provisioned memory
or send tools), positive maxTurns, index skill disclosure, structured output,
live input, fast mode, and native subagents instead of silently dropping them.

A .env file in the current folder is loaded automatically when present;
already-exported shell variables take precedence.
`;

/** Build the colorized help screen (plain text when color is disabled). */
export function renderHelp(): string {
  let out = ui.banner("mono-agent", "config-first agent host") + "\n";
  out += ui.heading("Usage");
  for (const entry of HELP_COMMANDS) {
    const [first, ...rest] = entry.signature.split("\n");
    out += `  ${ui.style.bold(ui.style.cyan(first ?? ""))}\n`;
    for (const cont of rest) {
      out += `  ${ui.style.cyan(cont)}\n`;
    }
    for (const line of entry.lines) {
      out += `      ${ui.style.dim(line)}\n`;
    }
    out += "\n";
  }
  out += ui.style.dim(HELP_NOTES);
  return out;
}

/**
 * The published CLI version, read from this package's own package.json at
 * runtime. `../package.json` resolves the same from both `src/cli.ts` (tests) and
 * the built `dist/cli.js` (one level below the package root in both layouts), and
 * npm always ships package.json in the tarball. Best-effort: a read failure yields
 * "unknown" rather than crashing `--version`.
 */
export function monoAgentVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
    process.stdout.write(`\n${renderHelp()}`);
    return 2;
  }

  const invocationCwd = process.cwd();
  // Capture the exported shell before dotenv loading. Guided init retains only
  // worker-operational values and reports shell/background credential drift;
  // normal CLI commands still get the established shell-over-dotenv precedence.
  const shellEnv = { ...process.env };
  const envFilePath = args.command === "validate"
    ? resolveValidateContext(args, invocationCwd).envFilePath
    : resolve(invocationCwd, args.envFile ?? ".env");
  let dotenvEnv: Record<string, string> = {};
  if (args.command === "init") {
    try {
      dotenvEnv = await readCliDotenvFile(envFilePath);
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Cannot read ${envFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return 1;
    }
  }
  loadCliEnvFile(envFilePath);

  switch (args.command) {
    case "help":
      process.stdout.write(renderHelp());
      return 0;
    case "version":
      process.stdout.write(`mono-agent ${monoAgentVersion()}\n`);
      return 0;
    case "init":
      return await runInit(args, { shellEnv, dotenvEnv, dotenvPath: envFilePath });
    case "validate":
      return await runValidate(args);
    case "auth":
      return await runAuth(args);
    case "sandbox":
      return await runSandboxCommand(args);
    case "config":
      return await runConfig(args);
    case "presets":
      return runPresets(args);
    case "start":
      return await runStart(args);
    case "restart":
    case "stop":
    case "status":
    case "logs":
      return await runBackgroundCommand(args, args.command);
    case "tui": {
      // Lazy import: the operator console (and pi-tui) load only on demand.
      const { runTui } = await import("./tui-command.js");
      return await runTui({
        configPath: resolve(process.cwd(), args.configPath ?? "mono-agent.config.json"),
        cwd: process.cwd(),
        env: process.env,
        ...(args.agent === undefined ? {} : { agent: args.agent }),
        ...(args.conversation === undefined ? {} : { conversationId: args.conversation }),
        ...(args.local === true ? { local: true } : {}),
        ...(args.configure === true ? { configure: true } : {}),
      });
    }
    case "web": {
      // Lazy import: the web server (and express/session-web) load only on demand.
      const { runWeb } = await import("./web-command.js");
      return await runWeb({
        configPath: resolve(process.cwd(), args.configPath ?? "mono-agent.config.json"),
        cwd: process.cwd(),
        env: process.env,
        ...(args.host === undefined ? {} : { host: args.host }),
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.open === undefined ? {} : { open: args.open }),
        ...(args.allowNonLoopback === undefined ? {} : { allowNonLoopback: args.allowNonLoopback }),
        ...(args.showAuthUrl === undefined ? {} : { showAuthUrl: args.showAuthUrl }),
        includeMemory: args.includeMemory,
        ...(args.maxRunsPerInstance === undefined ? {} : { maxRunsPerInstance: args.maxRunsPerInstance }),
      });
    }
    case "install-skill":
      return await runInstallSkill(args);
    case "backfill":
      return await runBackfill({
        ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
        ...(args.run === undefined ? {} : { run: args.run }),
        all: args.all,
        ...(args.since === undefined ? {} : { since: args.since }),
        ...(args.until === undefined ? {} : { until: args.until }),
        dryRun: args.dryRun,
        includeMemory: args.includeMemory,
      });
    case "audit-runs":
      return await runAuditRuns({
        ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
        ...(args.artifactDir === undefined ? {} : { artifactDir: args.artifactDir }),
        ...(args.consumerPath === undefined ? {} : { consumerPath: args.consumerPath }),
        ...(args.staleAfterMs === undefined ? {} : { staleAfterMs: args.staleAfterMs }),
        json: args.json === true,
        includeMemory: args.includeMemory,
      });
    case "metrics":
      return await runMetrics({
        ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
        ...(args.artifactDir === undefined ? {} : { artifactDir: args.artifactDir }),
        ...(args.since === undefined ? {} : { since: args.since }),
        ...(args.until === undefined ? {} : { until: args.until }),
        ...(args.groupBy === undefined ? {} : { groupBy: args.groupBy }),
        json: args.json === true,
        includeMemory: args.includeMemory,
      });
    case "memory": {
      // Lazy import: the memory preview path pulls SQLite/backend clients only on demand.
      const { runMemoryCommand } = await import("./memory-command.js");
      return await runMemoryCommand({
        cwd: process.cwd(),
        env: process.env,
        ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
        positionals: args.positionals,
        json: args.json === true,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
    }
  }
}

export interface SandboxCommandDependencies {
  readonly status: typeof sandboxRuntimeStatus;
  readonly setup: typeof setupManagedSrt;
  readonly check: typeof checkSandboxRuntime;
}

const DEFAULT_SANDBOX_COMMAND_DEPENDENCIES: SandboxCommandDependencies = {
  status: sandboxRuntimeStatus,
  setup: setupManagedSrt,
  check: checkSandboxRuntime,
};

/** App-owned sandbox lifecycle surface; safe to inject in focused CLI tests. */
export async function runSandboxCommand(
  args: Pick<ParsedCliArgs, "positionals">,
  dependencies: SandboxCommandDependencies = DEFAULT_SANDBOX_COMMAND_DEPENDENCIES,
): Promise<number> {
  const [subcommand, ...extra] = args.positionals;
  if ((subcommand !== "status" && subcommand !== "setup" && subcommand !== "check") || extra.length > 0) {
    process.stderr.write(ui.errorLine("[sandbox_usage] Usage: mono-agent sandbox status | setup | check."));
    return 2;
  }

  if (subcommand === "status") {
    try {
      printSandboxRuntimeStatus(await dependencies.status());
      return 0;
    } catch (error) {
      process.stderr.write(ui.errorLine(`[sandbox_status_failed] ${reasonOf(error)}`));
      return 1;
    }
  }

  return await withScopedSandboxCancellation(async (signal) => {
    try {
      if (subcommand === "setup") {
        process.stdout.write(ui.heading("Sandbox setup"));
        process.stdout.write(ui.style.dim("Installing the pinned SRT copy in the user cache; no PATH, global npm, or system-package changes will be made.\n"));
        const result = await dependencies.setup({ signal, verify: true });
        printSandboxSetupResult(result);
        return 0;
      }
      process.stdout.write(ui.heading("Sandbox check"));
      const result = await dependencies.check({ signal });
      printSandboxCheckResult(result);
      return 0;
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("[sandbox_interrupted] Sandbox operation was interrupted; no partial success was claimed."));
        process.stderr.write(ui.hint(`Retry safely with \`mono-agent sandbox ${subcommand}\`.\n`));
        return 130;
      }
      const code = subcommand === "setup" ? "sandbox_setup_failed" : "sandbox_check_failed";
      process.stderr.write(ui.errorLine(`[${code}] ${reasonOf(error)}`));
      process.stderr.write(ui.hint(`Retry with \`mono-agent sandbox ${subcommand}\` after resolving the error.\n`));
      return 1;
    }
  });
}

function printSandboxRuntimeStatus(status: SandboxRuntimeStatus): void {
  process.stdout.write(ui.heading("Sandbox status"));
  process.stdout.write(`  State: ${status.state}\n`);
  process.stdout.write(`  Source: ${status.source}\n`);
  process.stdout.write(`  Cache: ${status.installRoot}\n`);
  process.stdout.write(`  Detail: ${status.message}\n`);
}

function printSandboxCheckResult(result: SandboxCheckResult): void {
  printSandboxRuntimeStatus(result.status);
  process.stdout.write(ui.heading("Functional enforcement"));
  for (const check of result.checks) {
    process.stdout.write(`${check.ok ? ui.badge("ok") : ui.badge("error")}${check.id}: ${check.detail}\n`);
  }
}

function printSandboxSetupResult(result: ManagedSrtSetupResult): void {
  printSandboxRuntimeStatus(result.status);
  const action = result.repaired ? "repaired" : result.installed ? "installed" : "already installed";
  process.stdout.write(`${ui.badge("ok")}Managed SRT ${action}; integrity verification passed.\n`);
  if (result.check !== undefined) printSandboxCheckResult(result.check);
}

async function withScopedSandboxCancellation(
  task: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;
  const interrupt = (): void => {
    interrupts += 1;
    controller.abort();
  };
  const onKeypress = (_value: string, key: { readonly name?: string } | undefined): void => {
    if (key?.name === "escape") interrupt();
  };
  process.on("SIGINT", interrupt);
  const restoreKeypress = attachScopedKeypress(onKeypress);
  try {
    const result = await task(controller.signal);
    return interrupts > 1 ? 130 : result;
  } finally {
    process.off("SIGINT", interrupt);
    restoreKeypress();
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/iu.test(error.message));
}

function attachScopedKeypress(
  listener: (_value: string, key: { readonly name?: string; readonly ctrl?: boolean } | undefined) => void,
): () => void {
  if (!process.stdin.isTTY) return () => undefined;
  emitKeypressEvents(process.stdin);
  const input = process.stdin as typeof process.stdin & {
    readonly isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  input.setRawMode?.(true);
  input.resume();
  input.on("keypress", listener);
  return () => {
    input.off("keypress", listener);
    input.setRawMode?.(wasRaw);
    if (wasFlowing !== true) input.pause();
  };
}

interface RunInitEnvironmentContext {
  readonly shellEnv: CliEnvironment;
  readonly dotenvEnv: CliEnvironment;
  readonly dotenvPath: string;
}

async function runInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext): Promise<number> {
  const cwd = process.cwd();
  // On an interactive TTY with no overriding flags, walk the step-by-step wizard;
  // any flag (or a piped/non-TTY invocation) takes the silent default/preset path.
  const wantsWizard = shouldRunInitWizard(args, process.stdin.isTTY === true, process.stdout.isTTY === true);
  if (wantsWizard) {
    // Existing-config pre-check — don't walk the wizard into a guaranteed no-op.
    if (await pathExists(resolve(cwd, "mono-agent.config.json"))) {
      process.stdout.write(ui.hint("Found an existing mono-agent.config.json — `mono-agent init` never overwrites. Run `mono-agent validate`, or start in an empty folder.\n"));
      return 0;
    }
    let resolvedPiAuthPath = resolveEffectivePiAuthPath({
      cwd,
      ...(nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
        : {}),
    });
    const initial = await runInitWizard({
      cwd,
      piAuthPath: resolvedPiAuthPath,
      persistedEnv: environment.dotenvEnv,
    });
    if (initial.status === "cancelled") return 1;
    let answers = initial.answers;
    let moduleSecrets = { ...initial.moduleSecrets };
    let providerEnvironmentSecrets: Record<string, string> = { ...initial.providerEnvironmentSecrets };
    let providerSetupSecrets = { ...initial.providerSetupSecrets };
    let piApiKeyPersistenceByProvider = { ...initial.piApiKeyPersistenceByProvider };
    let credentialStates = { ...initial.credentialStates };
    let pendingProviderSetup = initial.runProviderSetup;
    let selectedCodexAuthMode: CodexLoginMode = "browser";
    let readinessProgress: ReadinessProgress | undefined;
    let sandboxMutationCompleted = false;
    let deferredFailure: ReadinessProbeFailure | undefined;

    firstRun: for (;;) {
      let dotenvSnapshot: CliDotenvSnapshot = { env: {}, fingerprint: "unreadable" };
      let failure: ReadinessProbeResult | undefined = deferredFailure;
      let configurationRecoveryStep: number | undefined;
      let invalidPlanStage: "configuration" | "final_readiness" | undefined;
      deferredFailure = undefined;
      try {
        dotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
      } catch {
        failure ??= dotenvReadinessFailure("The persisted .env could not be read safely. Fix it before retrying setup.");
      }
      const plan = composeWizardPlan(answers, {
        dirBasename: basename(cwd),
        skillsRootExists: await pathExists(resolve(cwd, "skills")),
      });
      resolvedPiAuthPath = resolveEffectivePiAuthPath({
        cwd,
        ...(nonEmptyEnv(dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH)
          ? { envPath: dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH }
          : {}),
        ...(nonEmptyEnv(plan.configJson.providers?.piAuthPath)
          ? { configPath: plan.configJson.providers.piAuthPath }
          : {}),
      });
      const effectiveEnv = effectiveFirstRunEnvironment({
        shellEnv: environment.shellEnv,
        dotenvEnv: dotenvSnapshot.env,
        enteredSecrets: { ...moduleSecrets, ...providerEnvironmentSecrets },
        resolvedPiAuthPath,
      });
      // Re-submit every selected durable value, not only values typed during this
      // wizard session. That lets the secure merge tighten an existing .env to
      // 0600 while preserving its non-empty operator-owned values verbatim.
      const selectedSecrets = {
        ...selectedSecretValues(plan, effectiveEnv),
        ...providerEnvironmentSecrets,
      };
      const secureExistingDotenv = hasSensitivePersistedEnvironmentValue(dotenvSnapshot.env);
      const conflicts = selectedSecretEnvironmentConflicts(
        plan,
        environment.shellEnv,
        dotenvSnapshot.env,
        moduleSecrets,
      );
      const persistedOverrides = unexpectedPersistedMonoAgentOverrides(plan, dotenvSnapshot.env);

      if (failure === undefined && persistedOverrides.length > 0) {
        failure = {
          ok: false,
          kind: "invalid_plan",
          message:
            `Persisted .env contains mono-agent config override${persistedOverrides.length === 1 ? "" : "s"}: ` +
            `${persistedOverrides.join(", ")}. Remove ${persistedOverrides.length === 1 ? "it" : "them"} so the ` +
            "generated config is the exact config validated and started.",
        };
      }
      if (failure === undefined && conflicts.length > 0) {
        failure = {
          ok: false,
          kind: "invalid_plan",
          message:
            `Selected secret${conflicts.length === 1 ? "" : "s"} ${conflicts.join(", ")} ` +
            "differ between the exported shell, persisted .env, or newly entered value. " +
            "Unset the shell value or make every source match, then retry.",
        };
      }
      if (failure === undefined && piAuthPathBackgroundConflict({
        cwd,
        shellPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH,
        dotenvPath: dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH,
        ...(nonEmptyEnv(plan.configJson.providers?.piAuthPath)
          ? { configPath: plan.configJson.providers.piAuthPath }
          : {}),
      })) {
        failure = {
          ok: false,
          kind: "invalid_plan",
          message:
            "The exported MONO_AGENT_PI_AUTH_PATH selects a different credential store than a background start. " +
            "Persist the same path in .env or providers.piAuthPath, or unset the shell override, then retry.",
        };
      }

      if (failure === undefined && pendingProviderSetup) {
        pendingProviderSetup = false;
        const modelRefs = referencedSetupModelRefs(plan);
        const credentialObservation = await withScopedPreflightCancellation(async (abortSignal) => ({
          states: await detectProviderCredentialStates({
            modelRefs,
            cwd,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            abortSignal,
          }),
          interrupted: abortSignal.aborted,
        }));
        if (credentialObservation.interrupted) {
          pendingProviderSetup = true;
          deferredFailure = {
            ok: false,
            kind: "cancelled",
            message: "Provider status detection was interrupted. No agent files were written.",
            interrupted: true,
          };
          continue firstRun;
        }
        credentialStates = credentialObservation.states;
        const plannedSetup = planProviderSetup({
          modelRefs,
          cwd,
          piAuthPath: resolvedPiAuthPath,
          credentialStates,
          piApiKeyPersistenceByProvider,
        });
        if (plannedSetup.actions.some((action) => action.id === "codex-login")) {
          const selected = await selectCodexAuthMode(selectedCodexAuthMode);
          if (selected === undefined) return 1;
          selectedCodexAuthMode = selected;
        }
        const environmentApiKeys = environmentProviderApiKeys(plannedSetup, effectiveEnv);
        const missingEnvironmentKeys = plannedSetup.actions
          .filter(isProviderSetupPiApiKeyAction)
          .filter((action) => action.persistence === "environment" && environmentApiKeys[action.id] === undefined)
          .map((action) => action.envVar);
        if (missingEnvironmentKeys.length > 0) {
          for (const envVar of missingEnvironmentKeys) {
            const answer = await p.password({
              message: `Enter ${envVar} for the agent's owner-only .env`,
              validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
              clearOnError: true,
            });
            if (p.isCancel(answer)) return 1;
            providerEnvironmentSecrets[envVar] = answer;
          }
          pendingProviderSetup = true;
          continue firstRun;
        }
        const setup = await withScopedPreflightCancellation((abortSignal) =>
          withExactProcessEnvironment(effectiveEnv, () =>
            runProviderSetupBeforeInit({
              modelRefs,
              cwd,
              auth: true,
              dryRun: false,
              piAuthPath: resolvedPiAuthPath,
              apiKeys: { ...providerSetupSecrets, ...environmentApiKeys },
              codexAuthMode: selectedCodexAuthMode,
              credentialStates,
              persistedEnv: dotenvSnapshot.env,
              piApiKeyPersistenceByProvider,
              abortSignal,
            })), { keypress: false });
        if (setup === "fatal") return 130;
        if (setup === "interrupted") {
          pendingProviderSetup = true;
          failure = {
            ok: false,
            kind: "cancelled",
            message: "Provider setup was interrupted. No agent files were written.",
            interrupted: true,
          };
        } else if (setup === "failed") {
          // A plain retry must revisit provider setup rather than falling
          // through to a guaranteed-failing model turn.
          pendingProviderSetup = true;
          failure = {
            ok: false,
            kind: "provider_failed",
            message: "Provider setup did not complete. No agent files were written.",
          };
        }
      }

      if (failure === undefined) {
        if (answers.sandbox) {
          const sandboxPreflight = await runGuidedSandboxPreflight(sandboxMutationCompleted);
          sandboxMutationCompleted = sandboxMutationCompleted || sandboxPreflight.ok;
          if (!sandboxPreflight.ok) failure = sandboxPreflight;
        }
      }

      if (failure === undefined) {
        const configurationGate = await runConfigurationPreflightWithSpinner({
          cwd,
          answers,
          plan,
          env: effectiveEnv,
          secretValues: selectedSecrets,
          secureExistingDotenv,
        });
        if (configurationGate.interrupted === true) {
          failure = {
            ok: false,
            kind: "cancelled",
            message: "Configuration preflight was interrupted. No agent files were written.",
            interrupted: true,
          };
        } else if (!configurationGate.ready) {
          configurationRecoveryStep = focusedConfigurationRepairStep(configurationGate.failedSectionIds);
          invalidPlanStage = "configuration";
          failure = {
            ok: false,
            kind: "invalid_plan",
            message: `Configuration preflight did not pass: ${configurationGate.reasons.join(" ")}`,
          };
        }
      }

      if (failure === undefined) {
        const readiness = await runReadinessProbeWithSpinner({
          plan,
          effectiveEnv,
          resolvedPiAuthPath,
          ...(readinessProgress === undefined ? {} : {
            resume: {
              planFingerprint: readinessProgress.planFingerprint,
              successfulRouteKeys: readinessProgress.successfulRouteKeys,
            },
          }),
        });
        readinessProgress = mergeReadinessProgress(readinessProgress, readiness, plan);
        failure = readiness;
      }

      readyAttempt: if (failure.ok) {
        const stagedGate = await runFinalReadinessValidationWithSpinner({
          cwd,
          answers,
          plan,
          env: effectiveEnv,
          secretValues: selectedSecrets,
          secureExistingDotenv,
          verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
        });
        if (stagedGate.interrupted === true) {
          failure = {
            ok: false,
            kind: "cancelled",
            message: "Final readiness validation was interrupted. No agent files were written.",
            interrupted: true,
          };
          break readyAttempt;
        }
        if (stagedGate.ready) {
          const drift = await firstRunDotenvDrift(environment.dotenvPath, dotenvSnapshot);
          if (drift !== undefined) {
            failure = drift;
            break readyAttempt;
          }
          let result: InitMonoAgentFolderResult;
          try {
            result = await initMonoAgentFolder({
              dir: cwd,
              answers,
              secretValues: selectedSecrets,
              secureExistingDotenv,
              requireConfigCreation: true,
            });
          } catch (error) {
            const recovery = secretPersistenceRecoveryMessage(error);
            process.stderr.write(ui.errorLine(
              `The validated scaffold could not be committed safely. The agent was not started; inspect the destination before retrying.${recovery}`,
            ));
            return 1;
          }
          let committedConfigSnapshot: CliConfigSnapshot;
          try {
            committedConfigSnapshot = await readCliConfigSnapshot(result.configPath);
          } catch {
            printIncompleteSetup(
              ["The committed config could not be read back as the regular file setup created."],
              result.configPath,
            );
            return 1;
          }
          if (committedConfigSnapshot.contents !== `${JSON.stringify(result.plan.configJson, null, 2)}\n`) {
            printIncompleteSetup(
              ["The committed config does not match the exact plan setup validated."],
              result.configPath,
            );
            return 1;
          }
          let committedDotenvSnapshot: CliDotenvSnapshot;
          try {
            committedDotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
          } catch {
            printIncompleteSetup(
              ["The committed .env could not be read back safely; no readiness claim is safe."],
              result.configPath,
            );
            return 1;
          }
          const postWriteConflicts = selectedSecretEnvironmentConflicts(
            result.plan,
            environment.shellEnv,
            committedDotenvSnapshot.env,
            moduleSecrets,
          );
          const postWriteOverrides = unexpectedPersistedMonoAgentOverrides(
            result.plan,
            committedDotenvSnapshot.env,
          );
          const postWritePiAuthConflict = piAuthPathBackgroundConflict({
            cwd,
            shellPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH,
            dotenvPath: committedDotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH,
            ...(nonEmptyEnv(result.plan.configJson.providers?.piAuthPath)
              ? { configPath: result.plan.configJson.providers.piAuthPath }
              : {}),
          });
          if (postWriteConflicts.length > 0 || postWriteOverrides.length > 0 || postWritePiAuthConflict) {
            printIncompleteSetup(
              ["The committed .env no longer matches the values and generated config that setup approved."],
              result.configPath,
            );
            return 1;
          }
          const postWriteEnv = effectiveFirstRunEnvironment({
            shellEnv: environment.shellEnv,
            dotenvEnv: committedDotenvSnapshot.env,
            resolvedPiAuthPath,
          });
          if (!sameConcreteEnvironment(effectiveEnv, postWriteEnv)) {
            printIncompleteSetup(
              ["The durable environment changed after the primary-model check. Retry setup before claiming readiness."],
              result.configPath,
            );
            return 1;
          }
          printInitResult(result);
          let report: ValidationReport;
          try {
            report = await validateMonoAgentFolder({
              env: postWriteEnv,
              cwd,
              configPath: result.configPath,
              liveness: true,
              verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
            });
          } catch {
            printIncompleteSetup(
              ["Post-write validation could not complete; no readiness claim is safe."],
              result.configPath,
            );
            return 1;
          }
          process.stdout.write("\n" + ui.heading("Validation"));
          for (const section of report.sections) process.stdout.write(formatSection(section));
          process.stdout.write(renderPlanCompleteness(result.plan.validateExpectations, "Selected capabilities", report));
          const configuredSecrets = configuredSecretNames(result, postWriteEnv);
          printSecretsChecklist(result.plan.secrets, configuredSecrets);
          const finalGate = evaluateFirstRunReadiness({
            plan: result.plan,
            report,
            secretPersistence: result.secretPersistence,
            verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
          });
          if (!finalGate.ready) {
            printIncompleteSetup(finalGate.reasons, result.configPath);
            return 1;
          }
          const postValidationConfigDrift = await firstRunConfigDrift(
            result.configPath,
            committedConfigSnapshot,
          );
          if (postValidationConfigDrift !== undefined) {
            printIncompleteSetup([postValidationConfigDrift.message], result.configPath);
            return 1;
          }
          const postValidationDrift = await firstRunDotenvDrift(
            environment.dotenvPath,
            committedDotenvSnapshot,
          );
          if (postValidationDrift !== undefined) {
            printIncompleteSetup([postValidationDrift.message], result.configPath);
            return 1;
          }
          const postValidationSecretGuard = await firstRunSecretEnvGuardFailure(
            environment.dotenvPath,
            result.secretPersistence.status === "persisted",
          );
          if (postValidationSecretGuard !== undefined) {
            printIncompleteSetup([postValidationSecretGuard.message], result.configPath);
            return 1;
          }
          process.stdout.write(
            ui.badge("ok") + ui.style.green("All runtime route checks passed — every selected model produced a real no-tool response.\n") +
            ui.badge("ok") + ui.style.green("Agent ready — every selected capability passed full validation.\n"),
          );
          const preTuiConfigDrift = await firstRunConfigDrift(
            result.configPath,
            committedConfigSnapshot,
          );
          if (preTuiConfigDrift !== undefined) {
            printIncompleteSetup([preTuiConfigDrift.message], result.configPath);
            return 1;
          }
          const preTuiDotenvDrift = await firstRunDotenvDrift(
            environment.dotenvPath,
            committedDotenvSnapshot,
          );
          if (preTuiDotenvDrift !== undefined) {
            printIncompleteSetup([preTuiDotenvDrift.message], result.configPath);
            return 1;
          }
          const preTuiSecretGuard = await firstRunSecretEnvGuardFailure(
            environment.dotenvPath,
            result.secretPersistence.status === "persisted",
          );
          if (preTuiSecretGuard !== undefined) {
            printIncompleteSetup([preTuiSecretGuard.message], result.configPath);
            return 1;
          }
          process.stdout.write(ui.badge("ok") + ui.style.green("Opening the ready agent in the local configuration TUI.\n"));
          const { runTui } = await import("./tui-command.js");
          return await withExactProcessEnvironment(postWriteEnv, () => runTui({
            configPath: result.configPath,
            cwd,
            env: postWriteEnv,
            local: true,
            configure: true,
          }));
        }
        configurationRecoveryStep = focusedConfigurationRepairStep(stagedGate.failedSectionIds);
        invalidPlanStage = "final_readiness";
        failure = {
          ok: false,
          kind: "invalid_plan",
          message: `Runtime route checks passed, but the complete agent is not ready: ${stagedGate.reasons.join(" ")}`,
        };
      }

      if (failure.ok) throw new Error("First-run recovery reached without a failure.");
      if (failure.interrupted === true || failure.kind === "cancelled") {
        interruptedRecoveryMenu: for (;;) {
          const interruptedRecovery = await selectInterruptedFirstRunRecovery();
          if (interruptedRecovery === "cancel") return 1;
          if (interruptedRecovery === "restart") {
            readinessProgress = undefined;
            break interruptedRecoveryMenu;
          }
          if (interruptedRecovery === "edit") {
            const repaired = await runSetupRepairWizard({
              cwd,
              answers,
              piAuthPath: resolvedPiAuthPath,
              persistedEnv: dotenvSnapshot.env,
              moduleSecrets,
              providerSetupSecrets,
              providerEnvironmentSecrets,
              piApiKeyPersistenceByProvider,
              credentialStates,
              runProviderSetup: pendingProviderSetup,
            });
            if (repaired.status === "cancelled") continue interruptedRecoveryMenu;
            answers = repaired.answers;
            moduleSecrets = { ...repaired.moduleSecrets };
            providerSetupSecrets = { ...repaired.providerSetupSecrets };
            providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
            piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
            credentialStates = { ...repaired.credentialStates };
            pendingProviderSetup = repaired.runProviderSetup;
            if (pendingProviderSetup) readinessProgress = undefined;
          }
          break interruptedRecoveryMenu;
        }
        continue firstRun;
      }
      if (failure.message.startsWith("[sandbox_preflight_failed]")) {
        sandboxRecoveryMenu: for (;;) {
          const recovery = await selectSandboxPreflightRecovery();
          if (recovery === "cancel") return 1;
          if (recovery === "edit") {
            const edited = await runSetupRepairWizard({
              cwd,
              answers,
              piAuthPath: resolvedPiAuthPath,
              persistedEnv: dotenvSnapshot.env,
              moduleSecrets,
              providerSetupSecrets,
              providerEnvironmentSecrets,
              piApiKeyPersistenceByProvider,
              credentialStates,
              runProviderSetup: pendingProviderSetup,
            });
            if (edited.status === "cancelled") continue sandboxRecoveryMenu;
            answers = edited.answers;
            moduleSecrets = { ...edited.moduleSecrets };
            providerSetupSecrets = { ...edited.providerSetupSecrets };
            providerEnvironmentSecrets = { ...edited.providerEnvironmentSecrets };
            piApiKeyPersistenceByProvider = { ...edited.piApiKeyPersistenceByProvider };
            credentialStates = { ...edited.credentialStates };
            pendingProviderSetup = edited.runProviderSetup;
            if (pendingProviderSetup) readinessProgress = undefined;
          }
          break sandboxRecoveryMenu;
        }
        continue firstRun;
      }
      let recoveryFailure: ReadinessProbeFailure = failure;
      recoveryMenu: for (;;) {
        p.log.error(`[${recoveryFailure.kind}] ${recoveryFailure.message}`);
        const recovery = await selectFirstRunRecovery(
          recoveryFailure,
          configurationRecoveryStep,
          invalidPlanStage,
        );
        if (recovery === "cancel") return 1;
        if (recovery === "save") {
          let saved: InitMonoAgentFolderResult;
          try {
            saved = await initMonoAgentFolder({
              dir: cwd,
              answers,
              secretValues: selectedSecrets,
              secureExistingDotenv,
              requireConfigCreation: true,
            });
          } catch (error) {
            const recovery = secretPersistenceRecoveryMessage(error);
            process.stderr.write(ui.errorLine(
              `The incomplete scaffold could not be committed safely; inspect the destination and retry.${recovery}`,
            ));
            return 1;
          }
          printInitResult(saved);
          let durableSavedEnv: CliEnvironment = {};
          if (saved.secretPersistence.status === "persisted") {
            try {
              durableSavedEnv = (await readCliDotenvSnapshot(environment.dotenvPath)).env;
            } catch {
              durableSavedEnv = {};
            }
          }
          printSecretsChecklist(
            saved.plan.secrets,
            configuredSecretNames(saved, durableSavedEnv),
          );
          printIncompleteSetup([recoveryFailure.message], saved.configPath);
          return 1;
        }
        if (recovery === "edit") {
          const repaired = await runSetupRepairWizard({
            cwd,
            answers,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            ...(configurationRecoveryStep === undefined ? {} : { initialStep: configurationRecoveryStep }),
            moduleSecrets,
            providerSetupSecrets,
            providerEnvironmentSecrets,
            piApiKeyPersistenceByProvider,
            credentialStates,
            runProviderSetup: pendingProviderSetup,
          });
          if (repaired.status === "cancelled") continue recoveryMenu;
          answers = repaired.answers;
          moduleSecrets = { ...repaired.moduleSecrets };
          providerSetupSecrets = { ...repaired.providerSetupSecrets };
          providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
          piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
          credentialStates = { ...repaired.credentialStates };
          pendingProviderSetup = repaired.runProviderSetup;
          if (pendingProviderSetup) readinessProgress = undefined;
          continue firstRun;
        }
        if (recovery === "model") {
          const repaired = await runSetupRepairWizard({
            cwd,
            answers,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            initialStep: 1,
            moduleSecrets,
            providerSetupSecrets,
            providerEnvironmentSecrets,
            piApiKeyPersistenceByProvider,
            credentialStates,
            runProviderSetup: pendingProviderSetup,
          });
          if (repaired.status === "cancelled") continue recoveryMenu;
          answers = repaired.answers;
          moduleSecrets = { ...repaired.moduleSecrets };
          providerSetupSecrets = { ...repaired.providerSetupSecrets };
          providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
          piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
          credentialStates = { ...repaired.credentialStates };
          pendingProviderSetup = repaired.runProviderSetup;
          if (pendingProviderSetup) readinessProgress = undefined;
          continue firstRun;
        }
        if (recovery === "auth") {
          // Authentication can replace credential bytes without changing the
          // route/config fingerprint. Every route must be proven again.
          readinessProgress = undefined;
          if (referencedSetupModelRefs(plan).some((ref) => ref.startsWith("codex:"))) {
            const selected = await selectCodexAuthMode(selectedCodexAuthMode);
            if (selected === undefined) return 1;
            selectedCodexAuthMode = selected;
          }
          const setupPlan = planProviderSetup({
            modelRefs: referencedSetupModelRefs(plan),
            cwd,
            piAuthPath: resolvedPiAuthPath,
            codexAuthMode: selectedCodexAuthMode,
            forceAuthentication: true,
          });
          const prompted = await promptProviderSetupSecrets(
            setupPlan,
            providerSetupSecrets,
            piApiKeyPersistenceByProvider,
            providerEnvironmentSecrets,
          );
          if (prompted === undefined) return 1;
          providerSetupSecrets = prompted.apiKeys;
          piApiKeyPersistenceByProvider = prompted.persistenceByProvider;
          providerEnvironmentSecrets = prompted.environmentSecrets;
          readinessProgress = undefined;
          const selectedSetupPlan = planProviderSetup({
            modelRefs: referencedSetupModelRefs(plan),
            cwd,
            piAuthPath: resolvedPiAuthPath,
            codexAuthMode: selectedCodexAuthMode,
            forceAuthentication: true,
            piApiKeyPersistenceByProvider,
          });
          const environmentApiKeys = environmentProviderApiKeys(
            selectedSetupPlan,
            { ...effectiveEnv, ...providerEnvironmentSecrets },
          );
          const missingEnvironmentKeys = selectedSetupPlan.actions
            .filter(isProviderSetupPiApiKeyAction)
            .filter((action) => action.persistence === "environment" && environmentApiKeys[action.id] === undefined)
            .map((action) => action.envVar);
          if (missingEnvironmentKeys.length > 0) {
            recoveryFailure = {
              ok: false,
              kind: "provider_failed",
              message: `Add ${missingEnvironmentKeys.join(", ")} to the durable owner-only .env, then retry authentication. No agent files were written.`,
            };
            continue recoveryMenu;
          }
          const setup = await withScopedPreflightCancellation((abortSignal) =>
            withExactProcessEnvironment(effectiveEnv, () =>
              runProviderSetupBeforeInit({
                modelRefs: referencedSetupModelRefs(plan),
                cwd,
                auth: true,
                dryRun: false,
                piAuthPath: resolvedPiAuthPath,
                apiKeys: { ...providerSetupSecrets, ...environmentApiKeys },
                codexAuthMode: selectedCodexAuthMode,
                forceAuthentication: true,
                piApiKeyPersistenceByProvider,
                abortSignal,
              })), { keypress: false });
          if (setup === "fatal") return 130;
          if (setup === "interrupted") {
            pendingProviderSetup = true;
            deferredFailure = {
              ok: false,
              kind: "cancelled",
              message: "Provider setup was interrupted. No agent files were written.",
              interrupted: true,
            };
            continue firstRun;
          }
          if (setup === "failed") {
            pendingProviderSetup = true;
            recoveryFailure = {
              ok: false,
              kind: "provider_failed",
              message: "Provider setup still needs attention. No agent files were written.",
            };
            continue recoveryMenu;
          }
          pendingProviderSetup = false;
        }
        // "retry" deliberately reruns only the live checks. Provider setup is a
        // separate explicit recovery action and is never repeated automatically.
        continue firstRun;
      }
    }
  }

  const presetId = resolveInitPresetId(args);
  if (presetId === "unknown") {
    return 1;
  }

  const withChannels = resolveWithChannels(args);
  if (withChannels === "invalid") {
    return 1;
  }

  const answers = answersFromCli({
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }),
    ...(args.fallbacks === undefined ? {} : { fallbacks: args.fallbacks }),
    ...(args.routeSafety === undefined ? {} : { routeSafety: args.routeSafety }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(presetId === undefined ? {} : { presetId }),
  });

  const previewPlan = composeWizardPlan(answers, {
    dirBasename: basename(process.cwd()),
    skillsRootExists: await pathExists(resolve(process.cwd(), "skills")),
  });
  const nonInteractivePiAuthPath = resolveEffectivePiAuthPath({
    cwd,
    ...(nonEmptyEnv(environment.shellEnv.MONO_AGENT_PI_AUTH_PATH)
      ? { envPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH }
      : nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
        : {}),
    ...(nonEmptyEnv(previewPlan.configJson.providers?.piAuthPath)
      ? { configPath: previewPlan.configJson.providers.piAuthPath }
      : {}),
  });
  const nonInteractiveEnvironment = effectiveFirstRunEnvironment({
    shellEnv: environment.shellEnv,
    dotenvEnv: environment.dotenvEnv,
    resolvedPiAuthPath: nonInteractivePiAuthPath,
  });
  const setup = await withScopedPreflightCancellation((abortSignal) =>
    withExactProcessEnvironment(nonInteractiveEnvironment, () =>
      runProviderSetupBeforeInit({
        modelRefs: referencedSetupModelRefs(previewPlan),
        cwd,
        auth: args.auth === true,
        dryRun: args.dryRun,
        persistedEnv: environment.dotenvEnv,
        piAuthPath: nonInteractivePiAuthPath,
        ...(args.codexAuthMode === undefined ? {} : { codexAuthMode: args.codexAuthMode }),
        abortSignal,
      })), { keypress: false });
  if (setup === "interrupted" || setup === "fatal") {
    return 130;
  }
  if (setup === "failed") {
    return 1;
  }

  const result = await initMonoAgentFolder({ dir: cwd, answers, dryRun: args.dryRun });

  printInitResult(result);
  printSecretsChecklist(result.plan.secrets, new Set());
  printNextSteps(result.configPath);
  return 0;
}

type AssessedConfigurationReadiness = ReturnType<typeof evaluateFirstRunConfigurationReadiness> & {
  readonly failedSectionIds: readonly string[];
  readonly interrupted?: true;
};

type AssessedFinalReadiness = ReturnType<typeof evaluateFirstRunReadiness> & {
  readonly failedSectionIds: readonly string[];
  readonly interrupted?: true;
};

const FIRST_RUN_STAGING_FAILURE_MAX_LENGTH = 500;
const FIRST_RUN_SENSITIVE_ENV_NAME = /(api.?key|credential|password|secret|token)/iu;

function throwIfFirstRunPreflightAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Preflight was interrupted.");
  error.name = "AbortError";
  throw error;
}

function firstRunStagingFailureDetail(
  error: unknown,
  sensitiveValues: Iterable<string> = [],
): string {
  let message = reasonOf(error);
  for (const value of [...new Set(sensitiveValues)].filter((candidate) => candidate.length >= 4).sort(
    (left, right) => right.length - left.length,
  )) {
    message = message.replaceAll(value, "[secret-redacted]");
  }
  const normalized = message
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [secret-redacted]")
    .replace(
      /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)(\s*[=:]\s*)([^\s,;]+)/giu,
      (_match, label: string, separator: string) => `${label}${separator}[secret-redacted]`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return "Unknown staging failure.";
  return normalized.length <= FIRST_RUN_STAGING_FAILURE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, FIRST_RUN_STAGING_FAILURE_MAX_LENGTH - 1).trimEnd()}…`;
}

function firstRunStagingSensitiveValues(
  env: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>>,
): readonly string[] {
  return [
    ...Object.entries(env)
      .filter((entry): entry is [string, string] =>
        FIRST_RUN_SENSITIVE_ENV_NAME.test(entry[0])
        && typeof entry[1] === "string"
        && entry[1].length > 0
      )
      .map(([, value]) => value),
    ...Object.values(explicit),
  ];
}

async function runConfigurationPreflightWithSpinner(
  options: Omit<Parameters<typeof assessPrewriteFirstRunConfigurationReadiness>[0], "abortSignal">,
): Promise<AssessedConfigurationReadiness> {
  process.stdout.write("\n" + ui.heading("Configuration preflight"));
  const spinner = p.spinner();
  try {
    return await withScopedPreflightCancellation(async (abortSignal) => {
      spinner.start("Validating generated files and selected capabilities before runtime calls");
      const gate = await assessPrewriteFirstRunConfigurationReadiness({ ...options, abortSignal });
      if (abortSignal.aborted || spinner.isCancelled) {
        spinner.cancel("Configuration preflight interrupted");
        return interruptedConfigurationAssessment();
      }
      if (gate.ready) {
        spinner.stop("Selected capabilities are ready for runtime checks");
      } else {
        spinner.error("Configuration preflight needs attention");
      }
      return gate;
    });
  } catch (error) {
    if (!isAbortLike(error)) throw error;
    spinner.cancel("Configuration preflight interrupted");
    return interruptedConfigurationAssessment();
  }
}

function interruptedConfigurationAssessment(): AssessedConfigurationReadiness {
  return {
    ready: false,
    reasons: ["Configuration preflight was interrupted."],
    failedSectionIds: [],
    interrupted: true,
  };
}

async function runFinalReadinessValidationWithSpinner(
  options: Omit<Parameters<typeof assessPrewriteFirstRunReadiness>[0], "abortSignal">,
): Promise<AssessedFinalReadiness> {
  process.stdout.write("\n" + ui.heading("Final readiness validation"));
  const spinner = p.spinner();
  try {
    return await withScopedPreflightCancellation(async (abortSignal) => {
      spinner.start("Revalidating the effective files after runtime route checks");
      const gate = await assessPrewriteFirstRunReadiness({ ...options, abortSignal });
      if (abortSignal.aborted || spinner.isCancelled) {
        spinner.cancel("Final readiness validation interrupted");
        return interruptedFinalReadinessAssessment();
      }
      if (gate.ready) spinner.stop("Effective files and runtime routes are ready");
      else spinner.error("Final readiness validation needs attention");
      return gate;
    });
  } catch (error) {
    if (!isAbortLike(error)) throw error;
    spinner.cancel("Final readiness validation interrupted");
    return interruptedFinalReadinessAssessment();
  }
}

function interruptedFinalReadinessAssessment(): AssessedFinalReadiness {
  return {
    ready: false,
    reasons: ["Final readiness validation was interrupted."],
    failedSectionIds: [],
    interrupted: true,
  };
}

async function assessPrewriteFirstRunConfigurationReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
  readonly abortSignal?: AbortSignal;
}): Promise<AssessedConfigurationReadiness> {
  try {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: [],
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const gate = evaluateFirstRunConfigurationReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
    });
    return {
      ...gate,
      failedSectionIds: configurationFailureSectionIds(options.plan, report, true),
    };
  } catch (error) {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      ready: false,
      reasons: [
        `The complete generated configuration could not be validated safely in staging: ${firstRunStagingFailureDetail(
          error,
          firstRunStagingSensitiveValues(options.env, options.secretValues),
        )}`,
      ],
      failedSectionIds: [],
    };
  }
}

async function assessPrewriteFirstRunReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
  readonly verifiedCredentialModelRefs: readonly string[];
  readonly abortSignal?: AbortSignal;
}): Promise<AssessedFinalReadiness> {
  try {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const gate = evaluateFirstRunReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
    });
    return {
      ...gate,
      failedSectionIds: configurationFailureSectionIds(options.plan, report, false),
    };
  } catch (error) {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      ready: false,
      reasons: [
        `The complete generated plan could not be validated safely in staging: ${firstRunStagingFailureDetail(
          error,
          firstRunStagingSensitiveValues(options.env, options.secretValues),
        )}`,
      ],
      failedSectionIds: [],
    };
  }
}

function configurationFailureSectionIds(
  plan: WizardPlan,
  report: ValidationReport,
  deferWaitingCredentials: boolean,
): readonly string[] {
  const byId = new Map(report.sections.map((section) => [section.id, section]));
  const ids = new Set<string>();
  for (const expectation of plan.validateExpectations) {
    const actual = byId.get(expectation.sectionId)?.status;
    if (
      actual === expectation.mustBe
      || (deferWaitingCredentials && expectation.sectionId === "credentials" && actual === "waiting")
    ) continue;
    ids.add(expectation.sectionId);
  }
  if (!report.ok) {
    for (const section of report.sections) {
      if (section.status === "error") ids.add(section.id);
    }
  }
  return [...ids];
}

function nonEmptyEnv(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameConcreteEnvironment(left: CliEnvironment, right: CliEnvironment): boolean {
  const concreteEntries = (env: CliEnvironment): readonly (readonly [string, string])[] =>
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const leftEntries = concreteEntries(left);
  const rightEntries = concreteEntries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(
    ([name, value], index) => rightEntries[index]?.[0] === name && rightEntries[index]?.[1] === value,
  );
}

function dotenvReadinessFailure(message: string): ReadinessProbeFailure {
  return { ok: false, kind: "invalid_plan", message };
}

async function firstRunDotenvDrift(
  path: string,
  expected: CliDotenvSnapshot,
): Promise<ReadinessProbeFailure | undefined> {
  let current: CliDotenvSnapshot;
  try {
    current = await readCliDotenvSnapshot(path);
  } catch {
    return dotenvReadinessFailure("The persisted .env became unreadable during setup. Readiness cannot be claimed.");
  }
  if (current.fingerprint === expected.fingerprint) return undefined;
  return dotenvReadinessFailure(
    "The persisted .env changed while setup was validating the agent. Review the change, then retry so the exact durable values can be checked.",
  );
}

async function firstRunConfigDrift(
  path: string,
  expected: CliConfigSnapshot,
): Promise<ReadinessProbeFailure | undefined> {
  let current: CliConfigSnapshot;
  try {
    current = await readCliConfigSnapshot(path);
  } catch {
    return dotenvReadinessFailure(
      "The committed config became unreadable or unsafe during setup. Readiness cannot be claimed.",
    );
  }
  if (current.fingerprint === expected.fingerprint) return undefined;
  return dotenvReadinessFailure(
    "The committed config changed while setup was validating the agent. Review the change, then retry so the exact plan can be checked.",
  );
}

async function firstRunSecretEnvGuardFailure(
  path: string,
  required: boolean,
): Promise<ReadinessProbeFailure | undefined> {
  if (!required) return undefined;
  try {
    if (await verifySecretEnvPersistenceGuard(path)) return undefined;
  } catch {
    // Fall through to one stable, non-secret-bearing operator message.
  }
  return dotenvReadinessFailure(
    "The committed .env is no longer owner-only, safely ignored, and untracked. Readiness cannot be claimed.",
  );
}

function secretPersistenceRecoveryMessage(error: unknown): string {
  if (!(error instanceof SecretEnvConcurrentModificationError)) {
    return "";
  }
  return ` ${error.message}`;
}

interface ReadinessProgress {
  readonly planFingerprint: string;
  readonly successfulRouteKeys: readonly string[];
  readonly verifiedModelRefs: readonly string[];
}

function readinessPlanIdentity(plan: WizardPlan): {
  readonly fingerprint: string;
  readonly routes: readonly (Readonly<{ index: number; model: string; effort?: string; key: string }>)[];
} {
  const displayed = readinessRoutesForDisplay(plan);
  const immutable = displayed.map((route, index) => ({
    index,
    model: route.model,
    effort: route.effort ?? null,
  }));
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ version: 1, routes: immutable }))
      .digest("hex"),
    routes: displayed.map((route, index) => ({
      index,
      ...route,
      key: createHash("sha256")
        .update(JSON.stringify({ version: 1, index, model: route.model, effort: route.effort ?? null }))
        .digest("hex"),
    })),
  };
}

function mergeReadinessProgress(
  previous: ReadinessProgress | undefined,
  result: ReadinessProbeResult,
  plan: WizardPlan,
): ReadinessProgress {
  const identity = readinessPlanIdentity(plan);
  const fingerprint = result.planFingerprint ?? identity.fingerprint;
  const successfulKeys = new Set(
    previous?.planFingerprint === fingerprint ? previous.successfulRouteKeys : [],
  );
  const verifiedRefs = new Set(
    previous?.planFingerprint === fingerprint ? previous.verifiedModelRefs : [],
  );
  const reported = result.routes ?? (result.ok
    ? identity.routes.map((route): ReadinessRouteResult => ({ ...route, status: "verified" }))
    : []);
  for (const route of reported) {
    if (route.status === "verified" || route.status === "skipped_verified") {
      successfulKeys.add(route.key);
      verifiedRefs.add(route.model);
    }
  }
  const currentRefs = new Set(identity.routes.map((route) => route.model));
  return {
    planFingerprint: fingerprint,
    successfulRouteKeys: [...successfulKeys],
    verifiedModelRefs: [...verifiedRefs].filter((ref) => currentRefs.has(ref)),
  };
}

async function runGuidedSandboxPreflight(
  installedEarlier: boolean,
): Promise<ReadinessProbeResult> {
  process.stdout.write("\n" + ui.heading("Sandbox preflight"));
  return await withScopedPreflightCancellation(async (signal) => {
    try {
      process.stdout.write(ui.style.dim(
        installedEarlier
          ? "Rechecking the pinned managed SRT copy and its functional enforcement postcondition.\n"
          : "Installing the pinned managed SRT copy in the private user cache, then running the functional enforcement check.\n",
      ));
      const setup = await setupManagedSrt({ signal, verify: true });
      if (setup.status.source !== "managed" || setup.status.state !== "ready" || setup.check === undefined) {
        throw new Error("Managed SRT setup did not return a ready managed functional-check result.");
      }
      process.stdout.write(`${ui.badge("ok")}Managed SRT ${setup.repaired ? "repaired" : setup.installed ? "installed" : "verified"}; functional postcondition passed.\n`);
      return { ok: true };
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("Preflight was interrupted."));
        return {
          ok: false,
          kind: "cancelled",
          message: "Sandbox preflight was interrupted. No agent files were written.",
          interrupted: true,
        };
      }
      return {
        ok: false,
        kind: "provider_failed",
        message: `[sandbox_preflight_failed] ${reasonOf(error)} No agent files were written; retry setup or edit the sandbox choice.`,
      };
    }
  });
}

async function runReadinessProbeWithSpinner(options: {
  readonly plan: ReturnType<typeof composeWizardPlan>;
  readonly effectiveEnv: Record<string, string | undefined>;
  readonly resolvedPiAuthPath: string;
  readonly resume?: Readonly<{ planFingerprint: string; successfulRouteKeys: readonly string[] }>;
}): Promise<ReadinessProbeResult> {
  const routes = readinessRoutesForDisplay(options.plan);
  process.stdout.write("\n" + ui.heading("Runtime readiness"));
  routes.forEach((route, index) => {
    const timeoutMs = readinessProbeTimeoutMs(parseMonoRuntimeModelReference(route.model));
    process.stdout.write(
      `  Route ${index + 1}/${routes.length}: ${route.model} ` +
      ui.style.dim(`(effort: ${route.effort ?? "provider-default"}; up to ${Math.ceil(timeoutMs / 1_000)}s)`) +
      "\n",
    );
  });
  process.stdout.write(ui.style.dim("Running real no-tool checks sequentially. Press Esc or Ctrl-C once to interrupt safely.\n"));

  return await withScopedPreflightCancellation(async (signal) => {
    try {
      const result = await runAllRouteReadinessProbe({
        plan: options.plan,
        hostEnv: options.effectiveEnv,
        secretValues: selectedSecretValues(options.plan, options.effectiveEnv),
        resolvedPiAuthPath: options.resolvedPiAuthPath,
        abortSignal: signal,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        onRouteStart: (route) => {
          process.stdout.write(
            `  Checking route ${route.index + 1}/${route.total}: ${route.model} ` +
            ui.style.dim(`(effort: ${route.effort ?? "provider-default"})`) +
            "\n",
          );
        },
        onRouteComplete: (route) => {
          const ok = route.status === "verified" || route.status === "skipped_verified";
          process.stdout.write(
            `${ok ? ui.badge("ok") : route.status === "interrupted" ? ui.badge("waiting") : ui.badge("error")}` +
            `Route ${route.index + 1}/${routes.length} ${route.status.replaceAll("_", " ")}\n`,
          );
        },
      });
      process.stdout.write(ui.heading("Readiness summary"));
      printReadinessRouteSummary(result, routes);
      return result;
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("Preflight was interrupted."));
        return {
          ok: false,
          kind: "cancelled",
          message: "Preflight was interrupted before the current route completed.",
          interrupted: true,
        };
      }
      process.stderr.write(ui.errorLine("[readiness_probe_failed] Runtime readiness could not run."));
      return {
        ok: false,
        kind: "probe_failed",
        message: "Runtime readiness could not run. Review provider authentication and retry.",
      };
    }
  });
}

function readinessRoutesForDisplay(plan: WizardPlan): readonly { model: string; effort?: string }[] {
  const runtime = (plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const primaryEffort = typeof runtime.effort === "string" ? runtime.effort : undefined;
  const routes: Array<{ model: string; effort?: string }> = [];
  if (typeof runtime.model === "string") {
    routes.push({ model: runtime.model, ...(primaryEffort === undefined ? {} : { effort: primaryEffort }) });
  }
  if (Array.isArray(runtime.fallbacks) && runtime.fallbacks.length > 0) {
    for (const raw of runtime.fallbacks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.model !== "string") continue;
      routes.push({
        model: entry.model,
        ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
      });
    }
  } else if (Array.isArray(runtime.fallbackModels)) {
    for (const model of runtime.fallbackModels) {
      if (typeof model === "string") {
        routes.push({ model, ...(primaryEffort === undefined ? {} : { effort: primaryEffort }) });
      }
    }
  }
  return routes;
}

function printReadinessRouteSummary(
  result: ReadinessProbeResult,
  planned: readonly { model: string; effort?: string }[],
): void {
  const reported = result.routes ?? planned.map((route, index): ReadinessRouteResult => ({
    key: `${index}:${route.model}`,
    index,
    ...route,
    status: result.ok ? "verified" : result.kind === "cancelled" ? "interrupted" : "failed",
    ...(!result.ok ? { kind: result.kind, message: result.message } : {}),
  }));
  for (const route of reported) {
    const badge = route.status === "verified" || route.status === "skipped_verified"
      ? ui.badge("ok")
      : route.status === "interrupted"
        ? ui.badge("waiting")
        : ui.badge("error");
    const state = route.status === "skipped_verified" ? "verified earlier" : route.status.replaceAll("_", " ");
    process.stdout.write(
      `${badge}Route ${route.index + 1}/${planned.length}: ${route.model} ` +
      ui.style.dim(`(effort: ${route.effort ?? "provider-default"})`) +
      ` — ${state}${route.message === undefined ? "" : `: ${route.message}`}\n`,
    );
  }
  if (!result.ok && result.interrupted === true) {
    process.stderr.write(ui.errorLine("Preflight was interrupted."));
  }
}

async function withScopedPreflightCancellation<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: { readonly keypress?: boolean } = {},
): Promise<T> {
  const controller = new AbortController();
  let interruptCount = 0;
  const interrupt = (): void => {
    interruptCount += 1;
    controller.abort();
    if (interruptCount > 1) process.exitCode = 130;
  };
  const onKeypress = (_value: string, key: { readonly name?: string; readonly ctrl?: boolean } | undefined): void => {
    if (key?.name === "escape" || (key?.ctrl === true && key.name === "c")) interrupt();
  };
  process.on("SIGINT", interrupt);
  const restoreKeypress = options.keypress === false
    ? () => undefined
    : attachScopedKeypress(onKeypress);
  try {
    return await task(controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
    restoreKeypress();
  }
}

type FirstRunRecovery = "retry" | "auth" | "model" | "edit" | "save" | "cancel";

type InterruptedFirstRunRecovery = "resume" | "restart" | "edit" | "cancel";
type SandboxPreflightRecovery = "retry" | "edit" | "cancel";

function focusedConfigurationRepairStep(sectionIds: readonly string[]): number | undefined {
  const mapped = new Set<number>();
  for (const id of sectionIds) {
    if (id === "agent") mapped.add(0);
    else if (id === "runtime" || id === "credentials") mapped.add(1);
    else if (id === "memory" || id.startsWith("memory:")) mapped.add(3);
    else if (id === "context" || id.startsWith("channel:")) mapped.add(4);
    else if (id === "tools") mapped.add(5);
    else if (id === "sandbox") mapped.add(6);
    else if (id === "observability") mapped.add(7);
  }
  return mapped.size === 1 ? [...mapped][0] : undefined;
}

function configurationRecoveryEditLabel(step: number | undefined): string {
  switch (step) {
    case 0: return "Edit agent name";
    case 1: return "Edit model routes";
    case 3: return "Edit memory";
    case 4: return "Edit capability details";
    case 5: return "Edit tools";
    case 6: return "Edit route safety and sandbox";
    case 7: return "Edit observability";
    default: return "Edit setup choices";
  }
}

async function selectSandboxPreflightRecovery(): Promise<SandboxPreflightRecovery> {
  const recovery = await p.select<SandboxPreflightRecovery>({
    message: "Sandbox preflight did not pass. How would you like to recover?",
    initialValue: "retry",
    options: [
      { value: "retry", label: "Retry sandbox setup and check" },
      { value: "edit", label: "Change safety or other choices" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function selectInterruptedFirstRunRecovery(): Promise<InterruptedFirstRunRecovery> {
  const recovery = await p.select<InterruptedFirstRunRecovery>({
    message: "Preflight was interrupted. What would you like to do?",
    initialValue: "resume",
    options: [
      { value: "resume", label: "Resume preflight", hint: "keeps successful auth, SRT setup, and route checks" },
      { value: "restart", label: "Restart all checks", hint: "keeps successful auth and SRT installation" },
      { value: "edit", label: "Edit setup choices" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function selectFirstRunRecovery(
  failure: ReadinessProbeFailure,
  configurationRepairStep?: number,
  invalidPlanStage?: "configuration" | "final_readiness",
): Promise<FirstRunRecovery> {
  type RecoveryOption = { readonly value: FirstRunRecovery; readonly label: string; readonly hint?: string };
  const sharedTail: readonly RecoveryOption[] = [
    { value: "save", label: "Save incomplete", hint: "does not call the agent ready or start it" },
    { value: "cancel", label: "Cancel without writing" },
  ] as const;
  const providerSetupFailed = failure.kind === "provider_failed"
    && /^Provider setup (?:did not complete|still needs attention)\./u.test(failure.message);
  const message = failure.kind === "invalid_plan"
    ? invalidPlanStage === "final_readiness"
      ? "Final readiness validation did not pass. What would you like to do?"
      : "Configuration preflight did not pass. What would you like to do?"
    : providerSetupFailed
      ? "Provider setup did not pass. What would you like to do?"
      : "Runtime readiness did not pass. What would you like to do?";
  const options: readonly RecoveryOption[] = failure.kind === "invalid_plan"
    ? [
        { value: "edit", label: configurationRecoveryEditLabel(configurationRepairStep) },
        {
          value: "retry",
          label: invalidPlanStage === "final_readiness"
            ? "Retry final readiness validation"
            : "Retry configuration preflight",
        },
        ...sharedTail,
      ]
    : providerSetupFailed
      ? [
          { value: "auth", label: "Repair authentication" },
          { value: "retry", label: "Retry provider setup" },
          { value: "model", label: "Edit model routes" },
          ...sharedTail,
        ]
      : failure.kind === "provider_failed"
      ? [
          { value: "retry", label: "Retry failed route" },
          { value: "auth", label: "Repair authentication" },
          { value: "model", label: "Edit model routes" },
          ...sharedTail,
        ]
      : failure.kind === "unsupported_guided_probe"
        ? [
            { value: "model", label: "Edit model routes" },
            ...sharedTail,
          ]
        : [
            { value: "retry", label: "Retry runtime checks" },
            { value: "model", label: "Edit model routes" },
            ...sharedTail,
          ];
  const recovery = await p.select<FirstRunRecovery>({
    message,
    initialValue: options[0]?.value ?? "cancel",
    options: [...options],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function promptProviderSetupSecrets(
  plan: ProviderSetupPlan,
  existing: Readonly<Record<string, string>>,
  existingPersistence: Readonly<Record<string, "secure-store" | "environment">> = {},
  existingEnvironmentSecrets: Readonly<Record<string, string>> = {},
): Promise<{
  readonly apiKeys: Record<string, string>;
  readonly persistenceByProvider: Record<string, "secure-store" | "environment">;
  readonly environmentSecrets: Record<string, string>;
} | undefined> {
  const values = { ...existing };
  const persistenceByProvider = { ...existingPersistence };
  const environmentSecrets = { ...existingEnvironmentSecrets };
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action)) continue;
    const reviewedPersistence = existingPersistence[action.provider];
    const persistence = reviewedPersistence ?? await p.select<"secure-store" | "environment">({
      message: `How should ${action.label} receive ${action.envVar}?`,
      initialValue: "secure-store",
      options: [
        { value: "secure-store", label: "Store securely in Pi auth.json", hint: "owner-only credential store" },
        { value: "environment", label: `Use environment variable ${action.envVar}`, hint: "save it to the agent's owner-only .env" },
      ],
    });
    if (p.isCancel(persistence)) return undefined;
    if (persistence === "environment") {
      delete values[action.id];
      persistenceByProvider[action.provider] = "environment";
      const answer = await p.password({
        message: `Enter ${action.envVar} for the agent's owner-only .env`,
        validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
        clearOnError: true,
      });
      if (p.isCancel(answer)) return undefined;
      environmentSecrets[action.envVar] = answer;
      continue;
    }
    persistenceByProvider[action.provider] = "secure-store";
    delete environmentSecrets[action.envVar];
    const answer = await p.password({
      message: `Enter ${action.label} (${action.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
      clearOnError: true,
    });
    if (p.isCancel(answer)) return undefined;
    values[action.id] = answer;
  }
  return { apiKeys: values, persistenceByProvider, environmentSecrets };
}

function environmentProviderApiKeys(
  plan: ProviderSetupPlan,
  env: CliEnvironment,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action) || action.persistence !== "environment") continue;
    const value = env[action.envVar];
    if (nonEmptyEnv(value)) values[action.id] = value;
  }
  return values;
}

async function selectCodexAuthMode(
  initialValue: CodexLoginMode,
): Promise<CodexLoginMode | undefined> {
  const selected = await p.select<CodexLoginMode>({
    message: "How should Codex authenticate on this machine?",
    initialValue,
    options: [
      { value: "browser", label: "Browser login", hint: "opens a localhost callback server" },
      { value: "device", label: "Device-code login", hint: "recommended for remote or headless machines" },
    ],
  });
  return p.isCancel(selected) ? undefined : selected;
}

function configuredSecretNames(
  result: InitMonoAgentFolderResult,
  effectiveEnv: CliEnvironment,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const secret of result.plan.secrets) {
    if (nonEmptyEnv(effectiveEnv[secret.envVar])) names.add(secret.envVar);
  }
  return names;
}

function printIncompleteSetup(reasons: readonly string[], configPath: string): void {
  process.stderr.write(ui.hint("INCOMPLETE SETUP: no readiness claim was made and the agent was not started.\n"));
  for (const reason of reasons) process.stderr.write(ui.style.yellow(`  - ${reason}\n`));
  process.stderr.write(ui.hint(`Review ${configPath}, run \`mono-agent validate\`, then retry the first turn.\n`));
}

export function shouldRunInitWizard(args: ParsedCliArgs, stdinIsTty: boolean, stdoutIsTty: boolean): boolean {
  if (!stdinIsTty || !stdoutIsTty || args.command !== "init" || args.positionals.length > 0) {
    return false;
  }
  if (args.force || args.foreground || args.follow || args.all || args.dryRun || args.includeMemory) {
    return false;
  }
  // A bare parsed init has only these required/default keys. Treat every
  // optional key—current or future—as an overriding flag so the documented
  // "any flag is scaffold-only" contract cannot silently drift again.
  const bareKeys = new Set([
    "command",
    "positionals",
    "force",
    "foreground",
    "follow",
    "all",
    "dryRun",
    "includeMemory",
  ]);
  return Object.keys(args).every((key) => bareKeys.has(key));
}

export type InitProviderSetupStatus = "ok" | "failed" | "skipped" | "interrupted" | "fatal";

export interface RunProviderSetupBeforeInitOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly auth: boolean;
  readonly dryRun: boolean;
  readonly piAuthPath?: string;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  readonly codexAuthMode?: CodexLoginMode;
  readonly forceAuthentication?: boolean;
  readonly credentialStates?: Readonly<Record<string, ProviderCredentialState | undefined>>;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly piApiKeyPersistenceByProvider?: Readonly<Record<string, "secure-store" | "environment" | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly execute?: (plan: ProviderSetupPlan) => Promise<readonly ProviderSetupResult[]>;
}

export async function runProviderSetupBeforeInit(
  options: RunProviderSetupBeforeInitOptions,
): Promise<InitProviderSetupStatus> {
  const credentialStates = options.credentialStates !== undefined
    ? options.credentialStates
    : options.forceAuthentication === true || !options.auth || options.dryRun
      ? undefined
    : await detectProviderCredentialStates({
        modelRefs: options.modelRefs,
        cwd: options.cwd,
        ...(options.piAuthPath === undefined ? {} : { piAuthPath: options.piAuthPath }),
        ...(options.persistedEnv === undefined ? {} : { persistedEnv: options.persistedEnv }),
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      });
  const plan = planProviderSetup({
    ...options,
    ...(credentialStates === undefined ? {} : { credentialStates }),
    ...(options.codexAuthMode === undefined ? {} : { codexAuthMode: options.codexAuthMode }),
    ...(options.forceAuthentication === undefined ? {} : { forceAuthentication: options.forceAuthentication }),
  });
  if (plan.actions.length === 0) {
    return "skipped";
  }
  if (options.dryRun) {
    process.stdout.write("\n" + ui.heading("Provider setup"));
    process.stdout.write(ui.style.dim("Dry run - provider auth/preflight commands were not launched.\n"));
    printProviderSetupPlan(plan);
    return "skipped";
  }
  if (!options.auth) {
    return "skipped";
  }

  process.stdout.write("\n" + ui.heading("Provider setup"));
  printProviderSetupPlan(plan);
  if (options.abortSignal !== undefined) {
    process.stdout.write(ui.style.dim("Press Ctrl-C once to interrupt authentication safely.\n"));
  }
  const results = await (options.execute ?? ((setupPlan) => executeProviderSetupPlan(setupPlan, {
    ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  })))(plan);
  const interrupted = options.abortSignal?.aborted === true;
  for (const result of results) {
    const badge = interrupted && result.status === "failed"
      ? ui.badge("waiting")
      : result.status === "ok"
      ? ui.badge("ok")
      : result.status === "skipped"
        ? ui.style.dim("- ")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  if (results.some((result) => result.failureKind !== undefined)) {
    process.stderr.write(ui.errorLine(
      "Provider setup ended in an unconfirmed process or credential-cleanup state. Follow the reported manual cleanup guidance before retrying; automatic recovery is disabled.",
    ));
    return "fatal";
  }
  if (interrupted) {
    process.stderr.write(ui.errorLine("Provider setup was interrupted."));
    return "interrupted";
  }
  if (results.some((result) => result.status === "failed")) {
    process.stderr.write(ui.errorLine("Provider setup failed; init stopped before writing files."));
    return "failed";
  }
  return "ok";
}

async function runAuth(args: ParsedCliArgs): Promise<number> {
  const [subcommand, provider, ...extra] = args.positionals;
  if (subcommand !== "login" || provider === undefined || extra.length > 0) {
    process.stderr.write(ui.errorLine(
      "Usage: mono-agent auth login <provider|codex> [--pi-auth-path <path>] [--api-key-stdin] [--codex-auth browser|device] [--config <path>].",
    ));
    return 2;
  }

  const cwd = process.cwd();
  const configPath = resolve(cwd, args.configPath ?? "mono-agent.config.json");
  const directCodex = provider === "codex";
  if (directCodex && args.piAuthPath !== undefined) {
    process.stderr.write(ui.errorLine("--pi-auth-path does not apply to direct Codex login."));
    return 2;
  }
  let configuredPiAuthPath: string;
  try {
    configuredPiAuthPath = directCodex ? resolve(cwd, ".pi", "auth.json") : await resolvePiAuthPathForLogin({
      configPath,
      cwd,
      ...(process.env.MONO_AGENT_PI_AUTH_PATH === undefined
        ? {}
        : { envPath: process.env.MONO_AGENT_PI_AUTH_PATH }),
      ...(args.piAuthPath === undefined ? {} : { piAuthPath: args.piAuthPath }),
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Cannot resolve the Pi auth path from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  const plan = planProviderSetup({
    modelRefs: [directCodex ? "codex:gpt-5.6-terra" : `pi:${provider}:credential-setup`],
    cwd,
    piAuthPath: configuredPiAuthPath,
    forceAuthentication: true,
    ...(args.codexAuthMode === undefined ? {} : { codexAuthMode: args.codexAuthMode }),
  });
  if (plan.actions.length === 0) {
    process.stderr.write(ui.errorLine(
      `Provider \`${provider}\` has no interactive auth method in the bundled ${directCodex ? "Codex" : "Pi"} provider catalog.`,
    ));
    return 2;
  }

  const apiKeyActions = plan.actions.filter(isProviderSetupPiApiKeyAction);
  if (args.apiKeyStdin === true && apiKeyActions.length !== 1) {
    process.stderr.write(ui.errorLine(
      "--api-key-stdin is only supported when the selected provider has one bundled API-key login action.",
    ));
    return 2;
  }

  process.stdout.write("\n" + ui.heading(directCodex ? "Codex authentication" : "Pi authentication"));
  printProviderSetupPlan(plan);

  let apiKeys: Readonly<Record<string, string>> | undefined;
  const apiKeyAction = apiKeyActions[0];
  if (apiKeyAction !== undefined) {
    let apiKey: string;
    if (args.apiKeyStdin === true) {
      if (process.stdin.isTTY === true) {
        process.stderr.write(ui.errorLine(
          "--api-key-stdin requires redirected standard input. Omit the flag to enter the key in a masked prompt.",
        ));
        return 2;
      }
      try {
        apiKey = await readApiKeyFromStdin(process.stdin);
      } catch {
        process.stderr.write(ui.errorLine(
          `Could not read a valid ${apiKeyAction.envVar} value from standard input; no credentials were written.`,
        ));
        return 1;
      }
    } else {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        process.stderr.write(ui.errorLine(
          `Cannot securely prompt for ${apiKeyAction.envVar} without an interactive TTY. ` +
          `Run this command in a terminal, or pipe the value explicitly with --api-key-stdin; no credentials were written.`,
        ));
        return 1;
      }
      const answer = await p.password({
        message: `Enter ${apiKeyAction.label} (${apiKeyAction.envVar})`,
        validate: (value) => apiKeyInputProblem(value ?? ""),
        clearOnError: true,
      });
      if (p.isCancel(answer)) {
        process.stderr.write(ui.errorLine("Authentication was cancelled; no credentials were written."));
        return 130;
      }
      apiKey = answer.trim();
    }
    apiKeys = { [apiKeyAction.id]: apiKey };
  }

  process.stdout.write(ui.style.dim("Press Ctrl-C once to interrupt authentication safely.\n"));
  const execution = await withScopedPreflightCancellation(async (abortSignal) => ({
    results: await executeProviderSetupPlan(plan, {
      ...(apiKeys === undefined ? {} : { apiKeys }),
      abortSignal,
    }),
    interrupted: abortSignal.aborted,
  }), { keypress: false });
  const { results } = execution;
  for (const result of results) {
    const badge = execution.interrupted && result.status === "failed"
      ? ui.badge("waiting")
      : result.status === "ok"
        ? ui.badge("ok")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  if (results.some((result) => result.failureKind !== undefined)) {
    process.stderr.write(ui.errorLine(
      "Provider setup ended in an unconfirmed process or credential-cleanup state. Follow the reported manual cleanup guidance before retrying; automatic recovery is disabled.",
    ));
    return 130;
  }
  if (execution.interrupted) {
    process.stderr.write(ui.errorLine("Authentication was interrupted; temporary credentials were cleaned up."));
    return 130;
  }
  return results.every((result) => result.status === "ok") ? 0 : 1;
}

const MAX_STANDALONE_API_KEY_BYTES = 65_536;

function apiKeyInputProblem(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return "API key is required.";
  if (normalized.includes("\0") || /[\r\n]/u.test(normalized)) return "API key must be a single non-empty line.";
  if (Buffer.byteLength(normalized, "utf8") > MAX_STANDALONE_API_KEY_BYTES) return "API key is too large.";
  return undefined;
}

/**
 * Read one explicitly redirected API key without consulting ambient provider
 * environment variables. A single trailing line ending from `echo` is accepted;
 * embedded newlines, NUL bytes, empty input, and unbounded input fail closed.
 */
export async function readApiKeyFromStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input as NodeJS.ReadableStream & AsyncIterable<string | Uint8Array>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_STANDALONE_API_KEY_BYTES + 2) throw new Error("API key input is too large.");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  const problem = apiKeyInputProblem(value);
  if (problem !== undefined) throw new Error(problem);
  return value.trim();
}

export async function resolvePiAuthPathForLogin(options: {
  readonly piAuthPath?: string;
  readonly envPath?: string;
  readonly configPath: string;
  readonly cwd?: string;
}): Promise<string> {
  // A missing config is represented by readMonoAgentConfigJson as `missing`; a
  // malformed or unreadable config throws and must remain visible to operators.
  const result = await readMonoAgentConfigJson(options.configPath);
  const configured = result.missing ? undefined : result.json.providers?.piAuthPath;
  return resolveEffectivePiAuthPath({
    cwd: options.cwd ?? dirname(resolve(options.configPath)),
    ...(nonEmptyEnv(options.piAuthPath) ? { explicitPath: options.piAuthPath } : {}),
    ...(nonEmptyEnv(options.envPath) ? { envPath: options.envPath } : {}),
    ...(nonEmptyEnv(configured) ? { configPath: configured } : {}),
  });
}

function printProviderSetupPlan(plan: ProviderSetupPlan): void {
  for (const action of plan.actions) {
    process.stdout.write(
      `  ${action.label}: ${providerSetupActionCommandLine(action)} ${ui.style.dim(`(cwd: ${action.cwd})`)}\n`,
    );
  }
}

/**
 * Resolve the preset id for `init`: `--preset` wins, `--recipe` is a deprecated
 * alias mapped to the preset that replaced it. Returns the preset id to compose
 * from, `undefined` for the default scaffold, or `"unknown"` after emitting the
 * error/hint (an unknown preset, or a retired recipe with no replacement).
 */
function resolveInitPresetId(args: ParsedCliArgs): string | undefined | "unknown" {
  if (args.preset !== undefined) {
    const preset = findPreset(args.preset);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Unknown preset \`${args.preset}\`.`));
      process.stderr.write(ui.hint(`Available presets: ${presetIds().join(", ")}. Run \`mono-agent presets list\`.`));
      return "unknown";
    }
    return preset.id;
  }
  if (args.recipe !== undefined) {
    const preset = RECIPE_TO_PRESET.get(args.recipe);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Recipe \`${args.recipe}\` was retired; the wizard composes capabilities directly.`));
      process.stderr.write(ui.hint(`Use \`mono-agent init --preset <id>\` (${presetIds().join(", ")}), or \`mono-agent init\` for the step-by-step wizard.`));
      process.stderr.write(ui.hint("See the mono-agent-composer skill and docs/playbooks for capability recipes."));
      return "unknown";
    }
    process.stderr.write(ui.hint(`--recipe is deprecated; using preset ${preset.id}. See \`mono-agent presets list\`.`));
    return preset.id;
  }
  return undefined;
}

function resolveWithChannels(args: ParsedCliArgs): readonly WithChannel[] | undefined | "invalid" {
  if (args.withChannels === undefined) {
    return undefined;
  }
  const invalid = args.withChannels.filter((channel) => !isWithChannel(channel));
  if (invalid.length > 0) {
    process.stderr.write(ui.errorLine(`Unknown --with channel(s): ${invalid.join(", ")}.`));
    process.stderr.write(ui.hint("Valid channels: telegram, slack, webhook, openaiApi, cron."));
    return "invalid";
  }
  return args.withChannels.filter(isWithChannel);
}

export interface InitChangeDisplayRow {
  readonly label: "created" | "updated" | "kept" | "would create" | "would update";
  readonly path: string;
  readonly unchanged: boolean;
}

/** Safe reporting rows: paths and outcomes only, never secret contents. */
export function initChangeDisplayRows(result: InitMonoAgentFolderResult): readonly InitChangeDisplayRow[] {
  const labels = {
    created: "created",
    updated: "updated",
    unchanged: "kept",
    "planned-create": "would create",
    "planned-update": "would update",
  } as const;
  return result.changes.map((change) => ({
    label: labels[change.kind],
    path: change.path,
    unchanged: change.kind === "unchanged",
  }));
}

export interface SecretChecklistDisplayRow {
  readonly envVar: string;
  readonly label: string;
  readonly description: string;
  readonly status: "configured" | "missing" | "optional";
}

export function secretChecklistDisplayRows(
  secrets: readonly SecretChecklistItem[],
  configured: ReadonlySet<string>,
): readonly SecretChecklistDisplayRow[] {
  return secrets.map((secret) => ({
    envVar: secret.envVar,
    label: secret.label,
    description: secret.description,
    status: configured.has(secret.envVar) ? "configured" : secret.required ? "missing" : "optional",
  }));
}

function printInitResult(result: InitMonoAgentFolderResult): void {
  if (result.dryRun) {
    process.stdout.write(ui.style.dim("Dry run — nothing was written.\n"));
  }
  for (const row of initChangeDisplayRows(result)) {
    const prefix = row.unchanged ? "  " : ui.badge("ok");
    const rendered = row.unchanged
      ? ui.style.dim(row.label.padEnd(12))
      : ui.style.green(row.label.padEnd(12));
    // Sensitive files are safe to identify by path; their contents are never
    // included in this result or printed here.
    process.stdout.write(`${prefix}${rendered}  ${row.path}\n`);
  }
  if (result.knowledgeFiles.length > 0) {
    process.stdout.write(`\nIdentity references existing knowledge: ${ui.style.cyan(result.knowledgeFiles.join(", "))}\n`);
  }
  // Internal `provider:*` modules are auto-added for local models; they are an
  // implementation detail, not a user-facing capability, so exclude them here.
  const capabilities = result.plan.selectedModules.filter((module) => module.kind !== "provider");
  if (capabilities.length > 0) {
    process.stdout.write("\n" + ui.heading("Capabilities"));
    for (const module of capabilities) {
      process.stdout.write(`  ${ui.style.cyan(module.title)} ${ui.style.dim(`(risk: ${riskColor(module.riskLevel)})`)}\n`);
    }
  }
  if (result.secretPersistence.status === "persisted") {
    process.stdout.write("\n" + ui.style.dim(
      result.secretPersistence.changed
        ? "Required secrets were securely merged into .env (mode 0600).\n"
        : "Required secrets were already securely configured in .env.\n",
    ));
  } else if (result.secretPersistence.status === "planned") {
    process.stdout.write("\n" + ui.style.dim("Dry run: required secrets would be securely merged into .env.\n"));
  } else if (result.secretPersistence.status === "refused") {
    process.stderr.write(ui.hint(
      `Automatic secret persistence was refused${result.secretPersistence.reason === undefined ? "" : ` (${result.secretPersistence.reason})`}. No secret value was written.\n` +
      (result.secretPersistence.detail === undefined ? "" : `${result.secretPersistence.detail}\n`),
    ));
  } else if (result.plan.envExample !== undefined) {
    process.stdout.write("\n" + ui.style.dim("Use .env.example as a reference and add missing values to .env; do not overwrite an existing .env.\n"));
  }
}

function printSecretsChecklist(
  secrets: readonly SecretChecklistItem[],
  configured: ReadonlySet<string> = new Set(),
): void {
  process.stdout.write("\n" + ui.heading("Secrets checklist"));
  if (secrets.length === 0) {
    process.stdout.write(ui.style.dim("No secrets required by the selected capabilities.\n"));
    return;
  }
  process.stdout.write(ui.style.dim("Secret values are never written to config JSON and are never printed.\n"));
  for (const secret of secretChecklistDisplayRows(secrets, configured)) {
    const status = secret.status === "configured"
      ? ui.style.green(secret.status)
      : ui.style.yellow(secret.status);
    process.stdout.write(
      `  ${ui.style.bold(secret.envVar)} ${ui.style.dim(`- ${secret.label}: ${secret.description}`)} ${status}\n`,
    );
  }
}

function printNextSteps(configPath: string): void {
  process.stdout.write(
    "\n" +
      ui.heading("Next steps") +
      `  ${ui.style.bold("1.")} Edit ${configPath} ${ui.style.dim("(model, channels, skills, memory, sandbox)")}\n` +
      `  ${ui.style.bold("2.")} mono-agent validate\n` +
      `  ${ui.style.bold("3.")} mono-agent tui --local --configure\n` +
      `  ${ui.style.bold("4.")} ${process.platform === "darwin" ? "mono-agent start" : "mono-agent start --foreground"} ${ui.style.dim("(optional background/long-running service)")}\n`,
  );
}

async function runInstallSkill(args: ParsedCliArgs): Promise<number> {
  if (args.project === true) {
    try {
      if (args.update === true) {
        const result = await updateManagedProjectSkills(process.cwd());
        for (const path of result.updated) {
          process.stdout.write(`${ui.badge("ok")}${ui.style.green("updated")}  ${path}\n`);
        }
        if (result.backupDir !== undefined) {
          process.stdout.write(`${ui.badge("ok")}backup    ${result.backupDir}\n`);
        }
        if (result.updated.length === 0) process.stdout.write(`${ui.badge("ok")}project skills are current\n`);
        return 0;
      }
      const result = await checkManagedProjectSkills(process.cwd());
      for (const status of result.statuses) {
        const badge = status.status === "ready" ? ui.badge("ok") : ui.badge("error");
        process.stdout.write(`${badge}${status.name}: ${status.status} (${status.path})\n`);
      }
      if (!result.ok && args.check !== true) {
        process.stderr.write(ui.errorLine("Project skills need attention. Run `mono-agent install-skill --project --update`; modified copies require manual reconciliation."));
      }
      return result.ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  }
  let result;
  try {
    result = await installComposerSkill({
      target: args.target ?? "both",
      force: args.force,
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  for (const path of result.installed) {
    process.stdout.write(`${ui.badge("ok")}${ui.style.green("installed")}  ${path}\n`);
  }
  return 0;
}

async function runValidate(args: ParsedCliArgs): Promise<number> {
  const context = resolveValidateContext(args, process.cwd());
  const report = await validateMonoAgentFolder({
    env: process.env,
    cwd: context.cwd,
    configPath: context.configPath,
    allowFilesystemWrites: context.allowFilesystemWrites,
  });

  for (const section of report.sections) {
    process.stdout.write(formatSection(section));
  }

  const preset = resolveValidatePreset(args);
  if (preset === "unknown") {
    return 1;
  }
  if (preset !== undefined) {
    const plan = composeWizardPlan(presetAnswers(preset), {
      dirBasename: basename(context.cwd),
      skillsRootExists: false,
    });
    process.stdout.write(renderPlanCompleteness(plan.validateExpectations, `Preset: ${preset.id}`, report));
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
function renderPlanCompleteness(
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

function riskColor(risk: WizardPreset["riskLevel"]): string {
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
function runPresets(args: ParsedCliArgs): number {
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
async function runConfig(args: ParsedCliArgs): Promise<number> {
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
function formatSection(section: ValidationSection): string {
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

/**
 * Outcome of the start/restart preflight. `code` is the process exit status to
 * return when refusing: 2 for a missing config file (a usage problem, matching
 * the arg-parse convention) and 1 for a config that loads but has errors.
 */
export type PreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 2; readonly kind: "missing-config"; readonly configPath: string }
  | { readonly ok: false; readonly code: 1; readonly kind: "validation"; readonly report: ValidationReport };

type PreflightFailure = Extract<PreflightResult, { ok: false }>;

/**
 * Gate for `start`/`restart`: refuse unless the directory has a present, valid
 * config. First the config FILE must exist (env vars alone are not enough — a
 * folder without a config is not a configured agent). Then run the structural
 * validation with `liveness:false` (network probes only yield `waiting`, never
 * `error`, so skipping them keeps the verdict but avoids ~6s of timeouts) and
 * refuse on any `error` section. `waiting` (e.g. Ollama/Phoenix not up yet) is
 * runtime-soft and never blocks.
 */
export async function ensureStartable(
  args: ParsedCliArgs,
  env: Record<string, string | undefined> = process.env,
): Promise<PreflightResult> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, args.configPath ?? "mono-agent.config.json");
  if (!(await pathExists(configPath))) {
    return { ok: false, code: 2, kind: "missing-config", configPath };
  }
  const report = await validateMonoAgentFolder({ env, cwd, configPath, liveness: false });
  if (!report.ok) {
    return { ok: false, code: 1, kind: "validation", report };
  }
  return { ok: true };
}

function printPreflightFailure(result: PreflightFailure): void {
  if (result.kind === "missing-config") {
    process.stderr.write(ui.errorLine(`No mono-agent config found at ${result.configPath}.`));
    process.stderr.write(ui.hint("Run `mono-agent init` to scaffold one, or pass --config <path>."));
    return;
  }
  process.stderr.write(ui.heading("Cannot start: config has errors"));
  for (const section of result.report.sections) {
    if (section.status === "error") {
      process.stderr.write(formatSection(section));
    }
  }
  process.stderr.write(ui.hint("Run `mono-agent validate` for the full report, fix the errors, then retry."));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runStart(
  args: ParsedCliArgs,
  env?: Record<string, string | undefined>,
): Promise<number> {
  if (args.foreground) {
    return await runForeground(args, env);
  }
  return await runBackgroundCommand(args, "start", env);
}

/**
 * The blocking worker: builds the responder, starts every configured channel
 * plus traceability, and stays alive until a signal. This is what launchd
 * invokes (via `start --foreground`) and what users get with `--foreground`/`-f`.
 */
async function runForeground(
  args: ParsedCliArgs,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const pre = await ensureStartable(args, env);
  if (!pre.ok) {
    printPreflightFailure(pre);
    return pre.code;
  }

  const app = await startMonoAgentApp({
    cwd: process.cwd(),
    env,
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    logger: consoleLogger(),
  });

  await printAppStatus(app);
  // Block until a shutdown signal. Returning here (the old behavior) let the
  // process exit immediately whenever no channel owned a live handle — e.g. a
  // traceability-only config, now that the operator console is retired and the
  // trace heartbeat timer is unref'd.
  return await waitForShutdownSignal(app);
}

async function runBackgroundCommand(
  args: ParsedCliArgs,
  command: (typeof BACKGROUND_COMMANDS)[number],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const guard = requireDarwin(command);
  if (guard !== undefined) {
    return guard;
  }

  // Refuse to launch (or relaunch) an unconfigured/broken folder BEFORE writing
  // the plist and bootstrapping launchctl — otherwise the worker would crash and
  // launchd's KeepAlive would retry it forever. stop/status/logs stay ungated so
  // a broken instance can still be inspected and torn down.
  if (command === "start" || command === "restart") {
    const pre = await ensureStartable(args, env);
    if (!pre.ok) {
      printPreflightFailure(pre);
      return pre.code;
    }
  }

  const target = await resolveInstanceTarget({
    args: {
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
    },
    env,
    cwd: process.cwd(),
    cliPath: fileURLToPath(import.meta.url),
  });
  const deps = defaultBackgroundDeps();

  switch (command) {
    case "start":
      return await startBackground(target, deps);
    case "restart":
      return args.force ? await runForceRestart(target, deps) : await restartBackground(target, deps);
    case "stop":
      return await stopBackground(target, deps);
    case "status":
      return await statusBackground(target, deps);
    case "logs":
      return await tailLogs(target, deps, { follow: args.follow, lines: args.lines ?? DEFAULT_LOG_LINES });
  }
}

/**
 * `restart --force`: stop the worker, purge its persisted pi-session store, then
 * start fresh. Stopping first guarantees the worker is not writing sessions while
 * they are deleted; the runtime recreates the store on the next session, and the
 * agent's durable memory lives elsewhere, so only resumable transcripts are dropped.
 */
async function runForceRestart(target: InstanceTarget, deps: BackgroundDeps): Promise<number> {
  const stopCode = await stopBackground(target, deps);
  if (stopCode !== 0) {
    return stopCode;
  }
  const result = await purgeSessions({ env: process.env, cwd: target.cwd, configPath: target.configPath });
  if (result.removed) {
    const count = result.files === 0 ? "" : ` (${result.files} session file${result.files === 1 ? "" : "s"})`;
    process.stdout.write(`${ui.badge("ok")}${ui.style.bold("Cleared persisted sessions")}${count}.\n`);
  } else {
    process.stdout.write(ui.style.dim("No persisted sessions to clear (in-memory or none on disk).") + "\n");
  }
  return await startBackground(target, deps);
}

/**
 * Background service mode is launchd-specific. On other platforms point the
 * user at the still-supported blocking foreground path.
 */
function requireDarwin(command: string): number | undefined {
  if (process.platform === "darwin") {
    return undefined;
  }
  process.stderr.write(ui.errorLine(`Background service mode (mono-agent ${command}) requires macOS (launchd).`));
  process.stderr.write(ui.hint("Run `mono-agent start --foreground` to run in the foreground on this platform."));
  return 1;
}

export interface PrintAppStatusOptions {
  readonly listRecordedRuns?: typeof listRecordedRuns;
  readonly nowMs?: number;
}

export async function printAppStatus(app: MonoAgentApp, options: PrintAppStatusOptions = {}): Promise<void> {
  const trace = app.traceabilityStatus;
  process.stdout.write(ui.rule("instance"));
  process.stdout.write(
    ui.keyValue(
      [
        ["config", app.configPath],
        [
          "traceability",
          trace.kind === "running" ? `running (source ${trace.sourceId})` : `${trace.kind}: ${trace.reason}`,
        ],
      ],
      2,
    ),
  );
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  process.stdout.write(ui.rule("sandbox"));
  process.stdout.write(`  ${describeSandboxStatus(app.sandboxStatus)}\n`);
  process.stdout.write(ui.rule("observability"));
  process.stdout.write(`  ${describeExporter(app.exporterStatus, artifactDir)}\n`);
  const channels = [...app.channelStatuses()];
  if (channels.length > 0) {
    process.stdout.write(ui.rule("channels"));
    for (const [id, status] of channels) {
      process.stdout.write(`  ${ui.channelBadge(status.kind)}${ui.style.bold(id.padEnd(11))} ${describeChannelStatus(status)}\n`);
    }
  }
  await writeAppRunsHealthDetail(app, options);
}

async function writeAppRunsHealthDetail(app: MonoAgentApp, options: PrintAppStatusOptions): Promise<void> {
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  if (artifactDir === undefined || artifactDir.trim().length === 0) {
    return;
  }
  const reader = options.listRecordedRuns ?? listRecordedRuns;
  let result;
  try {
    result = await reader({ artifactDir, maxRuns: RUNS_HEALTH_MAX_RUNS, scope: "agent" });
  } catch (error) {
    result = {
      totalRuns: 0,
      runs: [],
      warnings: [`Unable to read run summaries: ${reasonOf(error)}`],
    };
  }
  const display = buildRunsHealthDisplay({
    artifactDir,
    totalRuns: result.totalRuns,
    runs: result.runs,
    warnings: result.warnings,
    includeSelectedSkills: true,
    runOwnerAlive: true,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    ...(app.selectedSkills === undefined ? {} : { selectedSkills: app.selectedSkills }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  process.stdout.write(ui.rule("runs health"));
  for (const detail of display.details) {
    process.stdout.write(`  ${detail}\n`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExporter(status: ExporterStatus, artifactDir: string | undefined): string {
  if (status.kind !== "configured") {
    return `${status.kind}: ${status.reason}`;
  }
  const parts = [`phoenix ${status.endpoint}`];
  const appUrl = phoenixAppBaseUrl(status.endpoint);
  if (appUrl !== undefined) {
    parts.push(`app ${appUrl}`);
  }
  if (status.includeSensitiveData) {
    parts.push(ui.style.yellow(describeSensitiveDataExportWarning(status.endpoint)));
  }
  if (status.lastWarning !== undefined) {
    parts.push(`last warning: ${status.lastWarning}`);
  }
  if (status.lastError !== undefined) {
    parts.push(`last error: ${status.lastError}`);
  }
  parts.push(artifactDir === undefined
    ? "JSONL artifacts remain local"
    : `JSONL artifacts remain local at ${artifactDir}`);
  return parts.join("; ");
}

function describeSandboxStatus(status: SandboxStatus): string {
  const engineAvailability = status.engineAvailable === true
    ? "present"
    : status.engineAvailable === false
      ? "absent"
      : "not checked";
  const parts = [
    `effective: ${status.effective}`,
    `engine: ${status.engine ?? "none"} (${engineAvailability})`,
    ...(status.fallback === undefined ? [] : [`fallback: ${status.fallback}`]),
    `fallback active: ${status.fallbackActive ? "yes" : "no"}`,
    status.detail,
  ];
  const warning = status.warning ?? sandboxEffectiveStateWarning(status);
  if (warning !== undefined) {
    parts.push(ui.style.yellow(warning));
  }
  return parts.join("; ");
}

export function describeChannelStatus(status: ChannelStatus): string {
  if (status.kind === "running") {
    const facts = Object.entries(status.summary)
      .map(([key, value]) => `${key}=${formatChannelFactValue(value)}`)
      .join(" ");
    return facts.length === 0 ? "running" : `running (${facts})`;
  }
  return `${status.kind}: ${status.reason}`;
}

/**
 * Block the foreground process until SIGINT/SIGTERM, then stop the app and
 * resolve the exit code. A referenced no-op timer owns the event loop so the
 * process stays alive even with no channel handle (signal listeners alone do
 * NOT keep Node running, and the trace heartbeat is unref'd). Cleared on stop so
 * the loop drains cleanly without a forceful `process.exit`. Exported for tests.
 */
export function waitForShutdownSignal(app: Pick<MonoAgentApp, "stop">): Promise<number> {
  return new Promise<number>((resolve) => {
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      clearInterval(keepAlive);
      void (async () => {
        process.stdout.write("\n" + ui.hint(`Received ${signal}; stopping mono agent app…`));
        await app.stop();
        resolve(0);
      })();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function consoleLogger() {
  return {
    info(message: string, metadata?: Record<string, unknown>) {
      process.stdout.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
    warn(message: string, metadata?: Record<string, unknown>) {
      process.stderr.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
    error(message: string, metadata?: Record<string, unknown>) {
      process.stderr.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
  };
}

const cliEntryName = process.argv[1] === undefined ? undefined : basename(process.argv[1]);
const isDirectCliInvocation = cliEntryName === "cli.js" || cliEntryName === "mono-agent";
if (isDirectCliInvocation) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${ui.style.red("✗")} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildMonoAgentConfigView,
  EFFORT_LEVELS,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type { ConfigViewSection } from "@mono-agent/config";
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
import { runInitWizard, runModelRepairWizard } from "./wizard/run.js";
import {
  executeProviderSetupPlan,
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
  providerSetupActionCommandLine,
} from "./provider-setup.js";
import type { ProviderSetupPlan, ProviderSetupResult } from "./provider-setup.js";
import { readinessProbeTimeoutMs, runReadinessProbe } from "./readiness-probe.js";
import type { ReadinessProbeResult } from "./readiness-probe.js";
import * as p from "@clack/prompts";
import * as ui from "./ui.js";

const DEFAULT_LOG_LINES = 200;
// Node's maximum setInterval/setTimeout delay (2^31 - 1 ms, ~24.8 days). A
// referenced timer at this delay keeps the foreground event loop alive without
// busy-waiting; larger values silently overflow to a 1ms delay.
const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;
const BACKGROUND_COMMANDS = ["start", "restart", "stop", "status", "logs"] as const;
const KNOWN_COMMANDS = ["init", "setup", "validate", "doctor", "auth", "config", "recipes", "presets", "start", "restart", "stop", "status", "logs", "tui", "web", "install-skill", "backfill", "audit-runs", "metrics", "memory"] as const;

type ReadinessProbeFailure = Extract<ReadinessProbeResult, { readonly ok: false }>;

// `doctor`/`setup`/`recipes` never reach routing: parseCliArgs normalizes them to
// `validate`/`init`/`presets`. `help`/`version` are synthetic commands (not in
// KNOWN_COMMANDS) produced by the `--help`/`-h` and `--version`/`-v` flags before
// command validation.
type CliCommand = Exclude<(typeof KNOWN_COMMANDS)[number], "doctor" | "setup" | "recipes"> | "help" | "version";

interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly configPath?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
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
  /** web: `--max-runs` caps the per-instance in-memory working set (default 200). */
  readonly maxRunsPerInstance?: number;
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
  let model: string | undefined;
  let fallbackModels: readonly string[] | undefined;
  let effort: string | undefined;
  let memory: "lite" | "journal" | "bujo" | undefined;
  let preset: string | undefined;
  let recipe: string | undefined;
  let withChannels: readonly string[] | undefined;
  let yes = false;
  let auth = false;
  let piAuthPath: string | undefined;
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
  let staleAfterMs: number | undefined;
  let json = false;
  let limit: number | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let open: boolean | undefined;
  let allowNonLoopback: boolean | undefined;
  let maxRunsPerInstance: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
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
      case "--fallback-models":
        fallbackModels = requireValue(rest, ++i, flag)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        break;
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

  if (
    (host !== undefined || port !== undefined || open !== undefined || allowNonLoopback !== undefined || maxRunsPerInstance !== undefined) &&
    cmd !== "web"
  ) {
    throw new Error("--host, --port, --no-open, --allow-non-loopback, and --max-runs are only supported for `mono-agent web`.");
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

  return {
    command: cmd,
    ...(configPath === undefined ? {} : { configPath }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(effort === undefined ? {} : { effort }),
    ...(memory === undefined ? {} : { memory }),
    ...(preset === undefined ? {} : { preset }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(yes ? { yes } : {}),
    ...(auth ? { auth } : {}),
    ...(piAuthPath === undefined ? {} : { piAuthPath }),
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
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(open === undefined ? {} : { open }),
    ...(allowNonLoopback === undefined ? {} : { allowNonLoopback }),
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
      "                [--model <ref>] [--fallback-models <csv>] [--effort <level>]\n" +
      "                [--memory lite|journal|bujo]",
    lines: [
      "Scaffold a mono-agent in the current folder. On a TTY with no flags, launches",
      "the step-by-step wizard; with --yes or any flag, writes the default/preset",
      "scaffold non-interactively. --preset seeds a blueprint, --with adds channels,",
      "--effort writes runtime.effort, --auth runs supported provider auth/preflight",
      "commands before writing, and --dry-run previews only. Existing scaffold/config files are not overwritten;",
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
    signature: "mono-agent auth login <provider> [--pi-auth-path <path>] [--config <path>]",
    lines: [
      "Run bundled Pi OAuth login and promote validated credentials with owner-only no-clobber checks.",
      "Path precedence: --pi-auth-path, MONO_AGENT_PI_AUTH_PATH, providers.piAuthPath, then Pi's default.",
      "Supported OAuth providers: openai-codex, anthropic, and github-copilot.",
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
    signature: "mono-agent tui [--agent <label|sourceId>] [--conversation <id>]",
    lines: [
      "Open the operator console from any directory: live chat with full",
      "thinking/tool/telemetry insight, recorded-run replay, and config view.",
      "Discovers running agents via the trace-source registry; one running",
      "agent connects directly, several open a picker.",
    ],
  },
  {
    signature: "mono-agent web [--host <addr>] [--port <n>] [--no-open] [--allow-non-loopback] [--include-memory] [--max-runs <n>]",
    lines: [
      "Serve the read-only Session Recorder web PWA from any directory: a live",
      "flight-recorder over every agent's runs (prompt, reasoning, tools, cost).",
      "Discovers running agents via the trace-source registry — the same",
      "mechanism as `tui` — and streams new/updated runs in real time.",
      "--include-memory also shows memory-maintenance runs. --max-runs (default",
      "200) bounds the in-memory working set; the UI still pages the full",
      "on-disk history via \"Load older\".",
    ],
  },
  {
    signature: "mono-agent install-skill [--target claude|codex|both] [--force]",
    lines: [
      "Copy the bundled mono-agent-composer skill into ~/.claude/skills and",
      "~/.agents/skills (default: both). Refuses to overwrite without --force.",
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
      "mono-agent memory [stats|today|show <date>|search <query>|top]\n" +
      "                  [--limit <n>] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Preview the configured memory store from an agent folder. Reads the",
      "memory block from mono-agent.config.json, not the standalone memory-bujo",
      "env workflow. Human-first output by default; --json is for scripts.",
    ],
  },
];

const HELP_NOTES = `Background mode runs the agent under launchd, keeping it alive across logins
(auto-restarting only on crash) until you run stop. Secrets are read from the
.env file in the working directory, the same as foreground mode. The background
commands require macOS; elsewhere use start --foreground.

Init model references look like pi:<provider>:<model>, claude:claude-sonnet-4-6,
codex:gpt-5.6-terra, or opencode:<provider>:<model>. The init wizard defaults to
direct codex:gpt-5.6-terra; pi:openai-codex:gpt-5.6-terra remains selectable when
Pi auth setup is needed, and the wizard can save OPENCODE_API_KEY for
pi:opencode-go:* refs. Claude remains selectable; direct opencode:<provider>:<model> refs are for
hand-authored runtime backend config and are rejected by guided selection/readiness.

Direct codex:* runs use Codex's network-off workspace sandbox, deny unattended
escalations, and require exact allow-all tool policy. Direct Codex cannot share a
fallback chain or per-turn override boundary with Pi/Claude runtimes; validate
reports those combinations before start.

Native mono-agent srt policy is enforced by Pi-owned tools. Claude's provider-owned
tool loop and direct OpenCode cannot project those exact roots, deny-write globs,
or network rules, so those primary/fallback/trigger routes are rejected while that
sandbox is active. Direct OpenCode also requires exact allow-all tool policy.
Its bridge cannot enforce an explicit runtime.effort; omit effort and
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
    const moduleSecrets = { ...initial.moduleSecrets };
    let providerSetupSecrets = { ...initial.providerSetupSecrets };
    let pendingProviderSetup = initial.runProviderSetup;

    firstRun: for (;;) {
      let dotenvSnapshot: CliDotenvSnapshot = { env: {}, fingerprint: "unreadable" };
      let failure: ReadinessProbeResult | undefined;
      try {
        dotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
      } catch {
        failure = dotenvReadinessFailure("The persisted .env could not be read safely. Fix it before retrying setup.");
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
        enteredSecrets: moduleSecrets,
        resolvedPiAuthPath,
      });
      // Re-submit every selected durable value, not only values typed during this
      // wizard session. That lets the secure merge tighten an existing .env to
      // 0600 while preserving its non-empty operator-owned values verbatim.
      const selectedSecrets = selectedSecretValues(plan, effectiveEnv);
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
        const setup = await runProviderSetupBeforeInit({
          modelRefs: referencedSetupModelRefs(plan),
          cwd,
          auth: true,
          dryRun: false,
          piAuthPath: resolvedPiAuthPath,
          apiKeys: providerSetupSecrets,
        });
        if (setup === "failed") {
          failure = {
            ok: false,
            kind: "provider_failed",
            message: "Provider setup did not complete. No agent files were written.",
          };
        }
      }

      if (failure === undefined) {
        failure = await runReadinessProbeWithSpinner({
          plan,
          effectiveEnv,
          resolvedPiAuthPath,
        });
      }

      readyAttempt: if (failure.ok) {
        const stagedGate = await assessPrewriteFirstRunReadiness({
          cwd,
          answers,
          plan,
          env: effectiveEnv,
          secretValues: selectedSecrets,
          secureExistingDotenv,
        });
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
              verifiedCredentialModelRefs: [answers.model],
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
            ui.badge("ok") + ui.style.green("Primary model check passed — a real no-tool response succeeded.\n") +
            ui.badge("ok") + ui.style.green("Agent ready — every selected capability passed full validation.\n"),
          );
          const startNow = await p.confirm({
            message: process.platform === "darwin"
              ? "Start this ready agent now as a background service?"
              : "Start this ready agent now in the foreground? (it will remain attached to this terminal)",
            initialValue: true,
          });
          if (!p.isCancel(startNow) && startNow) {
            const preStartConfigDrift = await firstRunConfigDrift(
              result.configPath,
              committedConfigSnapshot,
            );
            if (preStartConfigDrift !== undefined) {
              printIncompleteSetup([preStartConfigDrift.message], result.configPath);
              return 1;
            }
            const preStartDrift = await firstRunDotenvDrift(
              environment.dotenvPath,
              committedDotenvSnapshot,
            );
            if (preStartDrift !== undefined) {
              printIncompleteSetup([preStartDrift.message], result.configPath);
              return 1;
            }
            const preStartSecretGuard = await firstRunSecretEnvGuardFailure(
              environment.dotenvPath,
              result.secretPersistence.status === "persisted",
            );
            if (preStartSecretGuard !== undefined) {
              printIncompleteSetup([preStartSecretGuard.message], result.configPath);
              return 1;
            }
            return await withExactProcessEnvironment(
              postWriteEnv,
              () => runStart(
                { ...args, foreground: process.platform !== "darwin" },
                postWriteEnv,
              ),
            );
          }
          printNextSteps(result.configPath);
          return 0;
        }
        failure = {
          ok: false,
          kind: "invalid_plan",
          message: `Primary model check passed, but the complete agent is not ready: ${stagedGate.reasons.join(" ")}`,
        };
      }

      if (failure.ok) throw new Error("First-run recovery reached without a failure.");
      let recoveryFailure: ReadinessProbeFailure = failure;
      recoveryMenu: for (;;) {
        p.log.error(`[${recoveryFailure.kind}] ${recoveryFailure.message}`);
        const recovery = await selectFirstRunRecovery();
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
        if (recovery === "model") {
          const repaired = await runModelRepairWizard({ cwd, answers, piAuthPath: resolvedPiAuthPath });
          if (repaired.status === "cancelled") return 1;
          answers = repaired.answers;
          providerSetupSecrets = { ...providerSetupSecrets, ...repaired.providerSetupSecrets };
          pendingProviderSetup = repaired.runProviderSetup;
          continue firstRun;
        }
        if (recovery === "auth") {
          const setupPlan = planProviderSetup({
            modelRefs: referencedSetupModelRefs(plan),
            cwd,
            piAuthPath: resolvedPiAuthPath,
          });
          const prompted = await promptProviderSetupSecrets(setupPlan, providerSetupSecrets);
          if (prompted === undefined) return 1;
          providerSetupSecrets = prompted;
          const setup = await runProviderSetupBeforeInit({
            modelRefs: referencedSetupModelRefs(plan),
            cwd,
            auth: true,
            dryRun: false,
            piAuthPath: resolvedPiAuthPath,
            apiKeys: providerSetupSecrets,
          });
          if (setup === "failed") {
            recoveryFailure = {
              ok: false,
              kind: "provider_failed",
              message: "Provider setup still needs attention. No agent files were written.",
            };
            continue recoveryMenu;
          }
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
    ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(presetId === undefined ? {} : { presetId }),
  });

  const previewPlan = composeWizardPlan(answers, {
    dirBasename: basename(process.cwd()),
    skillsRootExists: await pathExists(resolve(process.cwd(), "skills")),
  });
  const setup = await runProviderSetupBeforeInit({
    modelRefs: referencedSetupModelRefs(previewPlan),
    cwd,
    auth: args.auth === true,
    dryRun: args.dryRun,
    piAuthPath: resolveEffectivePiAuthPath({
      cwd,
      ...(nonEmptyEnv(environment.shellEnv.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH }
        : nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
          ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
          : {}),
      ...(nonEmptyEnv(previewPlan.configJson.providers?.piAuthPath)
        ? { configPath: previewPlan.configJson.providers.piAuthPath }
        : {}),
    }),
  });
  if (setup === "failed") {
    return 1;
  }

  const result = await initMonoAgentFolder({ dir: cwd, answers, dryRun: args.dryRun });

  printInitResult(result);
  printSecretsChecklist(result.plan.secrets, new Set());
  printNextSteps(result.configPath);
  return 0;
}

async function assessPrewriteFirstRunReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
}): Promise<ReturnType<typeof evaluateFirstRunReadiness>> {
  try {
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: [options.answers.model],
    });
    return evaluateFirstRunReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
    });
  } catch {
    return {
      ready: false,
      reasons: ["The complete generated plan could not be validated safely in staging."],
    };
  }
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

async function runReadinessProbeWithSpinner(options: {
  readonly plan: ReturnType<typeof composeWizardPlan>;
  readonly effectiveEnv: Record<string, string | undefined>;
  readonly resolvedPiAuthPath: string;
}): Promise<ReadinessProbeResult> {
  const model = parseMonoRuntimeModelReference(options.plan.configJson.runtime?.model ?? "");
  const timeoutMs = readinessProbeTimeoutMs(model);
  const seconds = Math.ceil(timeoutMs / 1_000);
  const providerClass = timeoutMs > 90_000 ? "local model" : "cloud model";
  const controller = new AbortController();
  const spinner = p.spinner({
    cancelMessage: "Primary model check cancelled.",
    onCancel: () => controller.abort(),
  });
  spinner.start(`Checking the primary ${providerClass} with a real no-tool turn (up to ${seconds}s; Ctrl-C cancels)…`);
  try {
    const result = await runReadinessProbe({
      plan: options.plan,
      hostEnv: options.effectiveEnv,
      secretValues: selectedSecretValues(options.plan, options.effectiveEnv),
      resolvedPiAuthPath: options.resolvedPiAuthPath,
      timeoutMs,
      abortSignal: controller.signal,
    });
    if (!result.ok && result.kind === "cancelled") {
      if (!spinner.isCancelled) spinner.cancel("Primary model check cancelled.");
      return result;
    }
    if (result.ok) {
      spinner.stop("Primary model check completed.");
    } else {
      spinner.error("Primary model check needs attention.");
    }
    return result;
  } catch {
    if (controller.signal.aborted) {
      if (!spinner.isCancelled) spinner.cancel("Primary model check cancelled.");
      return {
        ok: false,
        kind: "cancelled",
        message: "The primary-model check was cancelled before completion.",
      };
    }
    spinner.error("Primary model check failed.");
    return {
      ok: false,
      kind: "probe_failed",
      message: "The primary model check could not run. Review provider authentication and retry.",
    };
  }
}

type FirstRunRecovery = "retry" | "auth" | "model" | "save" | "cancel";

async function selectFirstRunRecovery(): Promise<FirstRunRecovery> {
  const recovery = await p.select({
    message: "How would you like to recover?",
    options: [
      { value: "retry", label: "Retry model check", hint: "does not rerun authentication" },
      { value: "auth", label: "Repair authentication" },
      { value: "model", label: "Change model", hint: "keeps your channels, tools, memory and secrets" },
      { value: "save", label: "Save incomplete", hint: "does not call the agent ready or start it" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function promptProviderSetupSecrets(
  plan: ProviderSetupPlan,
  existing: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
  const values = { ...existing };
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action)) continue;
    const answer = await p.password({
      message: `Replace ${action.label} (${action.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
      clearOnError: true,
    });
    if (p.isCancel(answer)) return undefined;
    values[action.id] = answer;
  }
  return values;
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

export type InitProviderSetupStatus = "ok" | "failed" | "skipped";

export interface RunProviderSetupBeforeInitOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly auth: boolean;
  readonly dryRun: boolean;
  readonly piAuthPath?: string;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  readonly execute?: (plan: ProviderSetupPlan) => Promise<readonly ProviderSetupResult[]>;
}

export async function runProviderSetupBeforeInit(
  options: RunProviderSetupBeforeInitOptions,
): Promise<InitProviderSetupStatus> {
  const plan = planProviderSetup(options);
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
  const results = await (options.execute ?? ((setupPlan) => executeProviderSetupPlan(setupPlan, {
    ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
  })))(plan);
  for (const result of results) {
    const badge = result.status === "ok"
      ? ui.badge("ok")
      : result.status === "skipped"
        ? ui.style.dim("- ")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
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
    process.stderr.write(ui.errorLine("Usage: mono-agent auth login <provider> [--pi-auth-path <path>] [--config <path>]."));
    return 2;
  }

  const cwd = process.cwd();
  const configPath = resolve(cwd, args.configPath ?? "mono-agent.config.json");
  let configuredPiAuthPath: string;
  try {
    configuredPiAuthPath = await resolvePiAuthPathForLogin({
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
    modelRefs: [`pi:${provider}:gpt-5.6-terra`],
    cwd,
    piAuthPath: configuredPiAuthPath,
  });
  if (!plan.actions.some((action) => action.id === `pi-login:${provider}`)) {
    process.stderr.write(ui.errorLine(`Unsupported Pi OAuth provider \`${provider}\`. Use a Pi OAuth provider such as openai-codex, anthropic, or github-copilot.`));
    return 2;
  }

  process.stdout.write("\n" + ui.heading("Pi authentication"));
  printProviderSetupPlan(plan);
  const results = await executeProviderSetupPlan(plan);
  for (const result of results) {
    const badge = result.status === "ok" ? ui.badge("ok") : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  return results.every((result) => result.status === "ok") ? 0 : 1;
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
  const start = process.platform === "darwin" ? "mono-agent start" : "mono-agent start --foreground";
  process.stdout.write(
    "\n" +
      ui.heading("Next steps") +
      `  ${ui.style.bold("1.")} Edit ${configPath} ${ui.style.dim("(model, channels, skills, memory, sandbox)")}\n` +
      `  ${ui.style.bold("2.")} mono-agent validate\n` +
      `  ${ui.style.bold("3.")} ${start}\n`,
  );
}

async function runInstallSkill(args: ParsedCliArgs): Promise<number> {
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

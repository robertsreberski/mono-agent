#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type { ConfigViewSection } from "@mono-agent/config";
import { listRecordedRuns } from "@mono-agent/observability";
import {
  describeSandboxEffectiveState,
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
import { resolveChannelDrivers } from "./channels.js";
import type { ChannelStatus } from "./channels.js";
import { findUnknownAppConfigWarnings } from "./config-reference.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type { ValidationReport, ValidationSection, ValidationStatus } from "./doctor.js";
import { initMonoAgentFolder, isWithChannel } from "./init.js";
import type { WithChannel } from "./init.js";
import { installComposerSkill } from "./install-skill.js";
import type { InstallSkillTarget } from "./install-skill.js";
import { runMetrics } from "./metrics.js";
import { findRecipe, RECIPE_CATALOG, recipeIds, resolveRecipeInputs } from "./recipes/index.js";
import type { AgentRecipe } from "./recipes/index.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import { purgeSessions } from "./sessions.js";
import { collectSetupOptions } from "./setup.js";
import type { SecretChecklistItem } from "./setup.js";
import * as ui from "./ui.js";

const DEFAULT_LOG_LINES = 200;
// Node's maximum setInterval/setTimeout delay (2^31 - 1 ms, ~24.8 days). A
// referenced timer at this delay keeps the foreground event loop alive without
// busy-waiting; larger values silently overflow to a 1ms delay.
const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;
const BACKGROUND_COMMANDS = ["start", "restart", "stop", "status", "logs"] as const;
const KNOWN_COMMANDS = ["init", "setup", "validate", "doctor", "config", "recipes", "start", "restart", "stop", "status", "logs", "tui", "web", "install-skill", "backfill", "audit-runs", "metrics", "memory"] as const;

// `doctor` never reaches routing: parseCliArgs normalizes it to `validate`.
type CliCommand = Exclude<(typeof KNOWN_COMMANDS)[number], "doctor"> | "help";

interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly configPath?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly memory?: "lite" | "journal" | "bujo";
  /** init/validate: build/check against this recipe id. */
  readonly recipe?: string;
  /** init: additional channels to enable on top of the recipe/default config. */
  readonly withChannels?: readonly string[];
  /** Non-flag arguments (e.g. `recipes show <id>`). */
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
  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command \`${command}\`. Expected ${KNOWN_COMMANDS.join(", ")}.`);
  }
  // `doctor` is an alias of `validate`; normalize here so every downstream
  // validate path (env-file resolution, --consumer, routing) applies unchanged.
  const cmd = (command === "doctor" ? "validate" : command) as CliCommand;
  const isLogs = cmd === "logs";

  let configPath: string | undefined;
  let model: string | undefined;
  let fallbackModels: readonly string[] | undefined;
  let memory: "lite" | "journal" | "bujo" | undefined;
  let recipe: string | undefined;
  let withChannels: readonly string[] | undefined;
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
      case "--memory": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "lite" && raw !== "journal" && raw !== "bujo") {
          throw new Error("--memory must be lite, journal, or bujo.");
        }
        memory = raw;
        break;
      }
      case "--recipe":
        recipe = requireValue(rest, ++i, flag);
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

  return {
    command: cmd,
    ...(configPath === undefined ? {} : { configPath }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(memory === undefined ? {} : { memory }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(withChannels === undefined ? {} : { withChannels }),
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
    signature: "mono-agent init [--recipe <id>] [--with <csv>] [--dry-run]\n" +
      "                [--model <ref>] [--fallback-models <csv>] [--memory lite|journal|bujo]",
    lines: [
      "Scaffold mono-agent.config.json, IDENTITY.md, and .mono-agent/ in the",
      "current folder. With --recipe, build from a blueprint (+ .env.example);",
      "--with adds channels, --dry-run previews. Existing files are never overwritten.",
    ],
  },
  {
    signature: "mono-agent setup [--recipe <id>] [--with <csv>] [--dry-run]\n" +
      "                 [--model <ref>] [--fallback-models <csv>] [--memory lite|journal|bujo]",
    lines: [
      "Guided setup when attached to a TTY: choose a recipe, answer non-secret",
      "inputs, select channel add-ons, scaffold, validate, and print the secrets",
      "checklist. In non-TTY contexts it falls back to init-style flags.",
    ],
  },
  {
    signature: "mono-agent recipes list | show <id>",
    lines: [
      "List the executable config blueprints, or show one's generated config,",
      ".env.example, and follow-up checklist.",
    ],
  },
  {
    signature: "mono-agent validate [--recipe <id>] [--consumer <path>] [--config <path>] [--env-file <path>]",
    lines: [
      "Load every config section and report what would run, wait, or fail.",
      "--consumer validates another agent folder read-only, including its .env.",
      "With --recipe, also report whether the recipe's capabilities are live.",
      "`mono-agent doctor` is an alias for this command.",
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

Model references look like claude:claude-sonnet-4-6, codex:gpt-5.5, or
pi:<provider>:<model> (e.g. pi:ollama:gemma4:31b).

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
  loadCliEnvFile(
    args.command === "validate"
      ? resolveValidateContext(args, invocationCwd).envFilePath
      : resolve(invocationCwd, args.envFile ?? ".env"),
  );

  switch (args.command) {
    case "help":
      process.stdout.write(renderHelp());
      return 0;
    case "init":
      return await runInit(args);
    case "setup":
      return await runSetup(args);
    case "validate":
      return await runValidate(args);
    case "config":
      return await runConfig(args);
    case "recipes":
      return runRecipes(args);
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

async function runInit(args: ParsedCliArgs): Promise<number> {
  const recipe = resolveRecipeArg(args);
  if (recipe === "unknown") {
    return 1;
  }

  const withChannels = resolveWithChannels(args);
  if (withChannels === "invalid") {
    return 1;
  }

  const result = await initMonoAgentFolder({
    dir: process.cwd(),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(withChannels === undefined ? {} : { withChannels }),
    dryRun: args.dryRun,
  });

  printInitResult(result, recipe);

  printNextSteps(result.configPath, recipe);
  return 0;
}

async function runSetup(args: ParsedCliArgs): Promise<number> {
  if (process.stdin.isTTY !== true) {
    return await runInit(args);
  }

  const recipeArg = resolveRecipeArg(args);
  if (recipeArg === "unknown") {
    return 1;
  }
  const withChannelsArg = resolveWithChannels(args);
  if (withChannelsArg === "invalid") {
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let collected;
  try {
    collected = await collectSetupOptions({
      prompt: { question: (prompt) => rl.question(prompt) },
      ...(recipeArg === undefined ? {} : { recipe: recipeArg }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }),
      ...(withChannelsArg === undefined ? {} : { withChannels: withChannelsArg }),
    });
  } finally {
    rl.close();
  }

  const result = await initMonoAgentFolder({
    dir: process.cwd(),
    ...(collected.fallbackModels.length === 0 ? {} : { fallbackModels: collected.fallbackModels }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
    recipe: collected.recipe,
    recipeInputs: collected.recipeInputs,
    withChannels: collected.withChannels,
    dryRun: args.dryRun,
  });

  printInitResult(result, collected.recipe);

  if (!result.dryRun) {
    const report = await validateMonoAgentFolder({
      env: process.env,
      cwd: process.cwd(),
      configPath: result.configPath,
    });
    process.stdout.write("\n" + ui.heading("Validation"));
    for (const section of report.sections) {
      process.stdout.write(formatSection(section));
    }
    process.stdout.write(renderRecipeCompleteness(collected.recipe, report));
    printSecretsChecklist(collected.secrets);
    printNextSteps(result.configPath, collected.recipe);
    return report.ok ? 0 : 1;
  }

  printSecretsChecklist(collected.secrets);
  printNextSteps(result.configPath, collected.recipe);
  return 0;
}

function resolveRecipeArg(args: ParsedCliArgs): AgentRecipe | undefined | "unknown" {
  if (args.recipe === undefined) {
    return undefined;
  }
  const recipe = findRecipe(args.recipe);
  if (recipe === undefined) {
    process.stderr.write(ui.errorLine(`Unknown recipe \`${args.recipe}\`.`));
    process.stderr.write(ui.hint("Run `mono-agent recipes list` to see available recipes."));
    return "unknown";
  }
  return recipe;
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

function printInitResult(
  result: Awaited<ReturnType<typeof initMonoAgentFolder>>,
  recipe: AgentRecipe | undefined,
): void {
  if (result.dryRun) {
    process.stdout.write(ui.style.dim("Dry run — nothing was written.\n"));
  }
  const verb = result.dryRun ? "would create" : "created";
  for (const path of result.created) {
    process.stdout.write(`${ui.badge("ok")}${ui.style.green(verb.padEnd(12))}  ${path}\n`);
  }
  for (const path of result.skipped) {
    process.stdout.write(ui.style.dim(`  kept          ${path}`) + "\n");
  }
  if (result.knowledgeFiles.length > 0) {
    process.stdout.write(`\nIdentity references existing knowledge: ${ui.style.cyan(result.knowledgeFiles.join(", "))}\n`);
  }
  if (recipe !== undefined) {
    process.stdout.write(`\n${ui.style.bold("Recipe:")} ${ui.style.cyan(recipe.id)} ${ui.style.dim(`(risk: ${recipe.riskLevel})`)}\n`);
    if (recipe.envExample !== undefined) {
      process.stdout.write(ui.style.dim("Fill the secret placeholders in .env.example, then copy it to .env.\n"));
    }
  }
}

function printSecretsChecklist(secrets: readonly SecretChecklistItem[]): void {
  process.stdout.write("\n" + ui.heading("Secrets checklist"));
  if (secrets.length === 0) {
    process.stdout.write(ui.style.dim("No secret recipe inputs were prompted. Review .env.example if the recipe created one.\n"));
    return;
  }
  process.stdout.write(ui.style.dim("Copy .env.example to .env, then fill these variables. Secret values were not prompted or written to JSON.\n"));
  for (const secret of secrets) {
    const key = secret.envVar ?? secret.id;
    process.stdout.write(`  ${ui.style.bold(key)} ${ui.style.dim(`- ${secret.label}: ${secret.description}`)}\n`);
  }
}

function printNextSteps(configPath: string, recipe: AgentRecipe | undefined): void {
  const validateCmd = recipe === undefined ? "mono-agent validate" : `mono-agent validate --recipe ${recipe.id}`;
  process.stdout.write(
    "\n" +
      ui.heading("Next steps") +
      `  ${ui.style.bold("1.")} Edit ${configPath} ${ui.style.dim("(model, channels, skills, memory, sandbox)")}\n` +
      `  ${ui.style.bold("2.")} ${validateCmd}\n` +
      `  ${ui.style.bold("3.")} mono-agent start\n`,
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

  if (args.recipe !== undefined) {
    const recipe = findRecipe(args.recipe);
    if (recipe === undefined) {
      process.stderr.write(ui.errorLine(`Unknown recipe \`${args.recipe}\`.`));
      process.stderr.write(ui.hint("Run `mono-agent recipes list` to see available recipes."));
      return 1;
    }
    process.stdout.write(renderRecipeCompleteness(recipe, report));
  }

  process.stdout.write(
    report.ok
      ? `\n${ui.style.green("✓ Config is ready to start.")}\n${ui.style.dim("Run `mono-agent config` for the full field-by-field view.")}\n`
      : `\n${ui.hint("Fix the errors above, then re-run mono-agent validate.")}`,
  );
  process.stdout.write(
    ui.style.dim("Core sections activate by presence; channels need `enabled: true` — see docs/config (How sections activate).\n"),
  );
  return report.ok ? 0 : 1;
}

/**
 * Capability-aware recipe check: for each capability the recipe promises, report
 * whether the matching doctor section has reached the expected status. `waiting`
 * stays non-fatal (it never changes the validate exit code) but is surfaced as
 * "selected recipe incomplete" so the operator knows what is left to wire up.
 */
function renderRecipeCompleteness(recipe: AgentRecipe, report: ValidationReport): string {
  let out = "\n" + ui.heading(`Recipe: ${recipe.id}`);
  let incomplete = 0;
  for (const expectation of recipe.validateExpectations) {
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
    ? `${ui.style.green(`✓ Recipe ${recipe.id} is fully configured.`)}\n`
    : ui.style.yellow(`⚠ Selected recipe incomplete: ${incomplete} capability(ies) not yet live.\n`);
  return out;
}

function riskColor(risk: AgentRecipe["riskLevel"]): string {
  if (risk === "high") {
    return ui.style.red(risk);
  }
  if (risk === "medium") {
    return ui.style.yellow(risk);
  }
  return ui.style.green(risk);
}

/** `mono-agent recipes list` — one line per recipe. */
export function renderRecipeList(): string {
  let out = ui.banner("mono-agent", "recipes") + "\n";
  for (const recipe of RECIPE_CATALOG) {
    out += `${ui.style.bold(ui.style.cyan(recipe.id))} ${ui.style.dim(`[${riskColor(recipe.riskLevel)}]`)}\n`;
    out += `    ${recipe.title}\n`;
    out += `    ${ui.style.dim(recipe.tags.join(", "))}\n`;
  }
  out += "\n" + ui.style.dim("Scaffold one with: mono-agent init --recipe <id> [--dry-run] [--with slack,cron]\n");
  return out;
}

/** `mono-agent recipes show <id>` — description, generated JSON, env example, checklist. */
export function renderRecipeShow(recipe: AgentRecipe): string {
  const inputs = resolveRecipeInputs(recipe);
  let out = ui.banner("mono-agent", `recipe: ${recipe.id}`) + "\n";
  out += `${ui.style.bold(recipe.title)} ${ui.style.dim(`(risk: ${riskColor(recipe.riskLevel)})`)}\n`;
  out += `${recipe.description}\n`;
  if (recipe.playbook !== undefined) {
    out += ui.style.dim(`Playbook: docs/playbooks/${recipe.playbook}\n`);
  }
  out += "\n" + ui.heading("Generated mono-agent.config.json");
  out += JSON.stringify(recipe.config(inputs), null, 2) + "\n";

  const envExample = recipe.envExample?.(inputs);
  if (envExample !== undefined && envExample.trim().length > 0) {
    out += "\n" + ui.heading(".env.example");
    out += envExample.endsWith("\n") ? envExample : envExample + "\n";
  }

  const files = recipe.files?.(inputs) ?? [];
  if (files.length > 0) {
    out += "\n" + ui.heading("Scaffolded files");
    for (const file of files) {
      out += `  ${ui.style.cyan(file.path)}\n`;
    }
  }

  if (recipe.validateExpectations.length > 0) {
    out += "\n" + ui.heading("Follow-up checklist");
    for (const expectation of recipe.validateExpectations) {
      const note = expectation.note === undefined ? "" : ` — ${expectation.note}`;
      out += `  ${ui.style.gray("•")} ${expectation.sectionId} ${ui.style.dim(`must be ${expectation.mustBe}`)}${ui.style.dim(note)}\n`;
    }
  }
  return out;
}

/** Dispatch `mono-agent recipes list|show <id>`. */
function runRecipes(args: ParsedCliArgs): number {
  const [sub, id] = args.positionals;
  if (sub === undefined || sub === "list") {
    process.stdout.write(renderRecipeList());
    return 0;
  }
  if (sub === "show") {
    if (id === undefined) {
      process.stderr.write(ui.errorLine("Usage: mono-agent recipes show <id>."));
      process.stderr.write(ui.hint(`Available: ${recipeIds().join(", ")}.`));
      return 2;
    }
    const recipe = findRecipe(id);
    if (recipe === undefined) {
      process.stderr.write(ui.errorLine(`Unknown recipe \`${id}\`.`));
      process.stderr.write(ui.hint("Run `mono-agent recipes list` to see available recipes."));
      return 1;
    }
    process.stdout.write(renderRecipeShow(recipe));
    return 0;
  }
  process.stderr.write(ui.errorLine(`Unknown recipes subcommand \`${sub}\`. Expected list or show.`));
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
export async function ensureStartable(args: ParsedCliArgs): Promise<PreflightResult> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, args.configPath ?? "mono-agent.config.json");
  if (!(await pathExists(configPath))) {
    return { ok: false, code: 2, kind: "missing-config", configPath };
  }
  const report = await validateMonoAgentFolder({ env: process.env, cwd, configPath, liveness: false });
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

async function runStart(args: ParsedCliArgs): Promise<number> {
  if (args.foreground) {
    return await runForeground(args);
  }
  return await runBackgroundCommand(args, "start");
}

/**
 * The blocking worker: builds the responder, starts every configured channel
 * plus traceability, and stays alive until a signal. This is what launchd
 * invokes (via `start --foreground`) and what users get with `--foreground`/`-f`.
 */
async function runForeground(args: ParsedCliArgs): Promise<number> {
  const pre = await ensureStartable(args);
  if (!pre.ok) {
    printPreflightFailure(pre);
    return pre.code;
  }

  const app = await startMonoAgentApp({
    cwd: process.cwd(),
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
    const pre = await ensureStartable(args);
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
    env: process.env,
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

function describeChannelStatus(status: ChannelStatus): string {
  if (status.kind === "running") {
    const facts = Object.entries(status.summary)
      .map(([key, value]) => `${key}=${String(value)}`)
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

#!/usr/bin/env node
import { basename, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startMonoAgentApp } from "./app.js";
import type { ExporterStatus, MonoAgentApp } from "./app.js";
import { phoenixAppBaseUrl } from "./app-config.js";
import {
  defaultBackgroundDeps,
  resolveInstanceTarget,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "./background.js";
import type { ChannelStatus } from "./channels.js";
import { validateMonoAgentFolder } from "./doctor.js";
import { initMonoAgentFolder } from "./init.js";
import { installComposerSkill } from "./install-skill.js";
import type { InstallSkillTarget } from "./install-skill.js";

const DEFAULT_LOG_LINES = 200;
const BACKGROUND_COMMANDS = ["start", "restart", "stop", "status", "logs"] as const;
const KNOWN_COMMANDS = ["init", "validate", "start", "restart", "stop", "status", "logs", "install-skill"] as const;

type CliCommand = (typeof KNOWN_COMMANDS)[number] | "help";

interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly configPath?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly memory?: "lite" | "journal" | "bujo";
  readonly envFile?: string;
  readonly target?: InstallSkillTarget;
  readonly force: boolean;
  /** start: run the blocking foreground worker instead of backgrounding. */
  readonly foreground: boolean;
  /** logs: keep streaming new output (tail -F). */
  readonly follow: boolean;
  /** logs: number of trailing lines to print. */
  readonly lines?: number;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", force: false, foreground: false, follow: false };
  }
  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command \`${command}\`. Expected ${KNOWN_COMMANDS.join(", ")}.`);
  }
  const cmd = command as CliCommand;
  const isLogs = cmd === "logs";

  let configPath: string | undefined;
  let model: string | undefined;
  let fallbackModels: readonly string[] | undefined;
  let memory: "lite" | "journal" | "bujo" | undefined;
  let envFile: string | undefined;
  let target: InstallSkillTarget | undefined;
  let force = false;
  let foreground = false;
  let follow = false;
  let lines: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    switch (flag) {
      case "--config":
        configPath = requireValue(rest, ++i, flag);
        break;
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
        throw new Error(`Unknown flag \`${flag}\` for \`mono-agent ${command}\`.`);
    }
  }

  return {
    command: cmd,
    ...(configPath === undefined ? {} : { configPath }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(memory === undefined ? {} : { memory }),
    ...(envFile === undefined ? {} : { envFile }),
    ...(target === undefined ? {} : { target }),
    force,
    foreground,
    follow,
    ...(lines === undefined ? {} : { lines }),
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

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
}

const HELP_TEXT = `mono-agent — config-first agent host

Usage:
  mono-agent init [--model <ref>] [--fallback-models <csv>] [--memory lite|journal|bujo]
      Scaffold mono-agent.config.json, IDENTITY.md, and .mono-agent/ in the
      current folder. Existing files are never overwritten.

  mono-agent validate [--config <path>] [--env-file <path>]
      Load every config section and report what would run, wait, or fail.

  mono-agent start [--config <path>] [--env-file <path>] [--foreground|-f]
      Start the agent as a background macOS service (launchd), print its
      instance info, and return. Re-running restarts the running instance.
      Use --foreground (-f) to run in the blocking foreground instead.

  mono-agent restart [--config <path>]
      Restart the background instance for this config (starts it if stopped).

  mono-agent stop [--config <path>]
      Stop the background instance and remove its LaunchAgent.

  mono-agent status [--config <path>]
      Show this config's instance plus any other running instances.

  mono-agent logs [--config <path>] [--follow|-f] [--lines <n>]
      Print (and optionally follow) the background instance's log files.

  mono-agent install-skill [--target claude|codex|both] [--force]
      Copy the bundled mono-agent-composer skill into ~/.claude/skills and
      ~/.codex/skills (default: both). Refuses to overwrite without --force.

Background mode runs the agent under launchd, keeping it alive across logins
(auto-restarting only on crash) until you run stop. Secrets are read from the
.env file in the working directory, the same as foreground mode. The background
commands require macOS; elsewhere use start --foreground.

Model references look like claude:claude-sonnet-4-6, codex:gpt-5.5, or
pi:<provider>:<model> (e.g. pi:ollama:gemma4:31b).

A .env file in the current folder is loaded automatically when present;
already-exported shell variables take precedence.
`;

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP_TEXT}`);
    return 2;
  }

  loadCliEnvFile(resolve(process.cwd(), args.envFile ?? ".env"));

  switch (args.command) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return 0;
    case "init":
      return await runInit(args);
    case "validate":
      return await runValidate(args);
    case "start":
      return await runStart(args);
    case "restart":
    case "stop":
    case "status":
    case "logs":
      return await runBackgroundCommand(args, args.command);
    case "install-skill":
      return await runInstallSkill(args);
  }
}

async function runInit(args: ParsedCliArgs): Promise<number> {
  const result = await initMonoAgentFolder({
    dir: process.cwd(),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
  });

  for (const path of result.created) {
    process.stdout.write(`created  ${path}\n`);
  }
  for (const path of result.skipped) {
    process.stdout.write(`kept     ${path}\n`);
  }
  if (result.knowledgeFiles.length > 0) {
    process.stdout.write(`\nIdentity references existing knowledge: ${result.knowledgeFiles.join(", ")}\n`);
  }
  process.stdout.write(
    "\nNext steps:\n" +
      `  1. Edit ${result.configPath} (model, channels, skills, memory, sandbox).\n` +
      "  2. mono-agent validate\n" +
      "  3. mono-agent start\n",
  );
  return 0;
}

async function runInstallSkill(args: ParsedCliArgs): Promise<number> {
  let result;
  try {
    result = await installComposerSkill({
      target: args.target ?? "both",
      force: args.force,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const path of result.installed) {
    process.stdout.write(`installed  ${path}\n`);
  }
  return 0;
}

async function runValidate(args: ParsedCliArgs): Promise<number> {
  const cwd = process.cwd();
  const report = await validateMonoAgentFolder({
    env: process.env,
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
  });

  for (const section of report.sections) {
    process.stdout.write(`${statusIcon(section.status)} ${section.label}\n`);
    for (const detail of section.details) {
      process.stdout.write(`    ${detail}\n`);
    }
  }
  process.stdout.write(report.ok ? "\nConfig is ready to start.\n" : "\nFix the errors above, then re-run mono-agent validate.\n");
  return report.ok ? 0 : 1;
}

function statusIcon(status: "ok" | "waiting" | "disabled" | "error"): string {
  switch (status) {
    case "ok":
      return "[ok]      ";
    case "waiting":
      return "[waiting] ";
    case "disabled":
      return "[off]     ";
    case "error":
      return "[error]   ";
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
  const app = await startMonoAgentApp({
    cwd: process.cwd(),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    logger: consoleLogger(),
  });

  printAppStatus(app);
  installSignalHandlers(app);
  return 0;
}

async function runBackgroundCommand(
  args: ParsedCliArgs,
  command: (typeof BACKGROUND_COMMANDS)[number],
): Promise<number> {
  const guard = requireDarwin(command);
  if (guard !== undefined) {
    return guard;
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
      return await restartBackground(target, deps);
    case "stop":
      return await stopBackground(target, deps);
    case "status":
      return await statusBackground(target, deps);
    case "logs":
      return await tailLogs(target, deps, { follow: args.follow, lines: args.lines ?? DEFAULT_LOG_LINES });
  }
}

/**
 * Background service mode is launchd-specific. On other platforms point the
 * user at the still-supported blocking foreground path.
 */
function requireDarwin(command: string): number | undefined {
  if (process.platform === "darwin") {
    return undefined;
  }
  process.stderr.write(
    `Background service mode (mono-agent ${command}) requires macOS (launchd).\n` +
      "Run `mono-agent start --foreground` to run in the foreground on this platform.\n",
  );
  return 1;
}

export function printAppStatus(app: MonoAgentApp): void {
  process.stdout.write(`config            ${app.configPath}\n`);
  const trace = app.traceabilityStatus;
  process.stdout.write(
    trace.kind === "running"
      ? `traceability      running (source ${trace.sourceId})\n`
      : `traceability      ${trace.kind}: ${trace.reason}\n`,
  );
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  process.stdout.write(`observability     ${describeExporter(app.exporterStatus, artifactDir)}\n`);
  for (const [id, status] of app.channelStatuses()) {
    process.stdout.write(`${id.padEnd(17)} ${describeChannelStatus(status)}\n`);
  }
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
    parts.push("includeSensitiveData=true");
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

function describeChannelStatus(status: ChannelStatus): string {
  if (status.kind === "running") {
    const facts = Object.entries(status.summary)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    return facts.length === 0 ? "running" : `running (${facts})`;
  }
  return `${status.kind}: ${status.reason}`;
}

function installSignalHandlers(app: MonoAgentApp): void {
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write(`\nReceived ${signal}; stopping mono agent app...\n`);
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
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
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";

import { startMonoAgentApp } from "./app.js";
import type { MonoAgentApp } from "./app.js";
import type { ChannelStatus } from "./channels.js";
import { validateMonoAgentFolder } from "./doctor.js";
import { initMonoAgentFolder } from "./init.js";

interface ParsedCliArgs {
  readonly command: "init" | "validate" | "start" | "help";
  readonly configPath?: string;
  readonly port?: number;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly memory?: "markdown" | "journal";
  readonly noConsole: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", noConsole: false };
  }
  if (command !== "init" && command !== "validate" && command !== "start") {
    throw new Error(`Unknown command \`${command}\`. Expected init, validate, or start.`);
  }

  let configPath: string | undefined;
  let port: number | undefined;
  let model: string | undefined;
  let fallbackModels: readonly string[] | undefined;
  let memory: "markdown" | "journal" | undefined;
  let noConsole = false;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    switch (flag) {
      case "--config":
        configPath = requireValue(rest, ++i, flag);
        break;
      case "--port": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          throw new Error("--port must be an integer between 0 and 65535.");
        }
        port = parsed;
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
        if (raw !== "markdown" && raw !== "journal") {
          throw new Error("--memory must be markdown or journal.");
        }
        memory = raw;
        break;
      }
      case "--no-console":
        noConsole = true;
        break;
      default:
        throw new Error(`Unknown flag \`${flag}\` for \`mono-agent ${command}\`.`);
    }
  }

  return {
    command,
    ...(configPath === undefined ? {} : { configPath }),
    ...(port === undefined ? {} : { port }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(memory === undefined ? {} : { memory }),
    noConsole,
  };
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
  mono-agent init [--model <ref>] [--fallback-models <csv>] [--memory markdown|journal]
      Scaffold mono-agent.config.json, IDENTITY.md, and .mono-agent/ in the
      current folder. Existing files are never overwritten.

  mono-agent validate [--config <path>]
      Load every config section and report what would run, wait, or fail.

  mono-agent start [--config <path>] [--port <n>] [--no-console]
      Build the responder and start every configured channel plus the local
      operator console and traceability.

Model references look like claude:claude-sonnet-4-6, codex:gpt-5.5, or
pi:<provider>:<model> (e.g. pi:ollama:gemma4:31b).
`;

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP_TEXT}`);
    return 2;
  }

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
  const app = await startMonoAgentApp({
    cwd: process.cwd(),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    ...(args.port === undefined ? {} : { operatorConsolePort: args.port }),
    ...(args.noConsole ? { operatorConsole: false } : {}),
    logger: consoleLogger(),
  });

  printAppStatus(app);
  installSignalHandlers(app);
  return 0;
}

function printAppStatus(app: MonoAgentApp): void {
  if (app.operatorConsole !== undefined) {
    process.stdout.write(`operator console  ${app.operatorConsole.appUrl}\n`);
  }
  process.stdout.write(`config            ${app.configPath}\n`);
  const trace = app.traceabilityStatus;
  process.stdout.write(
    trace.kind === "running"
      ? `traceability      running (source ${trace.sourceId})\n`
      : `traceability      ${trace.kind}: ${trace.reason}\n`,
  );
  for (const [id, status] of app.channelStatuses()) {
    process.stdout.write(`${id.padEnd(17)} ${describeChannelStatus(status)}\n`);
  }
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

const isDirectCliInvocation = process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("mono-agent"));
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

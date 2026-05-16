#!/usr/bin/env node
import { resolve } from "node:path";

import { startFinalAgentDemo } from "./final-demo.js";
import type { TelegramStatus } from "./final-demo.js";

interface CliArgs {
  readonly configPath?: string;
  readonly port?: number;
  readonly help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const demo = await startFinalAgentDemo({
    env: process.env,
    cwd: process.cwd(),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    ...(args.port === undefined ? {} : { configUiPort: args.port }),
    logger: console,
  });

  console.log(`config-ui: ${demo.configUi.appUrl}`);
  console.log(`config:    ${demo.configUi.configPath}`);
  printTelegramStatus(demo.telegramStatus);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal} — stopping final demo`);
    try {
      await demo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  let port: number | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error("--config requires a path.");
      }
      configPath = resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new Error("--port requires a numeric port.");
      }
      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be between 0 and 65535.");
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    help,
    ...(configPath === undefined ? {} : { configPath }),
    ...(port === undefined ? {} : { port }),
  };
}

function printTelegramStatus(status: TelegramStatus): void {
  if (status.kind === "running") {
    console.log("telegram:  running");
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`telegram:  waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`telegram:  failed — ${status.reason}`);
}

function printHelp(): void {
  console.log(`Usage: pnpm run demo:final -- [--config <path>] [--port <port>]\n\nStarts the non-package Mono Agent final demo: config UI first, then Telegram once mono-agent.config.json is valid.\n\nOptions:\n  --config <path>  Config file path (default: ./mono-agent.config.json)\n  --port <port>    Config UI port (default: 0, choose a free port)\n  -h, --help       Show this help`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

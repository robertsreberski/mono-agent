#!/usr/bin/env node
import { parseCliArgs } from "./cli-args.js";
import { startFinalAgentDemo } from "./final-demo.js";
import type { A2AStatus, TelegramStatus } from "./final-demo.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const demo = await startFinalAgentDemo({
    env: process.env,
    cwd: process.cwd(),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    ...(args.port === undefined ? {} : { operatorConsolePort: args.port }),
    logger: console,
  });

  console.log(`operator-console: ${demo.operatorConsole.appUrl}`);
  console.log(`config:    ${demo.operatorConsole.configPath}`);
  printTelegramStatus(demo.telegramStatus);
  printA2AStatus(demo.a2aStatus);

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

function printA2AStatus(status: A2AStatus): void {
  if (status.kind === "running") {
    console.log(`a2a:       running — ${status.agentCardUrl}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log("a2a:       disabled");
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`a2a:       waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`a2a:       failed — ${status.reason}`);
}

function printHelp(): void {
  console.log(`Usage: pnpm run demo:final -- [--config <path>] [--port <port>]\n\nStarts the non-package Mono Agent final demo: operator console first, then optional Telegram and A2A providers once mono-agent.config.json is valid.\n\nOptions:\n  --config <path>  Config file path (default: ./mono-agent.config.json)\n  --port <port>    Operator Console port (default: 0, choose a free port)\n  -h, --help       Show this help`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

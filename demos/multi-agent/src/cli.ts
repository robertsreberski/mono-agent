#!/usr/bin/env node
import { parseMultiAgentCliArgs } from "./cli-args.js";
import { startMultiAgentDemo } from "./multi-agent-demo.js";
import type {
  MultiAgentRoleStatus,
  MultiAgentTelegramStatus,
  MultiAgentTraceabilityStatus,
} from "./multi-agent-demo.js";

async function main(): Promise<void> {
  const args = parseMultiAgentCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const demo = await startMultiAgentDemo({
    env: process.env,
    cwd: process.cwd(),
    ...(args.configDir === undefined ? {} : { configDir: args.configDir }),
    ...(args.port === undefined ? {} : { operatorConsolePort: args.port }),
    startTelegram: !args.noTelegram,
    startA2A: !args.noA2A,
    logger: console,
  });

  printDemoStatus(demo);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal}: stopping multi-agent demo`);
    try {
      await demo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

function printDemoStatus(demo: Awaited<ReturnType<typeof startMultiAgentDemo>>): void {
  console.log(`operator-console: ${demo.operatorConsole.appUrl}`);
  console.log(`operator-api:     ${demo.operatorConsole.url}`);
  console.log(`operator-token:   ${demo.operatorConsole.token}`);
  console.log(`config:           ${demo.operatorConsole.configPath}`);
  printTraceabilityStatus(demo.traceabilityStatuses.orchestrator);
  printRoleStatus(demo.orchestratorStatus);
  printRoleStatus(demo.researcherStatus);
  printRoleStatus(demo.workerStatus);
  printTelegramStatus(demo.telegramStatus);
}

function printRoleStatus(status: MultiAgentRoleStatus): void {
  if (status.kind === "running") {
    console.log(`${status.role}: ${status.agentCardUrl}`);
    return;
  }
  console.log(`${status.role}: ${status.kind} - ${status.reason}`);
}

function printTelegramStatus(status: MultiAgentTelegramStatus): void {
  if (status.kind === "running") {
    console.log(`telegram:         running (${status.allowAllChats ? "all chats" : `${status.allowedChatCount} allowed chats`})`);
    return;
  }
  console.log(`telegram:         ${status.kind} - ${status.reason}`);
}

function printTraceabilityStatus(status: MultiAgentTraceabilityStatus): void {
  if (status.kind === "running") {
    console.log(`trace-source:     ${status.sourceId}`);
    console.log(`trace-registry:   ${status.registryDir}`);
    return;
  }
  console.log(`traceability:     failed - ${status.reason}`);
}

function printHelp(): void {
  console.log(`Usage: pnpm run demo:multi -- [--config-dir <path>] [--port <port>] [--no-telegram] [--no-a2a]\n\nStarts the non-package multi-agent demo from generated role configs.\n\nOptions:\n  --config-dir <path>  Config/state directory (default: ./.mono-agent/multi-agent)\n  --port <port>        Operator Console port (default: 0, choose a free port)\n  --no-telegram        Do not start the Telegram poller even if configured\n  --no-a2a             Do not start role A2A providers\n  -h, --help           Show this help`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

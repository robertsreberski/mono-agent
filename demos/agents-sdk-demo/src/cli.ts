#!/usr/bin/env node
import { startAgentsSdkDemo } from "./agents-sdk-demo.js";

async function main(): Promise<void> {
  const demo = await startAgentsSdkDemo({
    env: process.env,
    cwd: process.cwd(),
    logger: console,
  });

  console.log("");
  console.log("=== Agents SDK Demo ===");
  for (const status of demo.statuses) {
    if (status.kind === "running") {
      console.log(`  ${status.name.padEnd(7)} → ${status.agentCardUrl} (${status.model.sdk}:${status.model.model})`);
    } else {
      console.log(`  ${status.name.padEnd(7)} → skipped (${status.reason})`);
    }
  }
  console.log("");
  console.log("Each running agent exposes its Agent Card at the URL above and accepts A2A messages.");
  console.log("Press Ctrl-C to stop.");

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping agents-sdk demo`);
    try {
      await demo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

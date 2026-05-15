#!/usr/bin/env node
import { startTelegramAgentDemo } from "./demo.js";

try {
  await startTelegramAgentDemo({ logger: console });
} catch (error) {
  console.error("Mono Agent Telegram demo failed to start.", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { startDemoBridge } from "./demo.js";

async function main(): Promise<void> {
  const bridge = await startDemoBridge();
  // eslint-disable-next-line no-console
  console.log(`config-ui: ${bridge.url}/?t=${bridge.token}`);
  // eslint-disable-next-line no-console
  console.log(`config:    ${bridge.configPath}`);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(`\n${signal} — stopping bridge`);
    try {
      await bridge.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

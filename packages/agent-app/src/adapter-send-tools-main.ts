#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  adapterSendToolsChildConfigFromEnv,
  createAdapterSendToolsClients,
  createAdapterSendToolsServer,
  resolveAdapterSendToolsSettings,
} from "./adapter-send-tools.js";

async function main(): Promise<void> {
  const childConfig = adapterSendToolsChildConfigFromEnv(process.env, process.cwd());
  const settings = await resolveAdapterSendToolsSettings(childConfig.input, {
    allowedTools: childConfig.allowedTools,
  });
  if (settings === undefined) {
    throw new Error("no adapter send tools configured.");
  }
  const clients = createAdapterSendToolsClients(settings);
  const server = createAdapterSendToolsServer(settings, clients);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`mono-agent-adapter-send-tools: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

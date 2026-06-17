#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSelfCapabilitiesMcpServer } from "./self-capabilities-mcp.js";
import { selfCapabilitiesSettingsFromEnv } from "./self-capabilities.js";

async function main(): Promise<void> {
  const settings = selfCapabilitiesSettingsFromEnv(process.env);
  const server = createSelfCapabilitiesMcpServer(settings);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`mono-agent-self-capabilities: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

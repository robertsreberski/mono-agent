import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadSlackModule, loadTelegramModule } from "./clients.js";
import { registerAskUserTool } from "./ask-user.js";
import { registerSlackSendTool } from "./slack-send.js";
import { registerTelegramSendTool, registerTelegramSendFileTool } from "./telegram-send.js";
import type {
  AdapterSendToolsSettings,
  AdapterSendToolsClients,
  AdapterSendToolsIndexing,
  AdapterSendToolsHttpOptions,
} from "./types.js";

export async function createAdapterSendToolsServer(
  settings: AdapterSendToolsSettings,
  clients: AdapterSendToolsClients,
  indexing?: AdapterSendToolsIndexing,
  options: AdapterSendToolsHttpOptions = {},
): Promise<McpServer> {
  const server = new McpServer({ name: "agent-adapter-send-tools", version: "0.3.0" });

  // Registered first so the listed order matches adapterSendToolNames: asking the
  // user is a decision step, not a trailing channel utility.
  // Target availability is checked before any bridge request, not in the schema.
  if (settings.askUser !== undefined) {
    registerAskUserTool(server, settings.askUser, options.fetchImpl ?? globalThis.fetch);
  }
  if (settings.slack !== undefined && clients.slack !== undefined) {
    const adapter = await loadSlackModule();
    registerSlackSendTool(
      server,
      settings.slack,
      clients.slack,
      adapter.formatMarkdownForSlack,
      indexing,
      options.deliveryHistory,
      options.fetchImpl ?? globalThis.fetch,
    );
  }
  if (settings.telegram !== undefined && clients.telegram !== undefined) {
    const adapter = await loadTelegramModule();
    if (settings.telegram.tools.send && clients.telegram.sendMessage !== undefined) {
      registerTelegramSendTool(
        server,
        settings.telegram,
        { sendMessage: clients.telegram.sendMessage },
        adapter,
        options.deliveryHistory,
        options.fetchImpl ?? globalThis.fetch,
      );
    }
    if (
      settings.telegram.tools.file
      && (clients.telegram.sendDocument !== undefined || clients.telegram.sendPhoto !== undefined)
    ) {
      registerTelegramSendFileTool(
        server,
        settings.telegram,
        clients.telegram,
        adapter,
        options.deliveryHistory,
        options.fetchImpl ?? globalThis.fetch,
      );
    }
  }

  return server;
}

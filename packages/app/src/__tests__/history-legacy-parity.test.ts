import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolHistoryReader } from "@mono-agent/conversation";
import { expect, it } from "vitest";
import { createConversationHistoryServer, handleConversationHistoryRequest } from "../request-tools/conversation-history.js";
import { createSessionHistoryServer, handleSessionHistoryRequest } from "../request-tools/session-history.js";
import { createRunHistoryServer } from "../request-tools/run-history.js";

// Captured on the pre-feature revision, before adding the opt-in implementation.
// These app-owned declarations and deterministic errors must remain byte-identical.
it("preserves the split MCP tool lists, descriptions and results", async () => {
  const binding = { reader: new ToolHistoryReader("/nonexistent-fictional-history"), conversationId: "web:fiction", logicalConversationId: "web:fiction", runId: "current" };
  const servers = [createConversationHistoryServer(binding), createSessionHistoryServer(binding), createRunHistoryServer({ artifactDir: "/nonexistent-fictional-artifacts", conversationId: binding.conversationId, runId: binding.runId })];
  const outputs = [];
  for (const server of servers) {
    const client = new Client({ name: "fictional-parity", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      outputs.push({ list: await client.listTools(), result: await client.callTool({ name: (await client.listTools()).tools[0]!.name, arguments: { cursor: "invalid" } }) });
    } finally { await client.close(); await server.close(); }
  }
  expect(JSON.stringify(outputs)).toMatchSnapshot();
  expect(JSON.stringify(handleConversationHistoryRequest(binding, { action: "get" }))).toMatchSnapshot();
  expect(JSON.stringify(handleSessionHistoryRequest(binding, { action: "get" }))).toMatchSnapshot();
});

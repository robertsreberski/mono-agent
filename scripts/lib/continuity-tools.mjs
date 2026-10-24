// Loopback fixture MCP server for scripted replay. It returns the frozen tool
// output recorded in a fictional trace, so the production Pi tool loop,
// native transcript and tool-history sidecar record real tool lifecycles.
// It is only attached to scripted replay turns; probe turns have no tools.
import { createServer } from "node:http";

export const FIXTURE_SERVER_NAME = "continuity-fixture";

const OBJECT = { type: "object", additionalProperties: true };
export const TOOL_DEFINITIONS = Object.freeze([
  ["mail_search", "Search the owner's mailbox; returns matching message summaries."],
  ["mail_read", "Read one email message in full."],
  ["mail_send", "Send an email on the owner's behalf."],
  ["mail_draft", "Save an email draft without sending it."],
  ["chat_read", "Read a support or team chat transcript."],
  ["chat_send", "Send a chat message on the owner's behalf."],
  ["web_fetch", "Fetch a public web page as text."],
  ["doc_read", "Read one of the owner's documents."],
  ["doc_write", "Create or update one of the owner's documents."],
  ["parcel_track", "Look up a parcel's tracking status."],
  ["calendar_list", "List calendar events in a date range."],
  ["calendar_add", "Add a calendar event."],
].map(([name, description]) => Object.freeze({ name, description, inputSchema: OBJECT })));
export const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));

export function callKey(name, args) {
  const stable = (value) => (Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value);
  return `${name}\0${JSON.stringify(stable(args ?? {}))}`;
}

/** Start a per-replay server; `expect` queues the frozen result for the next identical call. */
export async function startFixtureTools() {
  const [{ Server }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const queues = new Map();
  const mismatches = [];
  let served = 0;
  const http = createServer(async (request, response) => {
    try {
      const server = new Server({ name: FIXTURE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })) }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const key = callKey(call.params.name, call.params.arguments);
        const queue = queues.get(key);
        if (!queue || queue.length === 0) {
          mismatches.push(call.params.name);
          return { content: [{ type: "text", text: "Fixture error: no scripted result for this call." }], isError: true };
        }
        served += 1;
        return { content: [{ type: "text", text: queue.shift() }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => { void transport.close(); void server.close(); });
      let body = "";
      for await (const chunk of request) body += chunk;
      await server.connect(transport);
      await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
    } catch {
      if (!response.headersSent) { response.statusCode = 500; response.end(); }
    }
  });
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const { port } = http.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    expect(name, args, result) {
      const key = callKey(name, args);
      queues.set(key, [...(queues.get(key) ?? []), result]);
    },
    pending() { return [...queues.values()].reduce((sum, queue) => sum + queue.length, 0); },
    mismatches() { return [...mismatches]; },
    served() { return served; },
    close: () => new Promise((resolve) => { http.closeAllConnections?.(); http.close(() => resolve()); }),
  };
}

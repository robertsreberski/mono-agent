// Faux-only process proof. No credentials are read and no external transport exists.
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { guardedLookupModels, LOOKUP_GUARD_CONTRACT as C, createTestOnlyLookupPermitSource, assertLookupChildSafety } from "../../lib/continuity-lookup-guard.mjs";
import { startFixtureTools } from "../../lib/continuity-tools.mjs";

const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const opts = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof opts === "object" ? opts.host ?? opts.hostname : args[1];
  if (host !== "127.0.0.1" && host !== "::1") throw Error("smoke_external_egress_denied");
  return connect.apply(this, args);
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (new URL(typeof url === "string" || url instanceof URL ? url : url.url).hostname !== "127.0.0.1") throw Error("smoke_external_fetch_denied");
  return nativeFetch(url, init);
};
globalThis.WebSocket = class { constructor() { throw Error("smoke_websocket_denied"); } };
const deadline = setTimeout(() => { process.stderr.write("smoke_timeout\n"); process.exit(1); }, 110000);
try {
  if (process.argv[2] !== "--child") {
    const tools = await startFixtureTools(); tools.expect("doc_read", {}, "Fictional lookup result.");
    let child;
    try {
      child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--child", tools.url], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, stderr); assert.deepEqual(JSON.parse(stdout), { sends: 1, settled: 1, externalEgress: 0 }); assert.equal(tools.served(), 1);
      process.stdout.write(JSON.stringify({ processes: 2, loopbackMcpCalls: 1, sends: 1, settled: 1, externalEgress: 0 }) + "\n");
    } finally { child?.kill(); await tools.close(); }
  } else {
    assertLookupChildSafety({ plan: { judge: null }, memory: false, subagents: false, upkeep: false, compaction: false, outputSchema: null });
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/streamableHttp.js")]);
    const client = new Client({ name: "fictional-guard-smoke", version: "1" });
    let tool;
    try { await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[3]))); tool = await client.callTool({ name: "doc_read", arguments: {} }); }
    finally { await client.close(); }
    const pi = join(process.cwd(), "packages/turn/node_modules/@earendil-works/pi-ai");
    const pkg = JSON.parse(await readFile(join(pi, "package.json"), "utf8"));
    // Use the installed public serializer API, hosted by a faux Models object.
    const { streamSimple } = await import(pathToFileURL(join(pi, pkg.exports["./api/*"].import.replace("*", "openai-codex-responses"))).href);
    const encode = x => Buffer.from(JSON.stringify(x)).toString("base64url");
    const fakeKey = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE-TEST-ACCOUNT-NOT-REAL" } })}.FAKE-TEST-SIGNATURE`;
    const model = { provider: C.provider, id: C.model, api: C.api, baseUrl: C.baseUrl, name: "Fictional", reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } };
    const permit = createTestOnlyLookupPermitSource(); let sends = 0;
    const guarded = guardedLookupModels({ streamSimple }, { contract: { ...C, slotId: "fictional-slot", runId: "fictional-run" }, permit, send: async url => { assert.equal(String(url), `${C.baseUrl}/codex/responses`); sends++;
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }); } });
    const output = { type: "message", id: "fictional-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fictional answer.", annotations: [] }] };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...output, content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: output.id, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: output.id, delta: "Fictional answer." },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "fictional-response", status: "completed", output: [output], service_tier: "priority", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } } } },
    ];
    const result = await guarded.streamSimple(model, { messages: [{ role: "user", content: tool.content[0].text, timestamp: 0 }] }, {
      apiKey: fakeKey, reasoning: "high", transport: "sse", maxRetries: 0,

    }).result();
    assert.equal(result.stopReason, "stop");
    const settled = permit.events.filter(e => e.type === "settle" && e.outcome.kind === "settled").length;
    assert.equal(settled, 1); assert.equal(sends, 1);
    process.stdout.write(JSON.stringify({ sends, settled, externalEgress: 0 }));
  }
} finally { clearTimeout(deadline); }

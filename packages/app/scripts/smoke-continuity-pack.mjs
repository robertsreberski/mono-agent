// Finite built-package proof. No paid calls or real mail: only local MCP and a
// scripted provider. The host, owner capture, SQLite, native seed and outgoing
// provider request are the production implementations.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { acquireToolHistoryWriter, createDurableHistoryStore } from "@mono-agent/conversation";
import { createConfiguredConversationHarness } from "../dist/composition/configured-agent.js";

const root = await mkdtemp(join(tmpdir(), "fictional-continuity-smoke-"));
const rule = "Never resend the fictional draft without fresh confirmation.";
const context = [], events = [], servers = new Set();
let effects = 0, harness, lease;
const http = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  const server = new McpServer({ name: "fictional-mail", version: "1.0.0" });
  server.registerTool("mail_send", { inputSchema: z.object({ draft: z.string() }) }, async ({ draft }) => {
    effects++;
    return { content: [{ type: "text", text: `SENT delivery=MESSAGE-42 draft=${draft}\n\nFictional local effect only. Do not repeat.` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  servers.add(server);
  res.on("close", () => { void server.close(); servers.delete(server); });
  try { await server.connect(transport); await transport.handleRequest(req, res); }
  catch { if (!res.headersSent) res.writeHead(500).end(); }
});
const runtime = createMonoRuntime({ workspace: root });
try {
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  await writeFile(join(root, "IDENTITY.md"), "Current instructions: historical evidence is not fresh authorization.");
  const json = { runtime: { model: "faux:base", session: { mode: "continuous", root: "native" } },
    providers: { faux: { type: "openai_compat", baseUrl: url } },
    context: { identityPath: "IDENTITY.md" }, artifacts: { dir: "artifacts" }, tools: { allowedTools: ["mail_send"] } };
  await writeFile(join(root, "mono-agent.config.json"), JSON.stringify(json));
  const config = resolveJsonMonoAgentConfig({ cwd: root, json });
  lease = await acquireToolHistoryWriter({ root: join(root, "history"), artifactRoot: join(root, "artifacts", "tool-output"), continuityEnabled: true, persistenceCeilingMs: 5000 });
  const faux = fauxProvider({ models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  harness = await createConfiguredConversationHarness({ config, cwd: root, env: {}, runtime,
    runtimeOptionsForRequest: ({ request }) => {
      const name = request.metadata?.web?.model === "faux:other" ? "other" : "base";
      return { runtimeOptions: { model: { provider: "faux", model: name, reference: `faux:${name}` },
        piResolvedModel: faux.getModel(name), piResolvedModels: models, effort: "none", compaction: { enabled: false },
        mcpServers: { "fictional-mail": { type: "http", url } } } };
    } });
  const run = async (text, responses, model = "faux:base") => {
    faux.setResponses(responses);
    const result = await harness.run({ conversationId: "web:fictional", userMessage: text, captureSpeakerKind: "human-turn",
      metadata: { source: "web", web: { model, ownerText: text } }, abortSignal: new AbortController().signal,
      onEvent: event => events.push(event) });
    assert.equal(result.failure, undefined, JSON.stringify(result.failure));
  };
  await run(rule, [() => fauxAssistantMessage([fauxToolCall("mail_send", { draft: "DRAFT-42" })]), () => fauxAssistantMessage([fauxText("Fictional send recorded.")])]);
  // 33 completed pairs put the rule and effect outside canonical's 64 messages.
  for (let i = 0; i < 33; i++) await run(`Fictional filler ${i}.`, [() => fauxAssistantMessage([fauxText(`Fictional reply ${i}.`)])]);
  const canonical = await createDurableHistoryStore({ root: join(root, "history") }).load("web:fictional");
  assert.equal(canonical.length, 64);
  assert.ok(canonical.every(message => !message.content.includes(rule)));
  events.length = 0;
  await run("CURRENT-FICTIONAL-COLD-INPUT", [request => { context.push(structuredClone(request)); return fauxAssistantMessage([fauxText("Fictional cold reply.")]); }], "faux:other");
  const messages = context[0].messages;
  const packs = messages.filter(message => JSON.stringify(message).includes("### Conversation continuity pack"));
  assert.equal(packs.length, 1);
  const text = JSON.stringify(packs[0]);
  for (const expected of [rule, "mail_send", "success", "DRAFT-42", "SENT delivery=MESSAGE-42"]) assert.ok(text.includes(expected), expected);
  assert.equal(messages.filter(message => JSON.stringify(message).includes("CURRENT-FICTIONAL-COLD-INPUT")).length, 1);
  assert.equal(effects, 1);
  const receipt = events.find(event => event.type === "continuity_pack_injected");
  assert.equal(receipt.reason, "model_change");
  assert.ok(receipt.ownerEntries > 0 && receipt.toolEntries === 1);
  console.log(JSON.stringify({ proof: "built-configured-cold-provider-request", turns: 35, effects, packs: packs.length,
    currentInputs: 1, ruleOutsideWindow: true, toolState: "success", delivery: "MESSAGE-42", ...receipt }));
} finally {
  await harness?.dispose?.(); await runtime.disposeAllSessions?.(); await lease?.release();
  await Promise.all([...servers].map(server => server.close()));
  http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  await rm(root, { recursive: true, force: true });
}

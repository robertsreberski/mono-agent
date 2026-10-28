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
import { readRecordedRun } from "@mono-agent/observability";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { acquireToolHistoryWriter, createDurableHistoryStore } from "@mono-agent/conversation";
import { createConfiguredConversationHarness } from "../dist/composition/configured-agent.js";

const ledgerMode = process.argv.includes("--ledger"), failUpkeep = process.argv.includes("--fail-upkeep");
const root = await mkdtemp(join(tmpdir(), "fictional-continuity-smoke-"));
const rule = "Never resend the fictional draft without fresh confirmation.";
const context = [], events = [], servers = new Set();
let effects = 0, drafts = 0, upkeepCalls = 0, harness, lease;
const http = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  const server = new McpServer({ name: "fictional-mail", version: "1.0.0" });
  server.registerTool("mail_send", { inputSchema: z.object({ draft: z.string() }) }, async ({ draft }) => {
    effects++;
    return { content: [{ type: "text", text: `SENT delivery=MESSAGE-42 draft=${draft}\n\nFictional local effect only. Do not repeat.` }] };
  });
  server.registerTool("mail_draft", { inputSchema: z.object({ draft: z.string() }) }, async ({ draft }) => {
    drafts++;
    return { content: [{ type: "text", text: `DRAFTED draft=${draft} status=NOT_SENT` }] };
  });
  server.registerTool("fixture_lookup", { inputSchema: z.object({ query: z.string() }) }, async () => ({ content: [{ type: "text", text:
    "Fictional lookup head.\n\n" + "Neutral planning prose. ".repeat(512) + " BURIED-42\n\nActual correction: $725 replaces $500." }] }));
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
  const json = { runtime: { model: "faux:base", session: { mode: "continuous", root: "native", ...(ledgerMode ? { continuity: { upkeep: { enabled: true } } } : {}) } },
    providers: { faux: { type: "openai_compat", baseUrl: url } },
    context: { identityPath: "IDENTITY.md" }, artifacts: { dir: "artifacts" }, tools: { allowedTools: ["mail_send", "mail_draft", ...(ledgerMode ? ["fixture_lookup"] : [])] } };
  await writeFile(join(root, "mono-agent.config.json"), JSON.stringify(json));
  const config = resolveJsonMonoAgentConfig({ cwd: root, json });
  lease = await acquireToolHistoryWriter({ root: join(root, "history"), artifactRoot: join(root, "artifacts", "tool-output"), continuityEnabled: true, persistenceCeilingMs: 5000 });
  const faux = fauxProvider({ api: "openai-responses", models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const extraction = fauxProvider({ api: "openai-responses", models: [{ id: "base" }], tokensPerSecond: 1_000_000 });
  const extractionModels = createModels(); extractionModels.setProvider(extraction.provider);
  extraction.setResponses([request => {
    upkeepCalls++; const content = request.messages.at(-1).content;
    const prompt = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.ok(prompt.includes("BURIED-42")); assert.ok(prompt.includes("Actual correction: $725 replaces $500."));
    if (failUpkeep) return fauxAssistantMessage("INVALID FICTIONAL EXTRACTION");
    const spans = prompt.split("\n").flatMap(line => { try { const row = JSON.parse(line); return row.id && row.text ? [row] : []; } catch { return []; } });
    const source = value => spans.find(span => span.text.includes(value)).id;
    return fauxAssistantMessage(JSON.stringify({ entries: [
      { kind: "identifier", value: "BURIED-42", status: "active", sources: [source("BURIED-42")] },
      { kind: "supersession", value: "The actual corrected amount is $725; $500 is superseded.", status: "active", sources: [source("Actual correction")] },
      { kind: "constraint", value: "Require fresh confirmation before resending.", status: "active", sources: [source(rule)] },
    ], covered: spans.map(span => span.id) }));
  }]);
  harness = await createConfiguredConversationHarness({ config, cwd: root, env: {}, runtime, runtimeOptions: { piResolvedModels: extractionModels },
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
    return result;
  };
  await run(rule, [() => fauxAssistantMessage([fauxToolCall("mail_draft", { draft: "DRAFT-43" }), fauxToolCall("mail_send", { draft: "DRAFT-42" }), ...(ledgerMode ? [fauxToolCall("fixture_lookup", { query: "fictional" })] : [])]), () => fauxAssistantMessage([fauxText("Fictional send recorded.")])]);
  // 33 completed pairs put the rule and effect outside canonical's 64 messages.
  for (let i = 0; i < 33; i++) await run(`Fictional filler ${i}.`, [() => fauxAssistantMessage([fauxText(`Fictional reply ${i}.`)])]);
  const canonical = await createDurableHistoryStore({ root: join(root, "history") }).load("web:fictional");
  assert.equal(canonical.length, 64);
  assert.ok(canonical.every(message => !message.content.includes(rule)));
  events.length = 0;
  const cold = await run("CURRENT-FICTIONAL-COLD-INPUT", [request => { context.push(structuredClone(request)); return fauxAssistantMessage([fauxText("Fictional cold reply.")]); }], "faux:other");
  const messages = context[0].messages;
  const packs = messages.filter(message => JSON.stringify(message).includes("### Conversation continuity pack"));
  assert.equal(packs.length, 1);
  const text = JSON.stringify(packs[0]);
  for (const expected of [rule, "mail_send", "success", "DRAFT-42", "SENT delivery=MESSAGE-42"]) assert.ok(text.includes(expected), expected);
  assert.equal(messages.filter(message => JSON.stringify(message).includes("CURRENT-FICTIONAL-COLD-INPUT")).length, 1);
  assert.equal(effects, 1); assert.equal(drafts, 1);
  const packText = typeof packs[0].content === "string" ? packs[0].content : packs[0].content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.match(packText, /name="mail_send" final_state="success".*SENT delivery=MESSAGE-42/u);
  assert.match(packText, /name="mail_draft" final_state="success".*DRAFTED draft=DRAFT-43 status=NOT_SENT/u);
  assert.ok(packText.includes("what was asked, not what was done"));
  assert.ok(text.includes("invocation_id="));
  assert.equal(JSON.stringify(messages).split("SENT delivery=MESSAGE-42").length - 1, 1);
  const receipt = events.find(event => event.type === "continuity_pack_injected");
  assert.equal(receipt.reason, "model_change");
  assert.ok(receipt.ownerEntries > 0 && receipt.toolEntries === (ledgerMode ? 3 : 2));
  assert.equal(receipt.ownerDeduped, 32); assert.equal(receipt.toolReserved, ledgerMode ? 3 : 2);
  if (ledgerMode) {
    assert.equal(upkeepCalls, 1);
    const recorded = await readRecordedRun({ artifactDir: join(root, "artifacts") }, cold.metadata.runId);
    assert.equal(recorded.upkeepAccounting.length, 1);
    assert.equal(recorded.upkeepAccounting[0].model, "faux:base");
    assert.equal(recorded.upkeepAccounting[0].phase, "result");
    assert.equal(recorded.upkeepAccounting[0].usageIncluded, false);
    const upkeep = events.filter(event => event.type === "continuity_upkeep"); assert.equal(upkeep.length, 1);
    assert.equal(upkeep[0].status, failUpkeep ? "invalid" : "valid");
    assert.equal(receipt.ledgerEntries > 0, !failUpkeep);
    assert.equal(text.includes("BURIED-42"), !failUpkeep);
    if (!failUpkeep) { assert.ok(text.includes("The actual corrected amount is $725")); assert.ok(upkeep[0].generationId); }
    else assert.equal(receipt.degradedReason, "upkeep_gap");
  }
  console.log(JSON.stringify({ ledgerMode, failUpkeep, upkeepCalls, proof: "built-configured-cold-provider-request", turns: 35, effects, drafts, packs: packs.length,
    currentInputs: 1, ruleOutsideWindow: true, toolState: "success", delivery: "MESSAGE-42", accountingCompanions: ledgerMode ? 1 : 0, ...receipt }));
} finally {
  await harness?.dispose?.(); await runtime.disposeAllSessions?.(); await lease?.release();
  await Promise.all([...servers].map(server => server.close()));
  http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  await rm(root, { recursive: true, force: true });
}

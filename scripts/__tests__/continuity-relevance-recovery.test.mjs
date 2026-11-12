import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productionModules } from "../lib/continuity-runner.mjs";
import { createE2Models, loadE2Estimators, shippingSoul } from "../lib/continuity-e2-models.mjs";
import { historyBody, lookupWitness, referenceReader, scriptedLookupReader, sha256 } from "../lib/continuity-lookup.mjs";
import { measureSizingRegressions } from "../continuity-lookup-budget.mjs";
import { createConversationHistoryRuntimeExtension, handleConversationHistoryRequest } from "../../packages/app/dist/request-tools/conversation-history.js";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function scratch() { const base = join(ROOT, ".worklab-tmp"); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "relevance-recovery-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }

/** A deterministic model-visible actor: no planted IDs, fixture corpus or answer
 * key. It can only use the natural query, public previews and returned actions. */
function naturalReader(pi, query, path) {
  let requests = 0;
  const observed = [], witness = lookupWitness(), delivered = new Set();
  return {
    observed, witness,
    reply(context) {
      requests++;
      const bodies = (context.messages ?? []).filter(m => m.role === "toolResult").map(m => ({ message: m, body: historyBody({ content: m.content }) }));
      for (const { message } of bodies) if (!delivered.has(message.toolCallId)) { delivered.add(message.toolCallId); witness.delivered({ content: message.content }); }
      observed.push({ tools: (context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? [])).map(t => t.name), bodies: bodies.map(row => row.body) });
      let actions;
      if (requests === 1) {
        expect(JSON.stringify(context)).not.toMatch(/chr1_[A-Za-z0-9_-]{43}/u);
        actions = [{ action: "search", query, limit: 5 }];
      } else if (requests === 4) {
        expect(context.tools).toEqual([]);
        expect(witness.snapshot().records.every(r => r.verified)).toBe(true);
        return pi.fauxAssistantMessage([pi.fauxText("Retained original and correction recovered; neither renews approval.")]);
      } else {
        const search = bodies.find(row => row.body?.action === "search")?.body;
        expect(search).toBeTruthy();
        const selected = search.items.filter(item => /Original report:|Correction:/u.test(item.preview));
        const gets = selected.map(item => search.navigation.nextActions.find(a => a.kind === "get_record" && a.arguments.recordId === item.recordId)?.arguments);
        expect(gets.every(Boolean)).toBe(true);
        if (path === "sequential") actions = [gets[requests - 2]];
        else if (requests === 2) actions = gets;
        else actions = bodies.filter(row => row.body?.action === "get").flatMap(row => row.body.navigation.nextActions.filter(a => a.kind === "next_get_chunk").map(a => a.arguments));
      }
      expect(actions.length).toBeGreaterThan(0);
      return pi.fauxAssistantMessage(actions.map((args, index) => pi.fauxToolCall("ConversationHistory", args, { id: `request-${requests}-call-${index}` })), { stopReason: "toolUse" });
    },
  };
}

it.each(["batch", "single-deep", "sequential"])("recovers complete retained records through the real MCP and installed tool loop within R=3 (%s)", async path => {
  const root = await scratch(), modules = await productionModules(ROOT), pi = modules.pi;
  const { ToolHistoryWriter, continuityGenerationId, continuityRecordId } = modules.conversation;
  const history = join(root, "history"), conversationId = "fictional-observatory", writer = await ToolHistoryWriter.open({ root: history, continuityEnabled: true });
  cleanup.push(() => writer.close());
  const size = path === "sequential" ? 8192 : 16384;
  const pad = tail => "x".repeat(size - Buffer.byteLength(tail)) + tail;
  const required = [pad("\nOriginal report: observatory cobalt delivery was proposed for day 12; not approved.")];
  if (path !== "single-deep") required.push(pad("\nCorrection: observatory cobalt delivery was changed to day 18; still not approved."));
  const texts = [...required, ...Array.from({ length: 24 }, (_, n) => `Observatory distraction ${n}; cobalt irrelevant to the unrelated order.`)];
  const generationId = continuityGenerationId(), records = texts.map((text, sequence) => ({ text, sequence, recordId: continuityRecordId(conversationId, `record-${sequence}`), runId: "old", kind: "assistant", provenance: "assistant" }));
  await writer.prepareContinuity({ generationId, conversationId, logicalConversationId: conversationId, beforeDigest: null, afterDigest: sha256("fixture"), records });
  await writer.commitContinuity({ generationId, conversationId, canonicalDigest: sha256("fixture") });
  await writer.close();
  const extension = await createConversationHistoryRuntimeExtension({ historyRoot: history })({ runId: "retrieval", request: { conversationId, userMessage: "Retrieve original and correction.", abortSignal: new AbortController().signal }, context: {} });
  cleanup.push(() => extension.cleanup?.());
  const estimators = await loadE2Estimators(), soul = await shippingSoul();
  const faux = pi.fauxProvider({ provider: "faux", models: [{ id: "fictional-recovery", contextWindow: 272000, maxTokens: 8192 }] });
  const collection = pi.createModels(); collection.setProvider(faux.provider);
  const actor = naturalReader(pi, "observatory cobalt delivery", path);
  // Use the unmodified E2 request ordinal/withdrawal adapter. Two calls in one
  // assistant message remain one tool round, not two funded model requests.
  const route = createE2Models({ pi, estimators, models: [{ model: "faux:fictional-recovery" }], limits: { compactions: 0, probeRequests: 4, sourceRequests: 0 },
    probeLookupRounds: 3, soul, sourceReply: context => actor.reply(context) });
  route.setPosition({ probe: true, model: "faux:fictional-recovery", turn: 0, message: 0 });
  const runtime = modules.host.createMonoRuntime({ workspace: root });
  const result = await runtime.run(`## Core Guardrails\n\n${soul.text}`, { model: { provider: "faux", model: "fictional-recovery", reference: "faux:fictional-recovery" },
    cwd: root, messages: [{ role: "user", content: "Retrieve the observatory cobalt delivery original report and correction, without performing effects." }],
    allowedTools: ["ConversationHistory"], ...extension.runtimeOptions, piResolvedModel: faux.getModel(), piResolvedModels: route.decorator(collection),
    maxTurns: 4, compaction: { enabled: false }, piMaxRetries: 0 });
  expect(result.error).toBeNull(); expect(result.text).toContain("recovered");
  expect(actor.observed).toHaveLength(4);
  expect(actor.observed.map(row => row.tools)).toEqual([["ConversationHistory"], ["ConversationHistory"], ["ConversationHistory"], []]);
  const search = actor.observed[1].bodies.find(body => body?.action === "search");
  expect(search.items.slice(0, 5).filter(item => records.slice(0, required.length).some(record => record.recordId === item.recordId))).toHaveLength(required.length);
  const witnessed = actor.witness.snapshot().records;
  expect(witnessed).toHaveLength(required.length);
  expect(witnessed.map(row => row.sha256).sort()).toEqual(required.map(sha256).sort());
  expect(witnessed.every(row => row.verified && row.chunks === (path === "sequential" ? 1 : 2))).toBe(true);
  expect(route.report().probeRequests).toBe(4);
}, 30000);

it("runs fictional Unicode/escaping sizing independently and fails before get on a real discovery miss", async () => {
  const modules = await productionModules(ROOT), root = await scratch();
  const result = await measureSizingRegressions({ modules, root: join(root, "success"), handleConversationHistoryRequest });
  expect(result.paths).toHaveLength(4); expect(result.paths.every(path => path.discovered && path.verified && path.searchPages === 1)).toBe(true);
  let gets = 0;
  await expect(measureSizingRegressions({ modules, root: join(root, "miss"), handleConversationHistoryRequest(binding, args) {
    if (args.action === "get") gets++;
    return handleConversationHistoryRequest(binding, args.action === "search" ? { ...args, query: "fictional-nonexistent-term" } : args);
  } })).rejects.toThrow("regression_source_not_discovered");
  expect(gets).toBe(0);
});

it("keeps first-result and reference consumers on actual returned relevance IDs/actions", () => {
  const first = "chr1_" + "a".repeat(43), second = "chr1_" + "b".repeat(43);
  const reader = scriptedLookupReader();
  expect(reader.next({ messages: [] })).toMatchObject({ action: "search", query: "order" });
  expect(reader.next({}, { items: [{ recordId: first }], navigation: { nextActions: [{ kind: "next_search_page", arguments: { action: "search", cursor: "v2" } }] } })).toEqual({ action: "search", cursor: "v2" });
  expect(reader.next({}, { items: [{ recordId: second }] })).toMatchObject({ action: "get", recordId: second });
  const reference = referenceReader({ source: { recordId: second }, query: "order" });
  expect(reference.next({ messages: [] })).toMatchObject({ action: "search" });
  expect(reference.next({}, { action: "search", items: [{ recordId: first }] })).toBeNull();
});

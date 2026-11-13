import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productionModules } from "../lib/continuity-runner.mjs";
import { createE2Models, loadE2Estimators, shippingSoul } from "../lib/continuity-e2-models.mjs";
import { historyBody, lookupWitness, referenceReader, scriptedLookupReader, sha256 } from "../lib/continuity-lookup.mjs";
import { measureSizingRegressions } from "../continuity-lookup-budget.mjs";
import { createConversationHistoryRuntimeExtension, handleConversationHistoryRequest } from "../../packages/app/dist/request-tools/conversation-history.js";
import rankingFixture from "../../packages/conversation/src/__tests__/fixtures/continuity-ranking.json" with { type: "json" };
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function scratch() { const base = join(ROOT, ".worklab-tmp"); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "relevance-recovery-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }

const EVIDENCE_RULE = "Historical alternatives need a specific distinguishing record/edit, not nearby work. If unfound, say so; don't pick or deny either. Answer if evidence suffices.";

/** A deterministic model-visible actor: no planted IDs, fixture corpus or answer
 * key. It can only use the natural query, public previews and returned actions. */
function naturalReader(pi, query, path, maxSearchRank = 5) {
  let requests = 0;
  const observed = [], witness = lookupWitness(), delivered = new Set();
  return {
    observed, witness,
    reply(context) {
      requests++;
      const bodies = (context.messages ?? []).filter(m => m.role === "toolResult").map(m => ({ message: m, body: historyBody({ content: m.content }) }));
      for (const { message } of bodies) if (!delivered.has(message.toolCallId)) { delivered.add(message.toolCallId); witness.delivered({ content: message.content }); }
      observed.push({ visible: bodies.map(({ message }) => message.content.map(block => block.text ?? "").join("\n")), tools: (context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? [])).map(t => t.name), bodies: bodies.map(row => row.body) });
      let actions;
      if (requests === 1) {
        expect(JSON.stringify(context)).not.toMatch(/chr1_[A-Za-z0-9_-]{43}/u);
        actions = [{ action: "search", query, limit: maxSearchRank }];
      } else if (requests === 4) {
        expect(context.tools).toEqual([]);
        expect(context.messages.every(message => !message.toolsAdded?.length)).toBe(true);
        expect(bodies.length).toBeGreaterThan(0);
        for (const { message } of bodies) expect(message.content.map(block => block.text ?? "").join("\n")).toContain(EVIDENCE_RULE);
        expect(witness.snapshot().records.every(r => r.verified)).toBe(true);
        return pi.fauxAssistantMessage([pi.fauxText("Retained original and correction recovered; neither renews approval.")]);
      } else {
        const search = bodies.find(row => row.body?.action === "search")?.body;
        expect(search).toBeTruthy();
        const selected = path === "ranked" ? search.items.slice(0, maxSearchRank) : search.items.filter(item => /Original report:|Correction:/u.test([item.preview, ...(item.additionalPreviews ?? []).map(window => window.preview)].join("\n")));
        const gets = selected.map(item => search.navigation.nextActions.find(a => a.kind === "get_record" && a.arguments.recordId === item.recordId)?.arguments);
        expect(gets.every(Boolean)).toBe(true);
        if (path === "sequential") actions = [gets[requests - 2]];
        else if (requests === 2) actions = gets;
        else actions = bodies.filter(row => row.body?.action === "get").flatMap(row => row.body.navigation.nextActions.filter(a => a.kind === "next_get_chunk").map(a => a.arguments));
      }
      if (path === "ranked" && requests === 3 && actions.length === 0) {
        expect(witness.snapshot().records.every(row => row.verified)).toBe(true);
        return pi.fauxAssistantMessage([pi.fauxText("Complete retained evidence recovered; no renewed approval.")]);
      }
      expect(actions.length).toBeGreaterThan(0);
      return pi.fauxAssistantMessage(actions.map((args, index) => pi.fauxToolCall("ConversationHistory", args, { id: `request-${requests}-call-${index}` })), { stopReason: "toolUse" });
    },
  };
}

it.each(["batch", "batch-unicode", "batch-separated", "single-deep", "sequential"])("recovers complete retained records through the real MCP and installed tool loop within R=3 (%s)", async path => {
  const root = await scratch(), modules = await productionModules(ROOT), pi = modules.pi;
  const { ToolHistoryWriter, continuityGenerationId, continuityRecordId } = modules.conversation;
  const history = join(root, "history"), conversationId = "fictional-observatory", writer = await ToolHistoryWriter.open({ root: history, continuityEnabled: true });
  cleanup.push(() => writer.close());
  const size = path === "sequential" ? 8192 : ["batch-unicode", "batch-separated"].includes(path) ? 16381 : 16384;
  const pad = tail => {
    const prefix = path === "batch-unicode" ? "x".repeat(8189) + "🔷" : "";
    return prefix + "x".repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(tail)) + tail;
  };
  const required = [pad("\nOriginal report: observatory cobalt delivery was proposed for day 12; not approved.")];
  if (path !== "single-deep") required.push(pad("\nCorrection: observatory cobalt delivery was changed to day 18; still not approved."));
  if (path === "batch-separated") {
    for (const [index, label] of ["Original report", "Correction"].entries()) {
      const lead = `${label}: observatory delivery referent is the fictional order. `;
      const tail = `\nNot approved: cobalt delivery day ${index ? 18 : 12} remains hypothetical, not an instruction.`;
      required[index] = lead + "x".repeat(size - Buffer.byteLength(lead + tail)) + tail;
    }
  }
  const texts = [...required, ...(path === "batch-separated" ? ["observatory cobalt delivery: unrelated shipment day 99, not the requested referent."] : []), ...Array.from({ length: 24 }, (_, n) => `Observatory distraction ${n}; cobalt irrelevant to the unrelated order.`)];
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
  if (path === "batch-separated") {
    expect(search.items[0].preview).toContain("unrelated shipment");
    expect(records.slice(0, 2).map(record => record.recordId)).toContain(search.items[1].recordId);
    expect(search.items[1].additionalPreviews[0].preview).toContain("Not approved");
    expect(search.items[1].additionalPreviews[0].preview).toContain("hypothetical");
    expect(actor.observed[1].visible.join("\n")).toContain("Batch useful get calls");
    expect(actor.observed[1].visible.join("\n")).toContain('"complete":false');
    expect(actor.observed[2].visible.join("\n")).toContain("Follow the exact cursor action until no cursor remains");
  }
  const witnessed = actor.witness.snapshot().records;
  expect(witnessed).toHaveLength(required.length);
  expect(witnessed.map(row => row.sha256).sort()).toEqual(required.map(sha256).sort());
  expect(witnessed.every(row => row.verified && row.chunks === (path === "sequential" ? 1 : 2))).toBe(true);
  expect(route.report().probeRequests).toBe(4);
}, 30000);

it("runs fictional Unicode/escaping sizing independently and fails before get on a real discovery miss", async () => {
  const modules = await productionModules(ROOT), root = await scratch();
  const sentinel = join(root, "caller-owned.txt"); await writeFile(sentinel, "Keep fictional caller data.");
  const result = await measureSizingRegressions({ modules, root, handleConversationHistoryRequest });
  expect(await readdir(root)).toEqual(["caller-owned.txt"]);
  expect(await readFile(sentinel, "utf8")).toBe("Keep fictional caller data.");
  expect(result.paths).toHaveLength(4); expect(result.paths.every(path => path.discovered && path.verified && path.searchPages === 1)).toBe(true);
  let gets = 0;
  await expect(measureSizingRegressions({ modules, root, handleConversationHistoryRequest(binding, args) {
    if (args.action === "get") gets++;
    return handleConversationHistoryRequest(binding, args.action === "search" ? { ...args, query: "fictional-nonexistent-term" } : args);
  } })).rejects.toThrow("regression_source_not_discovered");
  expect(gets).toBe(0);
  expect(await readdir(root)).toEqual(["caller-owned.txt"]);
  expect(await readFile(sentinel, "utf8")).toBe("Keep fictional caller data.");
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


it.each(rankingFixture.recovery)("recovers frozen $name sources with fresh v3 searches through installed MCP within R=3", async scenario => {
  const root = await scratch(), modules = await productionModules(ROOT), pi = modules.pi;
  const history = join(root, "history"), conversationId = "fictional-ranking";
  const writer = await modules.conversation.ToolHistoryWriter.open({ root: history, continuityEnabled: true });
  cleanup.push(() => writer.close());
  const texts = scenario.required.map(source => ({ ...source, text: scenario.name === "short-edit" ? source.text : source.text + "\n" + "x".repeat(scenario.recordBytes - Buffer.byteLength(source.text) - 1) }));
  const sources = [...texts, ...Array.from({ length: scenario.echoCount }, () => ({ kind: "assistant", text: scenario.echo }))];
  const generationId = modules.conversation.continuityGenerationId();
  const records = sources.map((source, sequence) => ({ ...source, sequence, recordId: modules.conversation.continuityRecordId(conversationId, `source-${sequence}`),
    runId: "prior", provenance: source.kind === "user" ? "unknown" : "assistant" }));
  await writer.prepareContinuity({ generationId, conversationId, logicalConversationId: conversationId, beforeDigest: null, afterDigest: sha256("fixture"), records });
  await writer.commitContinuity({ generationId, conversationId, canonicalDigest: sha256("fixture") }); await writer.close();
  const extension = await createConversationHistoryRuntimeExtension({ historyRoot: history })({ runId: "lookup", request: { conversationId, userMessage: "Retrieve retained evidence.", abortSignal: new AbortController().signal }, context: {} });
  cleanup.push(() => extension.cleanup?.());
  const estimators = await loadE2Estimators(), soul = await shippingSoul();
  const faux = pi.fauxProvider({ provider: "faux", models: [{ id: "fictional-ranking", contextWindow: 272000, maxTokens: 8192 }] });
  const collection = pi.createModels(); collection.setProvider(faux.provider);
  const actor = naturalReader(pi, scenario.query, "ranked", scenario.maxSearchRank);
  const route = createE2Models({ pi, estimators, models: [{ model: "faux:fictional-ranking" }], limits: { compactions: 0, probeRequests: 4, sourceRequests: 0 },
    probeLookupRounds: 3, soul, sourceReply: context => actor.reply(context) });
  route.setPosition({ probe: true, model: "faux:fictional-ranking", turn: 0, message: 0 });
  const result = await modules.host.createMonoRuntime({ workspace: root }).run(`## Core Guardrails\n\n${soul.text}`, {
    model: { provider: "faux", model: "fictional-ranking", reference: "faux:fictional-ranking" }, cwd: root,
    messages: [{ role: "user", content: scenario.query }], allowedTools: ["ConversationHistory"], ...extension.runtimeOptions,
    piResolvedModel: faux.getModel(), piResolvedModels: route.decorator(collection), maxTurns: 4, compaction: { enabled: false }, piMaxRetries: 0 });
  const requests = scenario.name === "short-edit" ? 3 : 4;
  expect(requests - 1).toBeLessThanOrEqual(scenario.maxRounds);
  expect(result.error).toBeNull(); expect(actor.observed).toHaveLength(requests); expect(route.report().probeRequests).toBe(requests);
  const search = actor.observed[1].bodies.find(body => body?.action === "search");
  expect(search.rankingVersion).toBe(3); expect(actor.observed[1].visible.join("\n")).toContain('"rankingVersion":3');
  for (const record of records.slice(0, 2)) {
    expect(search.items.slice(0, scenario.maxSearchRank).map(item => item.recordId)).toContain(record.recordId);
    expect(actor.witness.snapshot().records.find(row => row.recordId === record.recordId)).toMatchObject({ verified: true, chunks: scenario.name === "short-edit" ? 1 : 2, sha256: sha256(record.text) });
  }
  if (requests === 4) expect(actor.observed[3].tools).toEqual([]);
}, 30000);

// Scripted actors prove delivery and supported-answer mechanics, not model
// adherence, abstention rates or qualification results. Pair each evidence case
// with reversed alternative order so this wiring proof cannot depend on order.
const disciplineCases = [
  { name: "found-edit", kind: "user", texts: ["Observatory edit: the selected tile changed from cobalt to amber."], answer: "amber" },
  { name: "sufficient-summary", kind: "summary", texts: ["Observatory summary: the selected tile was amber, replacing cobalt."], answer: "amber" },
  { name: "surrounding-work-only", kind: "assistant", texts: ["Observatory work: cobalt and amber tiles were inspected; no selection is recorded."], answer: null },
  { name: "conflicting", kind: "user", texts: ["Observatory edit: the selected tile changed from cobalt to amber.", "Observatory edit: the selected tile changed from amber to cobalt."], answer: null },
  { name: "missing-edit", kind: "assistant", texts: ["Observatory note: a tile edit was mentioned, but its contents were not retained."], answer: null },
];
it.each(disciplineCases.flatMap(scenario => [false, true].map(reverse => ({ ...scenario, reverse }))))(
  "delivers evidence discipline after tool withdrawal: $name (reversed=$reverse)", async scenario => {
    const root = await scratch(), modules = await productionModules(ROOT), pi = modules.pi;
    const history = join(root, "history"), conversationId = "fictional-evidence-discipline";
    const writer = await modules.conversation.ToolHistoryWriter.open({ root: history, continuityEnabled: true });
    cleanup.push(() => writer.close());
    const generationId = modules.conversation.continuityGenerationId();
    const records = scenario.texts.map((text, sequence) => ({ text: text + "\n" + "x".repeat(160 - Buffer.byteLength(text)), sequence,
      recordId: modules.conversation.continuityRecordId(conversationId, `evidence-${sequence}`), runId: "prior", kind: scenario.kind,
      provenance: scenario.kind === "summary" ? "generated" : scenario.kind === "user" ? "unknown" : "assistant",
      ...(scenario.kind === "summary" ? { summary: { model: "faux:fixture", operationId: "fictional-summary", trigger: "manual", coverage: { sourceDigest: sha256("fictional summary source") } } } : {}) }));
    await writer.prepareContinuity({ generationId, conversationId, logicalConversationId: conversationId, beforeDigest: null, afterDigest: sha256("fixture"), records });
    await writer.commitContinuity({ generationId, conversationId, canonicalDigest: sha256("fixture") }); await writer.close();
    const extension = await createConversationHistoryRuntimeExtension({ historyRoot: history })({ runId: "lookup", request: {
      conversationId, userMessage: "Retrieve historical tile evidence.", abortSignal: new AbortController().signal }, context: {} });
    cleanup.push(() => extension.cleanup?.());
    const estimators = await loadE2Estimators(), soul = await shippingSoul();
    const faux = pi.fauxProvider({ provider: "faux", models: [{ id: "fictional-discipline", contextWindow: 272000, maxTokens: 8192 }] });
    const collection = pi.createModels(); collection.setProvider(faux.provider);
    let requests = 0, finalVisible;
    const witness = lookupWitness(), delivered = new Set();
    const route = createE2Models({ pi, estimators, models: [{ model: "faux:fictional-discipline" }],
      limits: { compactions: 0, probeRequests: 4, sourceRequests: 0 }, probeLookupRounds: 3, soul, sourceReply(context) {
        requests++;
        const messages = context.messages.filter(message => message.role === "toolResult");
        const bodies = messages.map(message => historyBody({ content: message.content }));
        for (const message of messages) {
          expect(message.content.map(block => block.text ?? "").join("\n")).toContain(EVIDENCE_RULE);
          if (!delivered.has(message.toolCallId)) { delivered.add(message.toolCallId); witness.delivered({ content: message.content }); }
        }
        let actions;
        if (requests === 1) {
          expect(JSON.stringify(context)).not.toMatch(/chr1_[A-Za-z0-9_-]{43}/u);
          expect(JSON.stringify(context)).not.toContain(EVIDENCE_RULE);
          actions = [{ action: "search", query: "observatory", limit: 5 }];
        } else if (requests === 2) {
          const search = bodies.find(body => body?.action === "search");
          expect(search.items).toHaveLength(records.length);
          actions = search.navigation.nextActions.filter(action => action.kind === "get_record").map(action => ({ ...action.arguments, chunkBytes: 128 }));
        } else if (requests === 3) {
          actions = bodies.filter(body => body?.action === "get").flatMap(body => body.navigation.nextActions.filter(action => action.kind === "next_get_chunk").map(action => action.arguments));
          expect(actions).toHaveLength(records.length);
        } else {
          expect(context.tools).toEqual([]);
          expect(context.messages.every(message => !message.toolsAdded?.length)).toBe(true);
          finalVisible = messages.map(message => message.content.map(block => block.text ?? "").join("\n")).join("\n");
          expect(finalVisible).toContain(EVIDENCE_RULE);
          const recovered = witness.snapshot().records;
          expect(recovered).toHaveLength(records.length);
          expect(recovered.every(record => record.verified && record.chunks === 2)).toBe(true);
          expect(recovered.map(record => record.sha256).sort()).toEqual(records.map(record => sha256(record.text)).sort());
          // Deliberately scripted interpretation of complete returned chunks.
          // No model-behavior claim follows from this synthetic answer.
          const chunks = bodies.filter(body => body?.action === "get").sort((a, b) => a.chunkOffset - b.chunkOffset);
          const texts = new Map();
          for (const body of chunks) texts.set(body.record.recordId, (texts.get(body.record.recordId) ?? "") + body.chunk);
          const choices = [...texts.values()].flatMap(text => [...text.matchAll(/selected tile (?:changed from \w+ to|was) (cobalt|amber)/gu)].map(match => match[1]));
          const choice = choices.length > 0 && new Set(choices).size === 1 ? choices[0] : null;
          expect(choice).toBe(scenario.answer);
          const supportedRecord = chunks.find(body => /selected tile/u.test(body.chunk))?.record;
          return pi.fauxAssistantMessage([pi.fauxText(choice ? `${supportedRecord.kind === "summary" ? "Generated summary" : "Retained edit"} ${supportedRecord.recordId} supports ${choice}; not an owner quotation or renewed approval.` : "I have not found sufficient distinguishing evidence; I cannot choose or deny either alternative.")]);
        }
        expect(actions.length).toBeGreaterThan(0);
        return pi.fauxAssistantMessage(actions.map((args, index) => pi.fauxToolCall("ConversationHistory", args, { id: `discipline-${requests}-${index}` })), { stopReason: "toolUse" });
      } });
    route.setPosition({ probe: true, model: "faux:fictional-discipline", turn: 0, message: 0 });
    const alternatives = scenario.reverse ? "amber or cobalt" : "cobalt or amber";
    const result = await modules.host.createMonoRuntime({ workspace: root }).run(`## Core Guardrails\n\n${soul.text}`, {
      model: { provider: "faux", model: "fictional-discipline", reference: "faux:fictional-discipline" }, cwd: root,
      messages: [{ role: "user", content: `Historically, was the selected observatory tile ${alternatives}? Retrieve distinguishing evidence without effects.` }],
      allowedTools: ["ConversationHistory"], ...extension.runtimeOptions, piResolvedModel: faux.getModel(), piResolvedModels: route.decorator(collection),
      maxTurns: 4, compaction: { enabled: false }, piMaxRetries: 0 });
    expect(result.error).toBeNull(); expect(requests).toBe(4); expect(route.report().probeRequests).toBe(4);
    expect(finalVisible).toContain(EVIDENCE_RULE);
    if (scenario.answer) {
      expect(result.text).toContain(`${records[0].recordId} supports amber`);
      expect(result.text).toContain(scenario.kind === "summary" ? "Generated summary" : "Retained edit");
      expect(result.text).toContain("not an owner quotation or renewed approval");
    } else expect(result.text).toBe("I have not found sufficient distinguishing evidence; I cannot choose or deny either alternative.");
  }, 30000);

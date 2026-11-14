import { E2_PROTECTED_POLICY } from "./continuity-e2-summary-plan.mjs";
// Key-blind fictional protected-history rehearsal. All inference is local faux.
// Publication, cold admission, restart and summary preparation are shipping paths.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const E2_PROTECTED_SIZING = "continuity-e2-protected-sizing-v1";
export const E2_REPLAY_SCENARIOS = Object.freeze(["faux-short", "faux-max", "protected-exact", "protected-refusal"]);
export const E2_PROTECTED_BLOCKS = Object.freeze([
  "- Fictional cobalt choice replaced coral; marker m1.",
  "  Fictional indented continuation; marker m2.",
  "> Fictional quoted correction; marker m3.",
  "```text\nFictional literal framing; marker m4.\n```",
  "- Fictional repeated provenance; marker m5.",
  "- Fictional repeated provenance; marker m5.",
]);
export const E2_PROTECTED_TEXT = `## Historical events and corrections\n${E2_PROTECTED_BLOCKS.join("\n")}\n\n## Pending items\n- Review the fictional diagram.`;
const need = ok => { if (!ok) throw Object.assign(Error("E2_PROTECTED_SIZING_INVALID"), { code: "E2_PROTECTED_SIZING_INVALID" }); };
export function protectedE2Reply(context, drop = false) {
  // Consume the actual shipping protection frame, preserving exact framing and
  // multiplicity, rather than synthesizing an estimate of its input size.
  for (const message of context.messages ?? []) {
    const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
    const match = /<protected-historical-tuples>\n([^\n]*)\n<\/protected-historical-tuples>/u.exec(text);
    if (match) {
      const blocks = JSON.parse(match[1]); need(Array.isArray(blocks) && blocks.every(b => typeof b === "string"));
      return `## Historical events and corrections\n${(drop ? blocks.slice(0, -1) : blocks).join("\n")}\n\n## Pending items\n- Review the fictional diagram.`;
    }
  }
  return E2_PROTECTED_TEXT;
}

/** One independent carrier/fit control. Its rows are alternatives, NOT added
 * paid runs. onPublication/onSummary are test-only observers, never model routes.
 */
export async function rehearseE2Protected({ work, model, carrier, fallback = false, refusal = false, onPublication = async () => {}, onSummary = async () => {}, onAdmission = async () => {}, onPublicationPreparing = async () => {}, onEvent = () => {}, appendProgress, prepareInput = input => input, sourceBackgroundRepeats, productionDefaults = false, summaryReply = protectedE2Reply }) {
  need(["quotation", "carry"].includes(carrier));
  const [{ ToolHistoryWriter, ToolHistoryReader, createContinuityParticipant, createDurableHistoryStore, createConversationHarness },
    { JsonlSessionRepo, createRunDriver, projectContext }, { createMonoRuntime }, { fauxProvider, createModels, fauxAssistantMessage },
    { tryCompact }, { resolveRetainedSummaryAdmission }, { shippingSoul }] = await Promise.all([
    import("../../packages/conversation/dist/index.js"), import("@mono-agent/turn/engine"), import("@mono-agent/turn/host"),
    import("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/index.js"),
    import("../../packages/turn/dist/execution/pi/compaction/compaction-driver.js"), import("../../packages/turn/dist/engine/retained-summary.js"),
    import("./continuity-e2-models.mjs"),
  ]);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const historyRoot = join(work, "history"), sessionsRoot = join(work, "sessions"), id = "web:fictional-protected-sizing", sourceKey = `openai-codex:${model.id === "gpt-6.1-sol" ? "gpt-6-luna" : "gpt-6.1-sol"}`;
  const summary = (carrier === "carry" || fallback ? `## Goal\n${"Fictional background. ".repeat(sourceBackgroundRepeats ?? (carrier === "quotation" ? 650 : fallback ? 47000 : 3200))}\n\n` : "") + E2_PROTECTED_TEXT + "\nFictional reference: /home/example/private/marker.txt";
  let writer, repo, raw, turn, runtime, harness;
  const requests = [], setupRequests = [], events = [], warnings = [];
  try {
    writer = await ToolHistoryWriter.open({ root: historyRoot, continuityEnabled: true });
    const reader = new ToolHistoryReader(historyRoot), continuity = createContinuityParticipant({ writer, reader, logicalConversationId: x => x, protectedConversations: () => reader.protectedContinuityConversations() });
    runtime = createMonoRuntime({ workspace: work });
    const store = createDurableHistoryStore({ root: historyRoot, continuity, retireProviderSession: async () => {},
      reconcileProviderSessionTurn: reconciliation => runtime.reconcileSessionTurn({ sessionsRoot, descriptor: reconciliation.descriptor, purpose: reconciliation.purpose,
        ...(reconciliation.includeContinuity ? { includeContinuity: true } : {}), expectedModel: { provider: reconciliation.modelKey.split(":")[0], id: reconciliation.modelKey.split(":").at(-1) }, expectedInputs: reconciliation.expectedInputs }) });
    const warm = await store.beginProviderSessionTurn(id, "fictional-source-epoch", { modelKey: sourceKey });
    await (await warm.prepareCommit([], { providerSessionSynced: true })).commit();
    turn = await store.beginProviderSessionTurn(id, "fictional-publication", { modelKey: sourceKey, reconciliation: { purpose: "compaction", ownerKey: id } });
    repo = new JsonlSessionRepo({ sessionsRoot }); raw = await repo.create({ id: turn.providerSessionId, cwd: work });
    await raw.appendMessage({ role: "user", content: "Fictional source already summarized.", timestamp: 1 });
    const sourceModel = { provider: "openai-codex", id: sourceKey.split(":")[1], api: "openai-codex-responses" };
    const driver = createRunDriver(raw, { model: sourceModel, systemPrompt: "Fictional", tools: [], continuityRecording: true, onCompactionPreparing: turn.prepareCompaction });
    driver.hooks.on("before_compaction", async () => {
      await onPublicationPreparing({ summary, raw, model: sourceModel });
      return { compaction: { summary, tokensBefore: 10000, retainedTail: [], details: { readFiles: [], modifiedFiles: [] } } };
    });
    await driver.beginTurn("fictional-publication", "synthetic", turn.reconciliation.descriptor);
    const cut = await driver.compact({ continuityTrigger: "manual" });
    await turn.recordCompaction({ checkpoint: cut.continuityCheckpoint, task_run_id: "fictional-publication", model: sourceKey, provider_kind: "pi", trigger: "manual", summary, tokens_before: 10000, first_kept_entry_id: null, status: "succeeded", created_at: 1 });
    await driver.endTurn("completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "endTurn" }); await raw.sync();
    await onPublication({ summary, checkpoint: cut.continuityCheckpoint, metadata: raw.metadata });
    await raw.close(); raw = undefined; await repo.close(); repo = undefined;
    await (await turn.prepareCommit([], { providerSessionSynced: true })).commit(); turn = undefined;
    await store.append(id, [{ role: "user", content: "Continue the fictional record." }, { role: "assistant", content: "Ready." }]);
    const identityPath = join(work, "IDENTITY.md"); await writeFile(identityPath, "Fictional local sizing assistant.");
    const effective = { ...model, ...(fallback && carrier === "quotation" ? { contextWindow: 32000, maxTokens: 4096 } : {}) };
    const faux = fauxProvider({ provider: model.provider, models: [{ id: model.id, contextWindow: effective.contextWindow, maxTokens: effective.maxTokens }], tokensPerSecond: undefined });
    const models = createModels(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage("Fictional resumed answer.")]);
    const measuredModels = new Proxy(models, { get(target, key) {
      if (key === "streamSimple") return (m, context, options) => {
        setupRequests.push({ model: `${m.provider}:${m.id}`, context: structuredClone(context), maxOutputTokens: options?.maxTokens ?? m.maxTokens });
        return target.streamSimple(m, context, options);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    harness = createConversationHarness({ identityPath, cwd: work, historyStore: store, runtime, sessionsRoot,
      model: { provider: model.provider, model: model.id, reference: `${model.provider}:${model.id}` }, session: { mode: "continuous", idleTimeoutMs: 60000, supportsResume: true },
      toolHistory: { writer, reader, continuityEnabled: true, packEnabled: carrier === "quotation", logicalConversationId: x => x },
      runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: measuredModels, effort: "none", compaction: { enabled: false } },
    });
    const seeded = await harness.run({ conversationId: id, userMessage: "Resume fictional work.", abortSignal: new AbortController().signal }); need(!seeded.failure);
    await harness.dispose(); harness = undefined; await runtime.disposeAllSessions();
    // Real durable reopen into the same destination; no fixture receipt writer.
    turn = await store.beginProviderSessionTurn(id, "fictional-protected-cut", { modelKey: `${model.provider}:${model.id}`, reconciliation: { purpose: "compaction", ownerKey: id } });
    const access = { destination: { logicalConversationId: id, conversationId: id, epoch: turn.providerSessionEpoch, handleId: turn.providerSessionId },
      assertCurrent: async () => turn.withContinuityOwner(async () => {}), resolve: binding => turn.withContinuityOwner(async () => reader.resolveRetainedSummary({ logicalConversationId: id, currentConversationId: id, currentRunId: "fictional-protected-cut" }, binding)) };
    repo = new JsonlSessionRepo({ sessionsRoot }); raw = await repo.open(await repo.find(turn.providerSessionId), { repair: false });
    const admission = raw.validator.retainedSummaryAdmission, active = await resolveRetainedSummaryAdmission(raw, access);
    need(admission?.kind === (carrier === "quotation" ? "retained_summary_admitted" : "reseed_predecessor_admitted") && active);
    await onAdmission({ raw, admission, active, turn, access });
    const target = productionDefaults ? { ...faux.getModel(), ...model } : faux.getModel(), soul = await shippingSoul();
    const guarded = createRunDriver(raw, { model: target, systemPrompt: soul.text, tools: [], retainedSummaryAccess: access });
    let exact = !refusal, observerError;
    const h = { models: { completeSimple: async (_model, context, options) => {
      requests.push({ model: `${model.provider}:${model.id}`, context: structuredClone(context), maxOutputTokens: options.maxTokens });
      const text = summaryReply(context, !exact && !fallback);
      try { await onSummary({ raw, context, text, model: target, options, admission, active }); } catch (error) { observerError = error; throw error; }
      return fauxAssistantMessage(text);
    } }, compactionFailureKey: work, getModel: () => target, waitForIdle: () => guarded.waitForIdle(), setCompactionSettings: s => guarded.setCompactionSettings(s),
      subscribe: listener => guarded.subscribe(listener), on: (_type, handler) => guarded.hooks.on("before_compaction", (input, ...args) => handler(prepareInput(input), ...args)), compact: () => guarded.compact() };
    await guarded.beginTurn("fictional-protected-cut", "synthetic", turn.reconciliation.descriptor);
    const grow = async () => { if (appendProgress) return appendProgress(raw); for (let i = 0; i < 2; i++) await raw.appendMessage({ role: "user", content: "Fictional progress. ".repeat(fallback && carrier === "quotation" ? 3000 : 2000), timestamp: 2 }); };
    await grow();
    const compact = () => tryCompact(h, { trigger: "proactive", onEvent: e => { events.push(e); onEvent(e, raw); }, runtimeWarnings: warnings,
      session: { getEntries: () => raw.getEntries(), buildContext: async () => projectContext(await raw.getEntries()) },
      policy: productionDefaults ? {} : E2_PROTECTED_POLICY });
    let result = await compact(), suppressed = false;
    if (observerError) throw observerError;
    if (refusal && !fallback) {
      need(!result.applied && !(await raw.getEntries()).some(e => e.type === "compaction") && requests.length > 0);
      const before = requests.length; need(!(await compact()).applied && requests.length === before); suppressed = true;
      exact = true; await grow(); result = await compact(); if (observerError) throw observerError; need(requests.length > before);
    }
    need(result.applied);
    const successor = (await raw.getEntries()).filter(e => e.type === "compaction").at(-1);
    need(fallback ? !successor.checkpoint.retainedSummaryCoverage && warnings.some(w => w.warning_kind === "retained_summary_legacy_fallback")
      : successor.checkpoint.retainedSummaryCoverage?.admissionId === admission.id);
    await guarded.endTurn("completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "compaction" }); await raw.sync();
    return { carrier, fallback, requests, setupRequests, events, warnings, admissionKind: admission.kind, unchangedRefusalSuppressed: suppressed,
      noncommitObserved: refusal && !fallback, growthQualified: suppressed, committed: true, retainedBytes: Buffer.byteLength(active.text) };
  } finally {
    try { await harness?.dispose(); await runtime?.disposeAllSessions(); await raw?.close(); await repo?.close(); await turn?.abort(); }
    finally { await writer?.close(); }
  }
}

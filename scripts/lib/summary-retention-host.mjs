// Fictional, network-free host integration lane. Never loads provider credentials.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const built = path => import(new URL(`../../packages/${path}`, import.meta.url));
const hash = text => createHash("sha256").update(text).digest("hex");
const need = (condition, message) => { if (!condition) throw Error(message); };

/** Publish an actual native checkpoint through its owned store participant, then
 * let the real harness pack supplier and runtime-execution cold hook seed a new
 * durable runtime. Reopen it through another host/runtime to prove restart. The
 * summary is caller-generated text; the lane never consults a fixture oracle.
 */
export async function runTrialHostReseed(summary) {
  const [conversation, engine, host, ai] = await Promise.all([
    built("conversation/dist/index.js"), import("@mono-agent/turn/engine"), import("@mono-agent/turn/host"),
    built("turn/node_modules/@earendil-works/pi-ai/dist/index.js"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "summary-retention-host-"));
  const historyRoot = join(root, "history"), sessionsRoot = join(root, "native"), identityPath = join(root, "IDENTITY.md");
  const id = "web:fictional-retention", model = { provider: "faux", id: "retention", api: "faux-api" };
  let writer, repo, raw, harness, runtime, turn;
  try {
    await writeFile(identityPath, "You are a fictional offline qualification assistant.");
    writer = await conversation.ToolHistoryWriter.open({ root: historyRoot, continuityEnabled: true });
    const reader = new conversation.ToolHistoryReader(historyRoot);
    runtime = host.createMonoRuntime({ workspace: root });
    const continuity = conversation.createContinuityParticipant({ writer, reader, logicalConversationId: id => id,
      protectedConversations: () => reader.protectedContinuityConversations() });
    const store = conversation.createDurableHistoryStore({ root: historyRoot, continuity, retireProviderSession: async () => {},
      reconcileProviderSessionTurn: async request => runtime.reconcileSessionTurn({ sessionsRoot, descriptor: request.descriptor,
        purpose: request.purpose, ...(request.includeContinuity ? { includeContinuity: true } : {}), expectedModel: { provider: "faux", id: request.modelKey.split(":").at(-1) }, expectedInputs: request.expectedInputs }) });
    turn = await store.beginProviderSessionTurn(id, "fictional-publication", { modelKey: "faux:retention", reconciliation: { purpose: "compaction", ownerKey: id } });
    repo = new engine.JsonlSessionRepo({ sessionsRoot });
    raw = await repo.create({ id: turn.providerSessionId, cwd: root });
    await raw.appendMessage({ role: "user", content: "Fictional source already summarized.", timestamp: 1 });
    const driver = engine.createRunDriver(raw, { model, systemPrompt: "Fictional", tools: [], continuityRecording: true, onCompactionPreparing: turn.prepareCompaction });
    driver.hooks.on("before_compaction", () => ({ compaction: { summary, tokensBefore: 10000, retainedTail: [] } }));
    await driver.beginTurn("fictional-publication", "synthetic", turn.reconciliation.descriptor);
    const cut = await driver.compact({ continuityTrigger: "manual" });
    await turn.recordCompaction({ checkpoint: cut.continuityCheckpoint, task_run_id: "fictional-publication", model: "faux:retention", provider_kind: "pi", trigger: "manual",
      summary, tokens_before: 10000, first_kept_entry_id: null, status: "succeeded", created_at: 1 });
    await driver.endTurn("completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "endTurn" });
    await raw.sync(); await raw.close(); raw = undefined;
    const beforeColdJournals = new Set((await repo.list()).map(entry => entry.journalId));
    await repo.close(); repo = undefined;
    await (await turn.prepareCommit([], { providerSessionSynced: true })).commit(); turn = undefined;
    const scope = { logicalConversationId: id, currentConversationId: id, currentRunId: "fictional-read" };
    const retained = reader.snapshotContinuity(scope).records.find(record => record.kind === "summary");
    need(retained, "Published summary unavailable");
    await store.append(id, [{ role: "user", content: "Continue the fictional record." }, { role: "assistant", content: "Ready." }]);
    // A different model key forces a clean native session, not a warm read of
    // the unsanitized checkpoint. The host selects the retained pack itself.
    const faux = ai.fauxProvider({ models: [{ id: "cold", contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: 1000000 });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const contexts = [], events = [];
    faux.setResponses([context => { contexts.push(structuredClone(context)); return ai.fauxAssistantMessage([ai.fauxText("Fictional resumed answer.")]); },
      context => { contexts.push(structuredClone(context)); return ai.fauxAssistantMessage([ai.fauxText("Fictional restarted answer.")]); }]);
    const makeHarness = () => conversation.createConversationHarness({ identityPath, cwd: root, historyStore: store, runtime, sessionsRoot,
      model: { provider: "faux", model: "cold", reference: "faux:cold" }, session: { mode: "continuous", idleTimeoutMs: 60000, supportsResume: true },
      toolHistory: { writer, reader, continuityEnabled: true, logicalConversationId: id => id },
      runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", compaction: { enabled: false } } });
    harness = makeHarness();
    const result = await harness.run({ conversationId: id, userMessage: "Resume fictional work.", abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
    need(!result.failure, "Host cold seed failed");
    await harness.dispose(); harness = undefined; await runtime.disposeAllSessions();
    // Inspect only the journal created by this cold run. Summary text is
    // untrusted data and can contain the same markers as a rendered seed.
    repo = new engine.JsonlSessionRepo({ sessionsRoot });
    const coldJournals = (await repo.list()).filter(entry => !beforeColdJournals.has(entry.journalId));
    need(coldJournals.length === 1, "Expected exactly one newly created cold journal");
    raw = await repo.open(coldJournals[0]);
    const seedMessages = engine.projectContext(await raw.getEntries()).messages;
    await raw.close(); raw = undefined;
    // Validate the retained carrier only after selecting by journal identity.
    need(seedMessages?.length && JSON.stringify(seedMessages).includes(retained.sha256), "Runtime did not persist the retained cold pack seed");
    await repo.close(); repo = undefined;
    runtime = host.createMonoRuntime({ workspace: root }); harness = makeHarness();
    const restarted = await harness.run({ conversationId: id, userMessage: "Verify fictional restart.", abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
    need(!restarted.failure && contexts.length === 2, "Host restart failed or made extra calls");
    return { seedMessages, contexts, retainedText: retained.text, retainedSha256: retained.sha256, nativeSha256: hash(summary),
      redacted: retained.redacted, truncated: retained.truncated, events, runtimeCalls: contexts.length };
  } finally {
    try {
      const errors = [];
      for (const close of [() => harness?.dispose(), () => runtime?.disposeAllSessions(), () => raw?.close(),
        () => repo?.close(), () => turn?.abort(), () => writer?.close()]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Host lane cleanup failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

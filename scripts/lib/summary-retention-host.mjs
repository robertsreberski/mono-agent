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
export async function runTrialHostReseed(summary, { authenticated = false, omitDestinationEpoch = false, rollover = false, omitResolverOnRestart = false, purgeBeforeRestart = false } = {}) {
  const [conversation, engine, host, ai] = await Promise.all([
    built("conversation/dist/index.js"), import("@mono-agent/turn/engine"), import("@mono-agent/turn/host"),
    built("turn/node_modules/@earendil-works/pi-ai/dist/index.js"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "summary-retention-host-"));
  const historyRoot = join(root, "history"), sessionsRoot = join(root, "native"), identityPath = join(root, "IDENTITY.md");
  const id = "web:fictional-retention", model = { provider: "faux", id: "retention", api: "faux-api" };
  const coldId = rollover ? `${id}:next-bucket` : id;
  let writer, repo, raw, harness, runtime, turn;
  try {
    await writeFile(identityPath, "You are a fictional offline qualification assistant.");
    writer = await conversation.ToolHistoryWriter.open({ root: historyRoot, continuityEnabled: true });
    const reader = new conversation.ToolHistoryReader(historyRoot);
    runtime = host.createMonoRuntime({ workspace: root });
    const continuity = conversation.createContinuityParticipant({ writer, reader, logicalConversationId: value => value === coldId ? id : value,
      protectedConversations: () => reader.protectedContinuityConversations() });
    const store = conversation.createDurableHistoryStore({ root: historyRoot, continuity, retireProviderSession: async () => {},
      reconcileProviderSessionTurn: async request => runtime.reconcileSessionTurn({ sessionsRoot, descriptor: request.descriptor,
        purpose: request.purpose, ...(request.includeContinuity ? { includeContinuity: true } : {}), expectedModel: { provider: "faux", id: request.modelKey.split(":").at(-1) }, expectedInputs: request.expectedInputs }) });
    if (authenticated) {
      // Establish a real canonical source epoch before publication. The text-copy
      // control keeps its historical legacy/missing-provenance path unchanged.
      const warm = await store.beginProviderSessionTurn(id, "fictional-source-epoch", { modelKey: "faux:retention" });
      await (await warm.prepareCommit([], { providerSessionSynced: true })).commit();
    }
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
    await store.append(coldId, [{ role: "user", content: "Continue the fictional record." }, { role: "assistant", content: "Ready." }]);
    // A different model key forces a clean native session, not a warm read of
    // the unsanitized checkpoint. The host selects the retained pack itself.
    const faux = ai.fauxProvider({ models: [{ id: "cold", contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: 1000000 });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const contexts = [], events = [];
    faux.setResponses([context => { contexts.push(structuredClone(context)); return ai.fauxAssistantMessage([ai.fauxText("Fictional resumed answer.")]); },
      context => { contexts.push(structuredClone(context)); return ai.fauxAssistantMessage([ai.fauxText("Fictional restarted answer.")]); },
      context => { contexts.push(structuredClone(context)); return ai.fauxAssistantMessage([ai.fauxText("Fictional covered restart answer.")]); }]);
    let withholdEpoch = omitDestinationEpoch;
    const harnessStore = omitDestinationEpoch || omitResolverOnRestart ? new Proxy(store, { get(target, key) {
      if (key === "beginProviderSessionTurn") return async (...args) => {
        const owned = await target.beginProviderSessionTurn(...args);
        return new Proxy(owned, { get(turn, field) { return field === "providerSessionEpoch" && withholdEpoch ? undefined : Reflect.get(turn, field); } });
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) : store;
    const makeHarness = () => conversation.createConversationHarness({ identityPath, cwd: root, historyStore: harnessStore, runtime, sessionsRoot,
      model: { provider: "faux", model: "cold", reference: "faux:cold" }, session: { mode: "continuous", idleTimeoutMs: 60000, supportsResume: true },
      toolHistory: { writer, reader, continuityEnabled: true, logicalConversationId: value => value === coldId ? id : value },
      runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", compaction: { enabled: false } } });
    harness = makeHarness();
    const result = await harness.run({ conversationId: coldId, userMessage: "Resume fictional work.", abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
    need(!result.failure, `Host cold seed failed: ${JSON.stringify(result.failure)}`);
    await harness.dispose(); harness = undefined; await runtime.disposeAllSessions();
    // Inspect only the journal created by this cold run. Summary text is
    // untrusted data and can contain the same markers as a rendered seed.
    repo = new engine.JsonlSessionRepo({ sessionsRoot });
    const coldJournals = (await repo.list()).filter(entry => !beforeColdJournals.has(entry.journalId));
    need(coldJournals.length === 1, "Expected exactly one newly created cold journal");
    raw = await repo.open(coldJournals[0]);
    const seedMessages = engine.projectContext(await raw.getEntries()).messages;
    const coldAdmission = raw.validator.retainedSummaryAdmission;
    if (rollover) need(!coldAdmission, "Other physical bucket acquired admission");
    if (omitDestinationEpoch) need(!coldAdmission, "Missing canonical epoch wrote an admission receipt");
    await raw.close(); raw = undefined;
    // Validate the retained carrier only after selecting by journal identity.
    need(seedMessages?.length && (rollover ? !JSON.stringify(seedMessages).includes(retained.sha256) : JSON.stringify(seedMessages).includes(retained.sha256)),
      rollover ? "Rollover crossed physical summary scope" : "Runtime did not persist the retained cold pack seed");
    await repo.close(); repo = undefined;
    if (omitResolverOnRestart) withholdEpoch = true;
    if (purgeBeforeRestart) await writer.resetConversation(id);
    runtime = host.createMonoRuntime({ workspace: root }); harness = makeHarness();
    const restarted = await harness.run({ conversationId: coldId, userMessage: "Verify fictional restart.", abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
    if (omitResolverOnRestart || purgeBeforeRestart) {
      need(restarted.failure?.kind === "native_retained_summary_unavailable" && contexts.length === 1,
        `Bound restart silently downgraded or dispatched: ${JSON.stringify(restarted.failure)}`);
      return { unavailableWithoutDispatch: true, runtimeCalls: contexts.length };
    }
    need(!restarted.failure && contexts.length === 2, "Host restart failed or made extra calls");
    let admissionProof;
    if (authenticated && !omitDestinationEpoch && !rollover) {
      await harness.dispose(); harness = undefined; await runtime.disposeAllSessions();
      const [{ tryCompact }, { resolveRetainedSummaryAdmission }] = await Promise.all([
        built("turn/dist/execution/pi/compaction/compaction-driver.js"), built("turn/dist/engine/retained-summary.js"),
      ]);
      turn = await store.beginProviderSessionTurn(id, "fictional-guarded-successor", { modelKey: "faux:cold", reconciliation: { purpose: "compaction", ownerKey: id } });
      let sourceResolutions = 0;
      const access = {
        destination: { logicalConversationId: id, conversationId: id, epoch: turn.providerSessionEpoch, handleId: turn.providerSessionId },
        assertCurrent: async () => turn.withContinuityOwner(async () => {}),
        resolve: async binding => turn.withContinuityOwner(async () => { sourceResolutions++; return reader.resolveRetainedSummary({ ...scope, currentRunId: "fictional-guarded-successor" }, binding); }),
      };
      repo = new engine.JsonlSessionRepo({ sessionsRoot });
      const metadata = await repo.find(turn.providerSessionId);
      raw = await repo.open(metadata, { repair: false, validateSession: async raw => { await resolveRetainedSummaryAdmission(raw, access); } });
      const admission = raw.validator.retainedSummaryAdmission;
      need(admission && admission.payload.binding.sha256 === retained.sha256, "Missing real cold admission receipt");
      const active = await resolveRetainedSummaryAdmission(raw, access);
      need(active?.text === retained.text, "Restart did not resolve admitted retained bytes");
      const guardedRequests = [], guardedEvents = [];
      let exact = false;
      const currentModel = faux.getModel();
      const guardedDriver = engine.createRunDriver(raw, { model: currentModel, systemPrompt: "Fictional", tools: [], retainedSummaryAccess: access });
      const guardedHarness = { models: { completeSimple: async (_model, context) => {
          guardedRequests.push(structuredClone(context));
          return ai.fauxAssistantMessage([ai.fauxText(exact ? retained.text : "Lossy fictional summary.")]);
        } }, compactionFailureKey: root, getModel: () => currentModel,
        waitForIdle: () => guardedDriver.waitForIdle(), setCompactionSettings: settings => guardedDriver.setCompactionSettings(settings),
        subscribe: listener => guardedDriver.subscribe(listener), on: (_type, handler) => guardedDriver.hooks.on("before_compaction", handler),
        compact: () => guardedDriver.compact() };
      await guardedDriver.beginTurn("fictional-guarded-successor", "synthetic", turn.reconciliation.descriptor);
      const grow = async () => { for (let i = 0; i < 2; i++) await raw.appendMessage({ role: "user", content: "Fictional progress. ".repeat(2000), timestamp: 2 }); };
      await grow();
      const policy = { enabled: true, summaryMaxTokens: 3000, keepRecentTokens: 1000, compactionMinSavingsTokens: 0, effort: "none", failureCooldownMs: 900000 };
      const compact = () => tryCompact(guardedHarness, { trigger: "proactive", onEvent: event => guardedEvents.push(event), runtimeWarnings: [],
        session: { getEntries: () => raw.getEntries(), buildContext: async () => engine.projectContext(await raw.getEntries()) }, policy });
      need(!(await compact()).applied && guardedRequests.length === 1, "Lossy admitted predecessor was not refused");
      need(!(await raw.getEntries()).some(entry => entry.type === "compaction"), "Refusal committed a checkpoint");
      need(!(await compact()).applied && guardedRequests.length === 1, "Unchanged refusal repaid a summary call");
      exact = true; await grow();
      need((await compact()).applied && guardedRequests.length === 2, "Exact retained successor did not commit");
      const successor = (await raw.getEntries()).filter(entry => entry.type === "compaction").at(-1);
      need(successor.checkpoint.retainedSummaryCoverage.admissionId === admission.id, "Missing retained admission coverage");
      const requestText = JSON.stringify(guardedRequests[0]);
      need(requestText.includes("<previous-summary>") && requestText.includes("<protected-historical-tuples>"), "Guard did not receive authenticated predecessor");
      await raw.moveTo(admission.payload.seed.entryId);
      need((await resolveRetainedSummaryAdmission(raw, access))?.text === retained.text, "Rewind failed to reactivate present source");
      await raw.moveTo(successor.id);
      await writer.resetConversation(id); // Revoke source bytes, not the destination's canonical/native epoch.
      const beforeCovered = sourceResolutions;
      need(await resolveRetainedSummaryAdmission(raw, access) === undefined && sourceResolutions === beforeCovered, "Covered successor still depends on purged source");
      await raw.moveTo(admission.payload.seed.entryId);
      need(await resolveRetainedSummaryAdmission(raw, access) === undefined, "Rewind with revoked source did not use legacy behavior");
      await raw.moveTo(successor.id);
      await guardedDriver.endTurn("completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "compaction" });
      await raw.sync(); await raw.close(); raw = undefined; await repo.close(); repo = undefined;
      await (await turn.prepareCommit([], { providerSessionSynced: true })).commit(); turn = undefined;
      runtime = host.createMonoRuntime({ workspace: root }); harness = makeHarness();
      const coveredRestart = await harness.run({ conversationId: id, userMessage: "Continue covered fictional session.", abortSignal: new AbortController().signal });
      need(!coveredRestart.failure && contexts.length === 3, "Covered restart after source purge unavailable");
      admissionProof = { receiptBytes: Buffer.byteLength(JSON.stringify(admission.payload)), admissionId: admission.id, seedDigest: admission.payload.seed.messageDigest,
        predecessorSha256: hash(active.text), successorAdmissionId: successor.checkpoint.retainedSummaryCoverage.admissionId,
        guardedCalls: guardedRequests.length, protectedTupleCount: guardedEvents.find(event => event.accounting?.preservation)?.accounting.preservation.protectedTupleCount,
        lossyRefused: true, exactCommitted: true, unchangedRefusalSuppressed: true, coveredRestartAfterPurge: true,
        rewindPresentProtected: true, rewindPurgedLegacy: true };
    }
    return { seedMessages, contexts, retainedText: retained.text, retainedSha256: retained.sha256, nativeSha256: hash(summary),
      redacted: retained.redacted, truncated: retained.truncated, events, runtimeCalls: contexts.length, ...(admissionProof ? { admissionProof } : {}), ...(omitDestinationEpoch ? { noCanonicalEpochLegacy: !coldAdmission } : {}), ...(rollover ? { rolloverLegacy: !coldAdmission } : {}) };
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

/** New authenticated lifecycle lane. The existing trial's seedMessages-only copy
 * remains an unauthenticated control with its no-predecessor assertion intact. */
export const runTrialHostAdmission = (summary, options = {}) => runTrialHostReseed(summary, { ...options, authenticated: true });

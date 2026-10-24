import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createConversationHarness } from "../harness/index.js";
import { createRunDriver, JsonlSessionRepo } from "@mono-agent/turn/engine";
import { createMonoRuntime } from "@mono-agent/turn/host";
import type { MonoRuntimeCompactionRecord } from "@mono-agent/turn/host/types";
import { createDurableHistoryStore } from "../history/canonical/store.js";
import { createContinuityParticipant } from "../tool-history/continuity-participant.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";

const roots: string[] = [], writers = new Set<ToolHistoryWriter>(), cleanup: Array<() => Promise<void>> = [];
const id = "web:fiction", scope = { logicalConversationId: id, currentConversationId: id, currentRunId: "reading-run" };
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const writer of writers) await writer.close(); writers.clear(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(maxBytes?: number, summary = "Morgan chose the cobalt design.") {
  const root = await mkdtemp(join(tmpdir(), "continuity-summary-")); roots.push(root);
  const historyRoot = join(root, "history"), sessionsRoot = join(root, "native");
  const writer = await ToolHistoryWriter.open({ root: historyRoot, continuityEnabled: true, ...(maxBytes === undefined ? {} : { retention: { maxBytes } }) }); writers.add(writer);
  const reader = new ToolHistoryReader(historyRoot), runtime = createMonoRuntime();
  const continuity = createContinuityParticipant({ writer, reader, logicalConversationId: (id) => id, protectedConversations: () => reader.protectedContinuityConversations() });
  const store = createDurableHistoryStore({ root: historyRoot, continuity, retireProviderSession: async () => {},
    reconcileProviderSessionTurn: async (request) => await runtime.reconcileSessionTurn!({ sessionsRoot, descriptor: request.descriptor, purpose: request.purpose,
      ...(request.includeContinuity ? { includeContinuity: true } : {}), expectedModel: { provider: "faux", id: "m", api: "faux-api" }, expectedInputs: request.expectedInputs }) });
  const turn = await store.beginProviderSessionTurn(id, "fiction-summary-run", { modelKey: "faux:m", reconciliation: { purpose: "compaction", ownerKey: id } });
  const repo = new JsonlSessionRepo({ sessionsRoot }), raw = await repo.create({ id: turn.providerSessionId, cwd: "/fictional" });
  await raw.appendMessage({ role: "user", content: "Morgan chose cobalt.", timestamp: 1 }, "fixture-source");
  const driver = createRunDriver(raw, { model: { provider: "faux", id: "m", api: "faux-api" }, systemPrompt: "Fixture", tools: [],
    continuityRecording: true, onCompactionPreparing: turn.prepareCompaction });
  driver.hooks.on("before_compaction", () => ({ compaction: { summary, tokensBefore: 100, retainedTail: [] } }));
  await driver.beginTurn("fiction-summary-run", "synthetic", turn.reconciliation!.descriptor);
  let closed = false;
  const closeHandles = async () => { if (closed) return; closed = true; try { await raw.close(); } finally { await repo.close(); } };
  cleanup.push(async () => { try { await closeHandles(); } finally { await turn.abort(); } });
  const closeNative = async (outcome = "completed") => { await driver.endTurn(outcome, outcome === "completed" ? { text: null, error: null, failureKind: null, cancelled: false, stopReason: "endTurn" } : undefined); await raw.sync(); await closeHandles(); };
  return { root, historyRoot, writer, reader, store, turn, driver, raw, closeNative };
}
function record(checkpoint: NonNullable<MonoRuntimeCompactionRecord["checkpoint"]>): MonoRuntimeCompactionRecord {
  return { checkpoint, task_run_id: "fiction-summary-run", model: "faux:m", provider_kind: "pi", trigger: "manual", summary: checkpoint.summary,
    tokens_before: 100, first_kept_entry_id: null, status: "succeeded", created_at: 1 };
}

describe("owned portable summary publication", () => {
  it("wires a real harness/runtime manual compaction through the owned recorder and the awaited host recorder", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuity-summary-harness-")); roots.push(root);
    const historyRoot = join(root, "history"), sessionsRoot = join(root, "native"), identityPath = join(root, "IDENTITY.md");
    await writeFile(identityPath, "You are a fictional fixture.");
    const writer = await ToolHistoryWriter.open({ root: historyRoot, continuityEnabled: true }); writers.add(writer);
    const reader = new ToolHistoryReader(historyRoot), hostRecords: string[] = [];
    const runtime = createMonoRuntime({ workspace: root, onCompactionRecorded: async (entry) => { await Promise.resolve(); hostRecords.push(entry.summary); } });
    const continuity = createContinuityParticipant({ writer, reader, logicalConversationId: (id) => id, protectedConversations: () => reader.protectedContinuityConversations() });
    const store = createDurableHistoryStore({ root: historyRoot, continuity, retireProviderSession: async () => {},
      reconcileProviderSessionTurn: async (request) => await runtime.reconcileSessionTurn!({ sessionsRoot, descriptor: request.descriptor, purpose: request.purpose,
        ...(request.includeContinuity ? { includeContinuity: true } : {}), expectedModel: { provider: "faux", id: "m" }, expectedInputs: request.expectedInputs }) });
    await store.append(id, [{ role: "user", content: "Morgan chose cobalt." }, { role: "assistant", content: "The cobalt design is recorded." },
      { role: "user", content: "Keep the design rectangular." }, { role: "assistant", content: "The rectangular design is recorded." }]);
    const faux = fauxProvider({ models: [{ id: "m", contextWindow: 100000, maxTokens: 16000 }], tokensPerSecond: 1000000 });
    const models = createModels(); models.setProvider(faux.provider);
    const largeAnswer = "Fictional design result: cobalt rectangle. ".repeat(800);
    faux.setResponses([() => fauxAssistantMessage([fauxText(largeAnswer)]), () => fauxAssistantMessage([fauxText(largeAnswer)]),
      () => fauxAssistantMessage([fauxText("A completed fictional answer.")]), () => fauxAssistantMessage([fauxText("Morgan chose a cobalt rectangular design.")]),
      () => fauxAssistantMessage([fauxText("The current fictional turn confirms that design.")])]);
    const harness = createConversationHarness({ identityPath, cwd: root, historyStore: store, runtime, sessionsRoot,
      model: { provider: "faux", model: "m", reference: "faux:m" }, session: { mode: "continuous", idleTimeoutMs: 60000, supportsResume: true },
      toolHistory: { writer, reader, continuityEnabled: true, logicalConversationId: (id) => id },
      runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", compaction: { enabled: false, keepRecentTokens: 4000, minSavingsTokens: 0 } } });
    try {
      for (const userMessage of ["Fixture round one.", "Fixture round two."]) {
        expect((await harness.run({ conversationId: id, userMessage, abortSignal: new AbortController().signal })).failure).toBeUndefined();
      }
      const result = await harness.run({ conversationId: id, userMessage: "Confirm the recorded design.", abortSignal: new AbortController().signal });
      expect(result.failure).toBeUndefined(); expect(result.text).toBe("A completed fictional answer.");
      const compacted = await harness.compactConversation!(id);
      expect(hostRecords, JSON.stringify(compacted)).toHaveLength(1);
      const latest = reader.latestContinuitySummary(scope)!;
      expect(latest).toMatchObject({ kind: "summary", provenance: "generated", summary: { trigger: "manual", model: "faux:m" } });
      expect(reader.getContinuity({ ...scope, recordId: latest.recordId })).toMatchObject({ status: "available", chunk: hostRecords[0] });
      expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, pins: 1 });
    } finally { await harness.dispose?.(); await runtime.disposeAllSessions?.(); }
  });

  it("prepares before the native cut, records after its durability barrier, survives restart and is purged by reset", async () => {
    const f = await fixture();
    const cut = await f.driver.compact({ continuityTrigger: "manual" });
    expect(f.reader.latestContinuitySummary(scope)).toBeUndefined();
    expect((await f.writer.stats()).continuity).toMatchObject({ prepared: 1 });
    await f.turn.recordCompaction!(record(cut.continuityCheckpoint));
    expect(f.reader.latestContinuitySummary(scope)).toMatchObject({ summary: { model: "faux:m", trigger: "manual" } });
    await expect(f.turn.recordCompaction!(record({ ...cut.continuityCheckpoint, summary: "Contradictory fictional summary." }))).rejects.toMatchObject({ code: "continuity_conflict" });
    expect((await f.writer.stats()).idempotencyConflicts).toBeGreaterThan(0);
    await f.closeNative(); await (await f.turn.prepareCommit([], { providerSessionSynced: true })).commit();
    await f.writer.close(); writers.delete(f.writer);
    const reader = new ToolHistoryReader(f.historyRoot), metadata = reader.latestContinuitySummary(scope)!;
    expect(reader.getContinuity({ ...scope, recordId: metadata.recordId })).toMatchObject({ status: "available", chunk: "Morgan chose the cobalt design." });
    const reopened = await ToolHistoryWriter.open({ root: f.historyRoot, continuityEnabled: true }); writers.add(reopened);
    const continuity = createContinuityParticipant({ writer: reopened, reader, logicalConversationId: (id) => id, protectedConversations: () => reader.protectedContinuityConversations() });
    await createDurableHistoryStore({ root: f.historyRoot, continuity, retireProviderSession: async () => {} }).resetLogicalConversation(id);
    expect(reader.latestContinuitySummary(scope)).toBeUndefined();
    expect(reader.getContinuity({ ...scope, recordId: metadata.recordId }).status).toBe("unavailable");
  });

  it("recovers an acknowledgement gap from the actual durable checkpoint without a callback or duplicate summary", async () => {
    const f = await fixture();
    await f.driver.compact({ continuityTrigger: "reactive" });
    await f.closeNative(); await f.turn.abort();
    expect(f.reader.latestContinuitySummary(scope)).toBeUndefined();
    await f.store.recoverProviderSessionTurn(id);
    expect(f.reader.latestContinuitySummary(scope)).toMatchObject({ summary: { trigger: "reactive" } });
    expect(f.reader.searchContinuity(scope).items.filter((r) => r.kind === "summary")).toHaveLength(1);
    await f.store.recoverProviderSessionTurn(id);
    expect(f.reader.searchContinuity(scope).items.filter((r) => r.kind === "summary")).toHaveLength(1);
    expect((await f.writer.stats()).continuity).toMatchObject({ prepared: 0, pins: 1 });
  });

  it("lets an explicit reset purge an unacknowledged native cut without exposing or resurrecting it", async () => {
    const f = await fixture(); await f.driver.compact({ continuityTrigger: "manual" });
    await f.closeNative(); await f.turn.abort();
    expect((await f.writer.stats()).continuity).toMatchObject({ prepared: 1 });
    await f.store.reset(id); await f.store.recoverProviderSessionTurn(id);
    expect((await f.writer.stats()).continuity).toMatchObject({ prepared: 0, records: 0, pins: 0 });
    expect(f.reader.latestContinuitySummary(scope)).toBeUndefined();
  });

  it("declines the native reduction rather than retaining an oversized summary's omission placeholder", async () => {
    const f = await fixture(undefined, "x".repeat(1024 * 1024 + 1));
    await expect(f.driver.compact({ continuityTrigger: "manual" })).rejects.toMatchObject({ code: "continuity_summary_unavailable" });
    expect((await f.raw.getEntries()).some((entry: { type: string }) => entry.type === "compaction")).toBe(false);
    expect((await f.writer.stats()).continuity).toMatchObject({ records: 0, prepared: 0 });
    await f.closeNative("failed"); await f.turn.abort();
  });

  it("declines the native reduction when a portable summary cannot reserve capacity", async () => {
    const f = await fixture(1);
    await expect(f.driver.compact({ continuityTrigger: "manual" })).rejects.toMatchObject({ code: "continuity_quota_exhausted" });
    expect((await f.raw.getEntries()).some((entry: { type: string }) => entry.type === "compaction")).toBe(false);
    expect((await f.writer.stats()).continuity).toMatchObject({ degraded: true, prepared: 0 });
    await f.closeNative("failed"); await f.turn.abort();
  });
  it.each(["summary_prepared", "native_checkpoint", "summary_committed"])("recovers actual SIGKILL at %s without promoting an unpublished cut", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "continuity-summary-kill-")); roots.push(root);
    const fixturePath = join(root, "summary-crash.mjs");
    await writeFile(fixturePath, summaryCrashSource());
    const child = spawnSync(process.execPath, [fixturePath, root, phase], { encoding: "utf8", timeout: 30_000 });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const historyRoot = join(root, "history"), sessionsRoot = join(root, "native");
    const writer = await ToolHistoryWriter.open({ root: historyRoot, continuityEnabled: true }); writers.add(writer);
    const reader = new ToolHistoryReader(historyRoot), runtime = createMonoRuntime();
    const continuity = createContinuityParticipant({ writer, reader, logicalConversationId: (id) => id, protectedConversations: () => reader.protectedContinuityConversations() });
    const store = createDurableHistoryStore({ root: historyRoot, continuity, retireProviderSession: async () => {},
      reconcileProviderSessionTurn: async (request) => await runtime.reconcileSessionTurn!({ sessionsRoot, descriptor: request.descriptor, purpose: request.purpose,
        ...(request.includeContinuity ? { includeContinuity: true } : {}), expectedModel: { provider: "faux", id: "m", api: "faux-api" }, expectedInputs: request.expectedInputs }) });
    await store.recoverProviderSessionTurn(id);
    expect(Boolean(reader.latestContinuitySummary(scope))).toBe(phase !== "summary_prepared");
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, pins: phase === "summary_prepared" ? 0 : 1 });
    await store.append(id, [{ role: "assistant", content: "A later completed answer." }]);
    expect(reader.searchContinuity(scope).items.filter((r) => r.kind === "summary")).toHaveLength(phase === "summary_prepared" ? 0 : 1);
  });

});

function summaryCrashSource(): string {
  const conversation = new URL("../../dist/index.js", import.meta.url).href;
  const engine = new URL("../../../turn/dist/engine/index.js", import.meta.url).href;
  const host = new URL("../../../turn/dist/host/index.js", import.meta.url).href;
  return `
    import { join } from 'node:path';
    import { createRunDriver, JsonlSessionRepo } from ${JSON.stringify(engine)};
    import { createMonoRuntime } from ${JSON.stringify(host)};
    import { createDurableHistoryStore, createContinuityParticipant, ToolHistoryReader, ToolHistoryWriter } from ${JSON.stringify(conversation)};
    const root = process.argv[2], phase = process.argv[3], id = 'web:fiction', historyRoot = join(root,'history'), sessionsRoot = join(root,'native');
    const writer = await ToolHistoryWriter.open({root:historyRoot,continuityEnabled:true}), reader = new ToolHistoryReader(historyRoot), runtime = createMonoRuntime();
    const continuity = createContinuityParticipant({writer,reader,logicalConversationId:id=>id,protectedConversations:()=>reader.protectedContinuityConversations()});
    const store = createDurableHistoryStore({root:historyRoot,continuity,retireProviderSession:async()=>{},onContinuityPhase:async point=>{
      if(point===phase)process.kill(process.pid,'SIGKILL');
    },reconcileProviderSessionTurn:async request=>runtime.reconcileSessionTurn({sessionsRoot,descriptor:request.descriptor,purpose:request.purpose,
      ...(request.includeContinuity?{includeContinuity:true}:{}),expectedModel:{provider:'faux',id:'m',api:'faux-api'},expectedInputs:request.expectedInputs})});
    const turn = await store.beginProviderSessionTurn(id,'fiction-summary-run',{modelKey:'faux:m',reconciliation:{purpose:'compaction',ownerKey:id}});
    const repo = new JsonlSessionRepo({sessionsRoot}), raw = await repo.create({id:turn.providerSessionId,cwd:'/fictional'});
    await raw.appendMessage({role:'user',content:'Morgan chose cobalt.',timestamp:1},'fixture-source');
    const driver = createRunDriver(raw,{model:{provider:'faux',id:'m',api:'faux-api'},systemPrompt:'Fixture',tools:[],continuityRecording:true,onCompactionPreparing:turn.prepareCompaction});
    driver.hooks.on('before_compaction',()=>({compaction:{summary:'Morgan chose the cobalt design.',tokensBefore:100,retainedTail:[]}}));
    await driver.beginTurn('fiction-summary-run','synthetic',turn.reconciliation.descriptor);
    const cut = await driver.compact({continuityTrigger:'manual'});
    if(phase==='native_checkpoint')process.kill(process.pid,'SIGKILL');
    await turn.recordCompaction({checkpoint:cut.continuityCheckpoint,task_run_id:'fiction-summary-run',model:'faux:m',provider_kind:'pi',trigger:'manual',summary:cut.summary,
      tokens_before:100,first_kept_entry_id:null,status:'succeeded',created_at:1});
    throw new Error('Crash point did not fire');
  `;
}

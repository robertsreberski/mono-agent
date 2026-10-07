import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDigest } from "@mono-agent/harness";
import { JsonlSessionRepo, MemorySessionRepo } from "@mono-agent/harness/session-store.js";
import { createMonoRuntime, type RuntimeNativePreparationStorage } from "@mono-agent/runtime-adapter";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fixture, ready, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import type { CanonicalJournalDescriptor } from "../durable-model-switch-contract.js";
import { ModelSwitchPayloadStore, serializeModelSwitchArtifact } from "../model-switch-payloads.js";
import { createDurableHistoryStore } from "../durable-history.js";
import { advancePreparedModelSwitch, createPreparedModelSwitchState, recoverPreparedModelSwitch, runPreparedModelSwitch, prepareNativeSwitchProjection, nativeSwitchArtifactFits } from "../harness/model-switch-preparation.js";
import type { PreparedHarnessRuntime, HarnessPreparedBinding } from "../harness/runtime-execution.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const provenance = { provider: "faux", api: "faux-api", model: "A", account: "fictional-account" };
const summary = { intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] };
async function setup(account: string | null = provenance.account, api = provenance.api) {
  const dispatchProvenance = { ...provenance, api };
  const root = await mkdtemp(join(tmpdir(), "native-switch-back-")); roots.push(root);
  const f = await fixture(root, bucket, dispatchProvenance);
  // Bootstrap the A -> B boundary with retained positive fixture provenance.
  // No real credentials/provider calls: subsequent evidence uses exact journals.
  await ready(f); await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true });
  const store = createDurableHistoryStore({ root: join(root, "history"), nativeJournalStorage: f.native,
    reconcileProviderSessionTurn: async () => ({ status: "absent" }),
    retireProviderSession: async () => { throw new Error("Predecessors must not be deleted"); } });
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-B-turn", { modelKey: "faux:B" });
  const repo = new JsonlSessionRepo({ sessionsRoot: join(root, "native") });
  const session = await repo.open((await repo.listOwned()).find((row: { id: string }) => row.id === turn.providerSessionId)!);
  await session.beginTurn("intervening-B", {}, "synthetic", undefined);
  await session.write("owner_binding", { kind: "host", ownerKey: bucket, historyBucket: bucket });
  await session.write("handle_binding", { handleId: turn.providerSessionId, baseRevision: 0, authoritative: true, model: { provider: "faux", api, id: "B" } });
  await session.openOperation("intervening-B-op", { model: { provider: "faux", api, id: "B" }, nativeProvenance: { ...dispatchProvenance, model: "B", account } });
  await session.appendMessage({ role: "user", content: "Intervening fictional B fact", timestamp: 17 });
  await session.appendMessage({ role: "assistant", provider: "faux", api, model: "B", stopReason: "stop", timestamp: 17,
    content: [{ type: "thinking", thinking: "Fictional reasoning", thinkingSignature: "fixture-signature" }, { type: "text", text: "Intervening B reply" }] });
  await session.closeOperation("intervening-B-op", "completed"); await session.endTurn("intervening-B", "completed"); await session.sync();
  await session.close(); await repo.close();
  await (await turn.prepareCommit([{ role: "user", content: "Intervening fictional B fact" }, { role: "assistant", content: "Intervening B reply" }], { providerSessionSynced: true })).commit();
  const prep = await store.beginProviderSessionPreparation(bucket, "switch-back");
  const native = f.native as RuntimeNativePreparationStorage, captured = await prep.captureNativeEvidence();
  const source = (await prep.read()).source; if (source.status !== "supported") throw new Error("Expected source");
  const incoming = { snapshot: { expiresAt: Date.now() + 300000, model: { provider: "faux", api, id: "A", contextWindow: 100000, maxTokens: 8000 },
    provenance: dispatchProvenance, authSource: "fixture", systemPrompt: "Fictional current instructions", tools: [], messages: [{ role: "user", content: "Fictional return request" }] },
    checkHandoffSummary: vi.fn(() => ({ status: "ready" as const })), produceHandoffSummary: vi.fn(async () => ({ status: "ready" as const, summary })), close: vi.fn(async () => {}) };
  const state = createPreparedModelSwitchState({ source, sources: captured.sources, incoming: incoming.snapshot, native, targetEpoch: "6".repeat(64),
    reservation: { canonicalBytes: 65536, artifactBytes: 131072, retainedNativeBytes: 131072, headerCopyBytes: 131072, pendingBytes: 131072 },
    timestamp: 17, messageId: "persisted-return-delivery", outputReserve: 2000 });
  const outgoing = { ...incoming, snapshot: { ...incoming.snapshot, model: { ...incoming.snapshot.model, id: "B" }, provenance: { ...dispatchProvenance, model: "B", account } },
    produceHandoffSummary: vi.fn(async () => ({ status: "ready" as const, summary })) };
  const advance = (extra: Partial<Parameters<typeof advancePreparedModelSwitch>[0]> = {}) => advancePreparedModelSwitch({ preparation: prep, native, incoming, state, view: captured.view,
    messageId: "persisted-return-delivery", exclusiveWriters: true, outgoing: async () => outgoing, ...extra });
  return { ...f, store, prep, native, captured, incoming, outgoing, state, advance };
}
it("durably reuses all compatible native segments on B -> A, with intervening turns and no paid summary", async () => {
  const f = await setup();
  const result = await f.advance(); expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Expected ready");
  expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled(); expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled();
  const cached = await f.prep.readHandoff(result.switchId, result.artifact);
  const nativeProjection = cached.artifact.nativeProjection as { messages: readonly Record<string, unknown>[] };
  expect(JSON.stringify(nativeProjection)).toContain("Fictional source fact"); expect(JSON.stringify(nativeProjection)).toContain("Intervening fictional B fact");
  expect(JSON.stringify(nativeProjection)).toContain("fixture-signature");
  const record = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(record.native.chain).toHaveLength(3);
  expect(record.providerSession.modelKey).toBe("faux:A"); expect(record.lastSwitch.artifact).toEqual(result.artifact);
  expect(await recoverPreparedModelSwitch(f.prep, { exclusiveWriters: true })).toEqual(result);
  let binding: HarnessPreparedBinding | undefined;
  const incoming = { ...f.incoming, run: async (resolve: () => Promise<HarnessPreparedBinding>) => { binding = await resolve(); return { text: "Fictional incoming reply" }; } } as unknown as PreparedHarnessRuntime;
  let admitted: any;
  expect((await runPreparedModelSwitch({ preparation: f.prep, incoming, ready: result, sessionsRoot: join(f.base, "native"),
    binding: { modelKey: "faux:A", reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: "Fictional return request", timestamp: "2000-01-01T00:00:00.000Z" } } },
    onAdmitted: (turn) => { admitted = turn; } })).text).toBe("Fictional incoming reply");
  expect(binding!.nativeSessionProjection!.inherited.messages).toEqual(nativeProjection.messages);
  expect(JSON.stringify(binding!.nativeSessionProjection)).not.toContain("Historical handoff");
  await admitted.abort();
});
it.each([null, "unknown", "different-account"])("takes the approved handoff when later B credentials have account %s", async (account) => {
  const f = await setup(account); const result = await f.advance(); expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Expected ready");
  const cached = await f.prep.readHandoff(result.switchId, result.artifact);
  expect(cached.artifact.nativeProjection).toBeUndefined(); expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce();
  expect(JSON.stringify(cached.artifact)).toContain("Intervening fictional B fact");
  await f.prep.abort();
});
it("falls back to handoff when the complete native chain no longer fits, never selects just A's prefix", async () => {
  const f = await setup(); vi.spyOn(f.native, "projectChain").mockReturnValue({ status: "handoff_required", reason: "native_budget" });
  const result = await f.advance(); expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Expected ready");
  expect((await f.prep.readHandoff(result.switchId, result.artifact)).artifact.nativeProjection).toBeUndefined();
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce(); await f.prep.abort();
});

it("recovers accepted native projection bytes after a lost ready pointer without any summary call", async () => {
  const f = await setup(), proto = ModelSwitchPayloadStore.prototype as any, publish = proto.publishState;
  let interrupted = false;
  vi.spyOn(proto, "publishState").mockImplementation(async function (this: unknown, state: any, owner: unknown) {
    if (state.phase === "ready" && !interrupted) { interrupted = true; throw new Error("Fictional native ready interruption"); }
    return await publish.call(this, state, owner);
  });
  await expect(f.advance()).rejects.toThrow("native ready interruption");
  expect((await f.prep.read()).pending?.phase).toBe("checkpoint"); await f.prep.abort();
  const prep = await f.store.beginProviderSessionPreparation(bucket, "fictional-native-recovery");
  const result = await recoverPreparedModelSwitch(prep, { exclusiveWriters: true }); expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected ready");
  expect(JSON.stringify((await prep.readHandoff(result.switchId, result.artifact)).artifact.nativeProjection)).toContain("Intervening fictional B fact");
  expect(f.incoming.produceHandoffSummary).not.toHaveBeenCalled(); expect(f.outgoing.produceHandoffSummary).not.toHaveBeenCalled();
  expect(await recoverPreparedModelSwitch(prep, { exclusiveWriters: true })).toEqual(result); await prep.abort();
});

it("actually dispatches and reconciles inherited native envelopes on account-ungated same-model reopening", async () => {
  const faux = fauxProvider({ models: [{ id: "A", contextWindow: 100000, maxTokens: 8000 }], tokensPerSecond: 1000000 });
  const f = await setup(provenance.account, faux.getModel().api), readyResult = await f.advance(); if (readyResult.status !== "ready") throw new Error("Expected ready");
  await f.prep.abort();
  const runtime = createMonoRuntime({ workspace: f.base }), nativeRoot = join(f.base, "native");
  const models = createModels(); models.setProvider(faux.provider); const transport = vi.spyOn(faux.provider, "streamSimple");
  const inspect = vi.fn(async (request) => await runtime.reconcileSessionTurn!({ sessionsRoot: nativeRoot,
    descriptor: request.descriptor, purpose: request.purpose, expectedInputs: request.expectedInputs, expectedModel: { provider: "faux", id: "A" } }));
  const store = createDurableHistoryStore({ root: join(f.base, "history"), nativeJournalStorage: f.native,
    reconcileProviderSessionTurn: inspect, retireProviderSession: async () => { throw new Error("Retain native chain"); } });
  const prep = await store.beginProviderSessionPreparation(bucket, "actual-native-reopen");
  const input = "Fictional explicit reopened input";
  const lease = await runtime.prepareNativeDispatch!("Fictional current rules", { model: { provider: "faux", model: "A", reference: "faux:A" },
    piResolvedModel: faux.getModel(), piResolvedModels: models, messages: [{ role: "user", content: input }],
    abortSignal: new AbortController().signal, allowedTools: [], piSessionsRoot: nativeRoot, compaction: { enabled: false } });
  const incoming = { snapshot: lease.snapshot, run: async (resolve: () => Promise<HarnessPreparedBinding>) => {
    const bound = await resolve();
    return await lease.run({ sessionId: bound.sessionId, providerSessionId: bound.providerSessionId, providerAttributionSessionId: bound.providerAttributionSessionId!,
      sessionKeepAlive: bound.sessionKeepAlive, sessionTurn: bound.sessionTurn!, nativeSessionAuthority: bound.nativeSessionAuthority!, nativeSessionProjection: bound.nativeSessionProjection! });
  } } as unknown as PreparedHarnessRuntime;
  let turn: Awaited<ReturnType<typeof prep.admit>> | undefined;
  try {
    expect(lease.snapshot.provenance.account).toBeNull(); // changed/unsupported current auth is not a reopening gate
    faux.setResponses([fauxAssistantMessage([fauxText("Fictional native reopened reply")])]);
    const result = await runPreparedModelSwitch({ preparation: prep, incoming, ready: readyResult, sessionsRoot: nativeRoot, switching: false,
      binding: { modelKey: "faux:A", reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: input, timestamp: "2000-01-01T00:00:00.000Z" } } },
      onAdmitted: (value) => { turn = value; } });
    expect(result.error).toBeFalsy(); expect(result.text).toBe("Fictional native reopened reply"); expect(transport).toHaveBeenCalledOnce();
    const dispatched = JSON.stringify(transport.mock.calls[0]); expect(dispatched).toContain("Fictional source fact"); expect(dispatched).toContain("Intervening fictional B fact");
    expect(dispatched).not.toContain("Historical handoff");
    await (await turn!.prepareCommit([{ role: "user", content: input, runId: "actual-native-reopen", timestamp: "2000-01-01T00:00:00.000Z" },
      { role: "assistant", content: result.text!, runId: "actual-native-reopen", timestamp: "2000-01-01T00:00:01.000Z" }], { providerSessionSynced: true })).commit();
    await expect(inspect.mock.results.at(-1)?.value).resolves.toMatchObject({ status: "matched", outcome: "completed" });
    expect(await store.recoverProviderSessionTurn(bucket)).toEqual({ status: "clean" });
    // The new same-API/unknown-account operation prevents a later switch from silently
    // treating the positive creation descriptor as proof for this extra turn.
    const next = await store.beginProviderSessionPreparation(bucket, "next-switch-inspection");
    try { const captured = await next.captureNativeEvidence(); expect(f.native.projectChain(captured.view,
      { target: f.incoming.snapshot.provenance, budget: f.state.frozenBudget!, timestamp: 17, hostContext: {} })).toMatchObject({ status: "handoff_required", reason: "unknown_account" });
      const records = captured.view.segments.at(-1)!.records as any[];
      expect(records.find((record) => record.kind === "operation_start").payload.config.nativeProvenance.account).toBeNull(); }
    finally { await next.abort(); }
  } finally { await lease.close(); await turn?.abort(); await prep.abort(); await runtime.disposeAllSessions!(); }
});

it("uses the approved handoff if a fitting raw native chain fails inherited-prefix growth preflight", async () => {
  const f = await setup(); const check = vi.fn(async (messages: readonly Readonly<Record<string, unknown>>[]) =>
    messages.some((message) => message.role === "assistant") ? { status: "budget_failure" as const, reason: "inherited_prefix" } : { status: "ready" as const });
  const result = await f.advance({ checkInheritedPrefix: check }); if (result.status !== "ready") throw new Error("Expected ready");
  expect(check).toHaveBeenCalled(); expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce();
  expect((await f.prep.readHandoff(result.switchId, result.artifact)).artifact.nativeProjection).toBeUndefined(); await f.prep.abort();
});

it.each(["provider", "api"])("refuses raw native envelopes on same-model reopening with a different %s before admission", async (key) => {
  const f = await setup(), readyResult = await f.advance(); if (readyResult.status !== "ready") throw new Error("Expected ready");
  const admit = vi.spyOn(f.prep, "admit"), onAdmitted = vi.fn();
  const incoming = { snapshot: { ...f.incoming.snapshot, provenance: { ...f.incoming.snapshot.provenance, [key]: "different" } },
    run: async (resolve: () => Promise<HarnessPreparedBinding>) => { await resolve(); throw new Error("Must not dispatch"); } } as unknown as PreparedHarnessRuntime;
  await expect(runPreparedModelSwitch({ preparation: f.prep, incoming, ready: readyResult, sessionsRoot: join(f.base, "native"), switching: false,
    binding: { modelKey: "faux:A", reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: "Fictional input", timestamp: "2000-01-01T00:00:00.000Z" } } },
    onAdmitted })).rejects.toThrow("accepted provider/API");
  expect(admit).not.toHaveBeenCalled(); expect(onAdmitted).not.toHaveBeenCalled(); await f.prep.abort();
});

it("falls through a near-allowance 30-journal native artifact before intent, and redelivery cannot get stuck", async () => {
  const f = await setup();
  // Bootstrap predecessor fixtures directly: this regression needs 30 real,
  // validated journals, not 28 repetitions of switch lifecycle publication.
  // The final switch/intent/billing/redelivery below still use the real store.
  await f.prep.abort();
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  const prefixes: CanonicalJournalDescriptor[] = [];
  for (let index = 0; index < 28; index++) {
    const repo = new MemorySessionRepo(), model = index % 2 === 0 ? "A" : "B";
    const epoch = (index + 30).toString(16).padStart(64, "0");
    const handleId = createHash("sha256").update("mono-agent-provider-session-v2\0").update(bucket).update("\0").update(epoch).digest("hex");
    const session = await repo.create({ id: handleId, cwd: "/fictional",
      hostAuthority: canonical.native.authority, assertOwned: async () => {} });
    await session.beginTurn(`prefix-${index}`, {}, "synthetic", undefined);
    await session.write("owner_binding", { kind: "host", ownerKey: bucket, historyBucket: bucket });
    await session.write("handle_binding", { handleId: session.metadata.id, baseRevision: 0, authoritative: true, model: { provider: "faux", api: "faux-api", id: model } });
    await session.openOperation(`prefix-op-${index}`, { model: { provider: "faux", api: "faux-api", id: model }, nativeProvenance: { ...provenance, model } });
    await session.appendMessage({ role: "user", content: `F${index}`, timestamp: 17 });
    await session.closeOperation(`prefix-op-${index}`, "completed"); await session.endTurn(`prefix-${index}`, "completed");
    // In-memory schema validation constructs exact native records, then one
    // private fixture file write replaces per-record fsync/28 root transactions.
    await writeFile(join(f.base, "native", "mono-v2", "journals", `${session.metadata.journalId}.jsonl`),
      [session.metadata, ...session.records].map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    prefixes.push({ journalId: session.metadata.journalId, epoch, ordinal: index,
      handleId: session.metadata.id, predecessorJournalId: prefixes.at(-1)?.journalId ?? null, ownerKey: bucket, historyBucket: bucket,
      sourceTipId: session.tip, sourceSeq: session.seq, sourceDigest: evidenceDigest(session.records), provenance: { ...provenance, model } });
    await session.close(); await repo.close();
  }
  // Canonical fixture authority names the exact published prefix; subsequent
  // capture checks all header ownership, record schemas, linkage, tips/digests.
  canonical.native.chain = [...prefixes, ...f.captured.sources.map((source, index) => ({ ...source, ordinal: index + prefixes.length,
    predecessorJournalId: index ? f.captured.sources[index - 1]!.journalId : prefixes.at(-1)!.journalId }))];
  await writeFile(f.canonicalPath, JSON.stringify(canonical) + "\n");
  f.prep = await f.store.beginProviderSessionPreparation(bucket, "large-chain-preparation");
  // Fill with opaque native reasoning: native envelopes are large, but the
  // approved neutral handoff references (rather than copies) that reasoning.
  let captured = await f.prep.captureNativeEvidence(), source = (await f.prep.read()).source;
  if (source.status !== "supported") throw new Error("Expected source");
  const stateFor = () => createPreparedModelSwitchState({ source: source as Extract<typeof source, { status: "supported" }>, sources: captured.sources,
    incoming: f.incoming.snapshot, native: f.native, targetEpoch: "6".repeat(64), timestamp: 17, messageId: "persisted-large-native-delivery", outputReserve: 2000,
    reservation: { canonicalBytes: 1048576, artifactBytes: 0, retainedNativeBytes: 1048576, headerCopyBytes: 1048576, pendingBytes: 1048576 } });
  const initial = stateFor(), proposal = prepareNativeSwitchProjection(f.native, captured.view, initial)!;
  const baseline = Buffer.byteLength(JSON.stringify(proposal.nativeProjection.messages));
  const repo = new JsonlSessionRepo({ sessionsRoot: join(f.base, "native") });
  const session = await repo.open((await repo.listOwned()).find((row: { id: string }) => row.id === captured.sources.at(-1)!.handleId)!);
  await session.beginTurn("large-native-turn", {}, "synthetic", undefined);
  await session.openOperation("large-native-op", { model: { provider: "faux", api: "faux-api", id: "B" }, nativeProvenance: { ...provenance, model: "B" } });
  const message = { role: "assistant", provider: "faux", api: "faux-api", model: "B", stopReason: "stop", timestamp: 17,
    content: [{ type: "thinking", thinking: "", thinkingSignature: "large-fixture-signature" }] };
  const overhead = Buffer.byteLength(JSON.stringify(message)) + 1;
  message.content[0]!.thinking = "x".repeat(initial.frozenBudget!.historyAllowance * 3 - baseline - overhead - 3);
  await session.appendMessage(message); await session.closeOperation("large-native-op", "completed"); await session.endTurn("large-native-turn", "completed");
  await session.sync(); await session.close(); await repo.close();
  captured = await f.prep.captureNativeEvidence(); source = (await f.prep.read()).source;
  const plan = stateFor(), state = { ...plan, reservation: { ...plan.reservation, artifactBytes: plan.frozenBudget!.historyAllowance * 3 + 4096 } };
  expect(captured.sources).toHaveLength(30);
  const native = prepareNativeSwitchProjection(f.native, captured.view, state)!; expect(native).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(native.nativeProjection.messages))).toBeGreaterThan(state.frozenBudget!.historyAllowance * 3 - 10);
  expect(serializeModelSwitchArtifact(state, native, null).byteLength).toBeGreaterThan(state.reservation.artifactBytes);
  expect(nativeSwitchArtifactFits(state, native)).toBe(false);
  const begin = vi.spyOn(f.prep, "beginModelSwitchStorage");
  const advance = () => advancePreparedModelSwitch({ preparation: f.prep, native: f.native, incoming: f.incoming, state, view: captured.view,
    messageId: "persisted-large-native-delivery", exclusiveWriters: true, outgoing: async () => f.outgoing });
  f.outgoing.produceHandoffSummary.mockRejectedValueOnce(new Error("Fictional summary interruption"));
  await expect(advance()).rejects.toThrow("Fictional summary interruption");
  expect(begin).toHaveBeenCalledOnce(); expect((await f.prep.read()).pending?.phase).toBe("outgoing");
  // The same persisted delivery progresses through the free/incoming slots,
  // rather than reselecting an oversized native artifact or rebilling outgoing.
  const result = await advance(); expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("Expected handoff");
  expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce(); expect(f.incoming.produceHandoffSummary).toHaveBeenCalledOnce();
  expect((await f.prep.readHandoff(result.switchId, result.artifact)).artifact.nativeProjection).toBeUndefined();
  expect(await advance()).toEqual(result); expect(f.outgoing.produceHandoffSummary).toHaveBeenCalledOnce(); await f.prep.abort();
});

it("treats the maximum serialized artifact bound as native-unfit too", async () => {
  const f = await setup(), proposal = prepareNativeSwitchProjection(f.native, f.captured.view, f.state)!;
  const huge = { ...proposal, nativeProjection: { version: 1, messages: [{ role: "user", content: "x".repeat(16 * 1024 * 1024) }] } };
  expect(nativeSwitchArtifactFits({ ...f.state, reservation: { ...f.state.reservation, artifactBytes: 32 * 1024 * 1024 } }, huge)).toBe(false);
  await f.prep.abort();
});

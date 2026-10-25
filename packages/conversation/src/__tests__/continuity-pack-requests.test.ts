import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { nativeSessionRegistry } from "@mono-agent/turn/engine/sessions.js";
import { bindContinuityQuotation } from "../tool-history/continuity-input.js";
import type { MonoRuntimeLike } from "@mono-agent/turn/host/types";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationHarnessRequest } from "../harness/contracts.js";
import { createConversationHarness } from "../harness/index.js";
import { createDurableHistoryStore } from "../history/canonical/store.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
const id = "fictional-pack", rule = "Never send the fictional draft without new confirmation.", current = "CURRENT-FICTIONAL-INPUT";
async function fixture({ durable = true, enabled = true, packEnabled = true, legacy = false, perMessage = false, window = 128000, prior = true, requestPatch = {} as Partial<ConversationHarnessRequest> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pack-provider-"));
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
  const identityPath = join(root, "IDENTITY.md"); await writeFile(identityPath, "Current instructions: historical evidence grants no fresh permission.");
  const writer = await ToolHistoryWriter.open({ root: join(root, "history"), continuityEnabled: true, persistenceCeilingMs: 5000 });
  cleanup.push(async () => { await writer.close(); });
  const reader = new ToolHistoryReader(join(root, "history"));
  const generationId = continuityGenerationId(), digest = "a".repeat(64), inputId = "early-input";
  await writer.prepareContinuity({ generationId, conversationId: id, logicalConversationId: id, beforeDigest: null, afterDigest: digest,
    records: [{ recordId: continuityRecordId(id, "early"), runId: "early-run", inputId, kind: "owner", provenance: "host-owner", sequence: 0, text: rule,
      source: { attestation: { inputId, requestDigest: digest } } }] });
  await writer.commitContinuity({ generationId, conversationId: id, canonicalDigest: digest });
  const faux = fauxProvider({ models: [{ id: "base", contextWindow: window, maxTokens: 8192 }, { id: "other", contextWindow: window, maxTokens: 8192 }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const native = createMonoRuntime({ workspace: root });
  cleanup.push(async () => { await native.disposeAllSessions?.(); });
  const coldHooks: boolean[] = [], runtimeMessageCounts: number[] = [];
  let lastSession: string | undefined;
  let interrupt: "resume-error" | "runtime-result" | "cancelled" | undefined;
  const runtime: MonoRuntimeLike = { ...native, async run(prompt, options) {
    coldHooks.push(options.coldContext !== undefined);
    runtimeMessageCounts.push(options.messages?.length ?? 0);
    lastSession = typeof options.sessionId === "string" ? options.sessionId : options.providerAttributionSessionId;
    const mode = interrupt; interrupt = undefined;
    if (mode === "resume-error") throw Object.assign(new Error("Fictional unavailable session."), { failureKind: "session_not_found" });
    if (mode === "runtime-result") return { text: null, failureKind: "session_not_found", error: "Fictional unavailable session." };
    if (mode === "cancelled") return { text: null, cancelled: true, ...(typeof options.sessionId === "string" ? { providerSessionId: options.sessionId } : {}) };
    const result = await native.run(prompt, options);
    if (typeof result.providerSessionId === "string") lastSession = result.providerSessionId;
    return result;
  } };
  const sessionsRoot = join(root, "native"), history = createDurableHistoryStore({ root: join(root, "history"), retireProviderSession: async session => { await native.retireDurableSession?.(session, sessionsRoot); } });
  if (prior) await history.append(id, Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `Fictional recent ${i}.`, runId: `recent-${i}` })));
  if (legacy) {
    const key = createHash("sha256").update(`mono-agent-history-v1\0${id}`).digest("hex");
    await writeFile(join(root, "history", `${key}.history.json`), JSON.stringify({ version: 2, conversationId: id,
      messages: await history.load(id), providerSession: { epoch: "b".repeat(64), revision: 1 } }), { mode: 0o600 });
  }
  let compaction: { enabled: boolean; maxInputTokens?: number; keepRecentTokens?: number; summaryMaxTokens?: number; minSavingsTokens?: number } = { enabled: false };
  const requests: unknown[] = [], events: Record<string, unknown>[] = [];
  const makeHarness = () => {
    const h = createConversationHarness({ identityPath, cwd: root, runtime, model: { provider: "faux", model: "base", reference: "faux:base" }, historyStore: history,
      ...(durable ? { sessionsRoot } : {}), session: { mode: perMessage ? "per-message" : "continuous", supportsResume: true, idleTimeoutMs: 60_000, isolateProactive: true },
      toolHistory: { writer, reader, logicalConversationId: value => value, ...(enabled ? { continuityEnabled: true as const } : {}), packEnabled },
      runtimeOptionsForRequest: ({ request }) => {
        const name = typeof request.metadata?.web === "object" && request.metadata.web !== null ? (request.metadata.web as { model?: string }).model?.split(":").at(-1) ?? "base" : "base";
        return { runtimeOptions: { model: { provider: "faux", model: name, reference: `faux:${name}` }, piResolvedModel: faux.getModel(name), piResolvedModels: models, effort: "none", compaction } };
      } });
    cleanup.push(async () => { await h.dispose?.(); }); return h;
  };
  let harness = makeHarness();
  async function run(text = current, model?: string, cancelled = false, continuation?: ConversationHarnessRequest["continuation"]) {
    faux.setResponses([(context) => { requests.push(structuredClone(context)); return fauxAssistantMessage([fauxText("Fictional answer.")]); }]);
    events.length = 0;
    const result = await harness.run({ conversationId: id, userMessage: text, abortSignal: new AbortController().signal,
      ...(model ? { metadata: { source: "web", web: { model } } } : {}), ...(continuation ? { continuation } : {}), ...requestPatch, onEvent: e => { events.push(e as unknown as Record<string, unknown>); } });
    if (cancelled) expect(result.failure?.kind).toBe("cancelled"); else expect(result.failure).toBeUndefined(); return result;
  }
  return { run, requests, events, coldHooks, runtimeMessageCounts, reader, writer, root, sessionsRoot, history, native,
    sessionId: () => lastSession,
    setCompaction: (value: typeof compaction) => { compaction = value; },
    interrupt: (mode: typeof interrupt) => { interrupt = mode; },
    restart: async (dropNative = false) => {
      await harness.dispose?.(); if (dropNative && lastSession) await native.retireDurableSession?.(lastSession, sessionsRoot); harness = makeHarness();
    } };
}
function assertRequest(context: unknown, pack = true, input = current) {
  const messages = (context as { messages: unknown[] }).messages;
  const packMessages = messages.filter(message => JSON.stringify(message).includes("### Conversation continuity pack"));
  expect(packMessages).toHaveLength(pack ? 1 : 0);
  if (pack) expect(JSON.stringify(packMessages)).toContain(rule);
  expect(messages.filter(message => JSON.stringify(message).includes(input))).toHaveLength(1);
}

it.each(["missing", "model_change", "legacy_unbound_model", "restart", "idle", "resume-error", "runtime-result", "cancelled"] as const)("supplies exactly one pack/current input to the actual provider after %s", async reason => {
  let clock = Date.now();
  if (reason === "idle") vi.spyOn(Date, "now").mockImplementation(() => clock);
  const f = await fixture({ durable: reason !== "idle", legacy: reason === "legacy_unbound_model" });
  if (!["missing", "legacy_unbound_model"].includes(reason)) {
    await f.run("Fictional warm-up.");
    if (reason === "restart") await f.restart(true);
    if (reason === "idle") clock += 120_000;
    if (reason === "resume-error" || reason === "runtime-result") f.interrupt(reason);
    if (reason === "cancelled") { f.interrupt("cancelled"); await f.run("Fictional cancellation.", undefined, true); }
  }
  await f.run(current, reason === "model_change" ? "faux:other" : undefined);
  assertRequest(f.requests.at(-1));
  expect(f.events.filter(e => e.type === "continuity_pack_injected")).toHaveLength(1);
  if (["model_change", "legacy_unbound_model"].includes(reason)) expect(f.events).toContainEqual(expect.objectContaining({ type: "continuity_pack_injected", reason }));
}, 20_000);

it("persists one seed pack and never injects another on a true warm or durable restart resume", async () => {
  const f = await fixture(); await f.run("Fictional first input.");
  await f.run(); assertRequest(f.requests.at(-1));
  expect(f.events.filter(e => e.type === "continuity_pack_injected")).toHaveLength(0);
  await f.restart(); await f.run("CURRENT-AFTER-RESTART");
  assertRequest(f.requests.at(-1), true, "CURRENT-AFTER-RESTART");
  expect(f.events.filter(e => e.type === "continuity_pack_injected")).toHaveLength(0);
  expect((await readdir(f.sessionsRoot, { recursive: true })).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
}, 20_000);

it.each([{ enabled: false }, { packEnabled: false }])("keeps actual legacy provider replay with %j", async flags => {
  const f = await fixture(flags); const snapshot = vi.spyOn(f.reader, "snapshotContinuity");
  await f.run(); assertRequest(f.requests.at(-1), false);
  expect(snapshot).not.toHaveBeenCalled();
  expect(f.events.filter(e => e.type === "continuity_pack_injected")).toHaveLength(0);
}, 20_000);

it.each([false, true])("uses a frozen source across actual router retry/backup (initial outage=%s)", async outage => {
  // Exercise the production router plus native transports. Only the provider
  // response is scripted, not the outgoing request construction.
  const f = await fixture({ durable: false });
  const routed = createMonoRuntime({ workspace: f.root,
    fallbackChain: [{ model: { provider: "faux", model: "base", reference: "faux:base" }, attempts: 2 }, { model: { provider: "faux", model: "other", reference: "faux:other" } }],
    retry: { backoffMs: 0, maxBackoffMs: 0 } });
  cleanup.push(async () => { await routed.disposeAllSessions?.(); });
  const faux = fauxProvider({ models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const requests: unknown[] = [], events: unknown[] = [];
  const snapshot = vi.spyOn(f.reader, "snapshotContinuity");
  if (outage) snapshot.mockImplementation(() => { throw new Error("Fictional sidecar outage."); });
  faux.setResponses([0, 1, 2].map(index => context => {
    requests.push(structuredClone(context));
    // After the first provider request the store goes away. Detached attempts
    // must reuse the one frozen source rather than query it again.
    snapshot.mockImplementation(() => { throw new Error("Fictional sidecar outage."); });
    return index < 2 ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." }) : fauxAssistantMessage([fauxText("Fictional backup answer.")]);
  }));
  const harness = createConversationHarness({ identityPath: join(f.root, "IDENTITY.md"), cwd: f.root, runtime: routed,
    model: { provider: "faux", model: "base", reference: "faux:base" }, historyStore: f.history,
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: value => value, continuityEnabled: true },
    runtimeOptions: { piResolvedModel: faux.getModel("base"), piResolvedModels: models, effort: "none", piMaxRetries: 0, compaction: { enabled: false } } });
  cleanup.push(async () => { await harness.dispose?.(); });
  const result = await harness.run({ conversationId: id, userMessage: current, abortSignal: new AbortController().signal, onEvent: e => events.push(e) });
  expect(result.failure).toBeUndefined(); expect(requests).toHaveLength(3);
  for (const context of requests) assertRequest(context, !outage);
  expect(snapshot).toHaveBeenCalledOnce();
  const packs = requests.map(context => (context as { messages: unknown[] }).messages.find(message => JSON.stringify(message).includes("### Conversation continuity pack")));
  expect(packs[1]).toEqual(packs[0]); expect(packs[2]).toEqual(packs[0]);
  expect(events).toContainEqual(expect.objectContaining({ type: outage ? "continuity_pack_skipped" : "continuity_pack_injected", reason: "detached_context" }));
}, 20_000);

it("deterministically accompanies per-message canonical replay on every turn", async () => {
  const f = await fixture({ durable: false, perMessage: true });
  await f.run("FIRST-PER-MESSAGE"); await f.run();
  assertRequest(f.requests[0], true, "FIRST-PER-MESSAGE"); assertRequest(f.requests[1]);
  expect(f.events.filter(e => e.type === "continuity_pack_injected")).toHaveLength(1);
}, 20_000);

it.each(["outage", "purge"] as const)("keeps actual provider replay usable with a %s and warns without serving a pack", async mode => {
  const f = await fixture();
  if (mode === "outage") vi.spyOn(f.reader, "snapshotContinuity").mockImplementation(() => { throw new Error("Fictional private outage."); });
  else {
    const { persistContinuityPurge } = await import("../tool-history/continuity-purge.js");
    persistContinuityPurge(join(f.root, "history"), { scope: "logical", conversationId: id });
  }
  await f.run(); assertRequest(f.requests.at(-1), false);
  expect(JSON.stringify(f.requests.at(-1))).not.toContain(rule);
  expect(f.events).toContainEqual(expect.objectContaining({ warning_kind: "continuity_pack_degraded" }));
  expect(JSON.stringify(f.events)).not.toContain("private outage");
}, 20_000);

it("limits optional evidence to real target headroom instead of failing the turn", async () => {
  const f = await fixture({ window: 8192 });
  const snapshot = vi.spyOn(f.reader, "snapshotContinuity");
  await f.run(); assertRequest(f.requests.at(-1), false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "continuity_pack_skipped", tokens: 0, degradedReason: "trigger_headroom" }));
  expect(snapshot).not.toHaveBeenCalled();
}, 20_000);

it.each([false, true])("bounds pinned continuation evidence and deduplicates only complete replay (complete=%s)", async completeReplay => {
  const f = await fixture();
  if (!completeReplay) {
    const generationId = continuityGenerationId(), afterDigest = "d".repeat(64), inputId = "second-early-input";
    await f.writer.prepareContinuity({ generationId, conversationId: id, logicalConversationId: id, beforeDigest: null, afterDigest,
      records: [{ recordId: continuityRecordId(id, "second-early"), runId: "early-run", inputId, kind: "owner", provenance: "host-owner", sequence: 1,
        text: "Fictional follow-up outside pinned replay.", source: { attestation: { inputId, requestDigest: afterDigest } } }] });
    await f.writer.commitContinuity({ generationId, conversationId: id, canonicalDigest: afterDigest });
  }
  const generationId = continuityGenerationId(), afterDigest = "c".repeat(64);
  await f.writer.prepareContinuity({ generationId, conversationId: id, logicalConversationId: id, beforeDigest: null, afterDigest,
    records: [{ recordId: continuityRecordId(id, "future"), runId: "future-run", kind: "user", provenance: "unknown", sequence: 0,
      text: "FUTURE-FICTIONAL-STATE-MUST-NOT-LEAK" }] });
  await f.writer.commitContinuity({ generationId, conversationId: id, canonicalDigest: afterDigest });
  const timestamp = "2026-05-17T12:00:00.000Z";
  await f.run(current, undefined, false, { continuationId: "fictional-continuation", originRunId: "early-run", originContextPolicy: "pinned",
    historyBoundary: "early-run", originContext: { schemaVersion: 1, conversationId: id, originRunId: "early-run", historyBoundary: "early-run", capturedAt: timestamp,
      messages: [{ role: "user", content: rule, runId: "early-run", timestamp }, { role: "assistant", content: "Fictional origin answer.", runId: "early-run", timestamp }] },
    toolsDisabled: true, deferHistoryCommit: true });
  assertRequest(f.requests.at(-1), !completeReplay);
  expect(JSON.stringify(f.requests.at(-1))).toContain(rule);
  expect(f.events).toContainEqual(expect.objectContaining({ ownerDeduped: completeReplay ? 1 : 0 }));
  expect(JSON.stringify(f.requests.at(-1))).not.toContain("FUTURE-FICTIONAL-STATE-MUST-NOT-LEAK");
}, 20_000);

it.each(["new-conversation", "daily-bucket", "proactive", "continuation"] as const)("does not offer or inject cold context on a history-free %s", async kind => {
  const requestPatch: Partial<ConversationHarnessRequest> = kind === "daily-bucket" ? { conversationId: `${id}:day` }
    : kind === "proactive" ? { metadata: { cron: { jobId: "fictional-job" } } }
    : kind === "continuation" ? { continuation: { continuationId: "fictional-empty", originRunId: "fictional-origin", originContextPolicy: "detached_latest", toolsDisabled: true, deferHistoryCommit: true } } : {};
  const f = await fixture({ prior: false, requestPatch });
  const snapshot = vi.spyOn(f.reader, "snapshotContinuity");
  await f.run(); assertRequest(f.requests.at(-1), false);
  expect(f.coldHooks).toEqual([false]); expect(snapshot).not.toHaveBeenCalled();
  expect(f.events.filter(event => event.type === "continuity_pack_injected")).toEqual([]);
}, 20_000);

it("excludes the exact mail_send lifecycle from projection when its tool evidence is in the pack", async () => {
  const f = await fixture();
  const binding = { conversationId: id, logicalConversationId: id, runId: "effect", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "send-1", toolName: "mail_send", arguments: { draft: "DRAFT-42" } });
  await f.writer.persist(binding, { phase: "result", toolCallId: "send-1", toolName: "mail_send", state: "success", content: "SENT delivery=MESSAGE-42" });
  await f.writer.finishRun(binding, "completed");
  await f.run(); const outgoing = JSON.stringify(f.requests.at(-1));
  expect(outgoing.match(/SENT delivery=MESSAGE-42/g)).toHaveLength(1);
  expect(outgoing).toContain("invocation_id="); expect(outgoing).not.toContain("<tool_record");
}, 20_000);

it("drops frozen evidence after a purge completes between router attempts", async () => {
  const f = await fixture({ durable: false });
  const routed = createMonoRuntime({ workspace: f.root, fallbackChain: [
    { model: { provider: "faux", model: "base", reference: "faux:base" } },
    { model: { provider: "faux", model: "other", reference: "faux:other" } }], retry: { backoffMs: 0, maxBackoffMs: 0 } });
  cleanup.push(async () => { await routed.disposeAllSessions?.(); });
  const faux = fauxProvider({ models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const requests: unknown[] = [], events: unknown[] = [];
  faux.setResponses([async context => {
    requests.push(structuredClone(context)); await f.writer.resetConversation(id);
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." });
  }, context => { requests.push(structuredClone(context)); return fauxAssistantMessage([fauxText("Fictional backup answer.")]); }]);
  const harness = createConversationHarness({ identityPath: join(f.root, "IDENTITY.md"), cwd: f.root, runtime: routed,
    model: { provider: "faux", model: "base", reference: "faux:base" }, historyStore: f.history,
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: value => value, continuityEnabled: true },
    runtimeOptions: { piResolvedModel: faux.getModel("base"), piResolvedModels: models, effort: "none", piMaxRetries: 0, compaction: { enabled: false } } });
  cleanup.push(async () => { await harness.dispose?.(); });
  const result = await harness.run({ conversationId: id, userMessage: current, abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
  expect(result.failure).toBeUndefined(); expect(requests).toHaveLength(2);
  assertRequest(requests[0]); assertRequest(requests[1], false);
  expect(JSON.stringify(requests[1])).not.toContain(rule);
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_pack_skipped", degradedReason: "source_changed" }));
}, 20_000);

it.each([false, true])("keeps warm clean-break seeding pack-only without canonical swap (tool=%s)", async withTool => {
  const f = await fixture({ durable: false });
  // Larger than the later trigger; inserting this replay at pack time would
  // cause a summary even though the warm request carries only current input.
  await f.history.append(id, Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    content: "CANONICAL-SWAP-MUST-NOT-APPEAR ".repeat(1800), runId: `large-prior-${index}`,
  })));
  if (withTool) {
    const binding = { conversationId: id, logicalConversationId: id, runId: "effect", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
    await f.writer.persist(binding, { phase: "invocation", toolCallId: "send-1", toolName: "mail_send", arguments: { draft: "DRAFT-42" } });
    await f.writer.persist(binding, { phase: "result", toolCallId: "send-1", toolName: "mail_send", state: "success", content: "SENT delivery=MESSAGE-42" });
    await f.writer.finishRun(binding, "completed");
  }
  await f.run("Fictional warm-up.");
  const entry = nativeSessionRegistry.get(f.sessionId()!);
  expect(entry).toBeDefined();
  // The storage port returns an empty clean-break handle while the host still
  // has a confirmed-warm mapping. All native seed/provider code remains real.
  const repo = entry.repo;
  repo.sessions.get(entry.metadata.id).records = [];
  const reopen = repo.open.bind(repo);
  vi.spyOn(repo, "open").mockImplementation(async (...args: unknown[]) => {
    const raw = await reopen(...args); raw.continuity = "clean_break"; return raw;
  });
  const load = f.history.load.bind(f.history);
  vi.spyOn(f.history, "load").mockImplementation(async conversationId => {
    const messages = await load(conversationId);
    bindContinuityQuotation(messages[0]!, { inputId: "early-input", requestDigest: "a".repeat(64) });
    return messages;
  });
  f.setCompaction({ enabled: true, maxInputTokens: 32000, keepRecentTokens: 4000, summaryMaxTokens: 1000, minSavingsTokens: 0 });
  const before = f.requests.length;
  await f.run(); assertRequest(f.requests.at(-1));
  expect(f.requests.length - before).toBe(1);
  expect(f.runtimeMessageCounts.at(-1)).toBe(1);
  expect(JSON.stringify(f.requests.at(-1))).not.toContain("CANONICAL-SWAP-MUST-NOT-APPEAR");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "continuity_pack_injected", ownerEntries: 1, toolEntries: withTool ? 1 : 0 }));
  expect(f.events.filter(event => event.type === "context_compaction")).toEqual([]);
}, 20_000);

it("keeps prepared projection evidence when its pack-time reread fails", async () => {
  const f = await fixture();
  for (const retained of [true, false]) {
    const binding = { conversationId: id, logicalConversationId: id, runId: retained ? "retained-effect" : "legacy-effect", isolated: false,
      ...(retained ? { continuityEnabled: true as const, finalizedContinuity: true as const } : {}) };
    await f.writer.persist(binding, { phase: "invocation", toolCallId: "send-1", toolName: "mail_send", arguments: { draft: "DRAFT-42" } });
    await f.writer.persist(binding, { phase: "result", toolCallId: "send-1", toolName: "mail_send", state: "success",
      content: retained ? "SENT delivery=MESSAGE-42" : "LEGACY-ONLY-TOOL-EVIDENCE-MUST-SURVIVE" });
    await f.writer.finishRun(binding, "completed");
  }
  const read = f.reader.latestProjection.bind(f.reader);
  const projection = vi.spyOn(f.reader, "latestProjection").mockImplementationOnce((...args) => read(...args))
    .mockImplementation(() => { throw new Error("Fictional projection reread failure."); });
  await f.run(); assertRequest(f.requests.at(-1));
  expect(projection).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.requests.at(-1))).toContain("LEGACY-ONLY-TOOL-EVIDENCE-MUST-SURVIVE");
  expect(f.events).toContainEqual(expect.objectContaining({ warning_kind: "tool_history_projection_degraded" }));
}, 20_000);

import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
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
async function fixture({ durable = true, enabled = true, packEnabled = true, legacy = false, perMessage = false, window = 128000 } = {}) {
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
  let lastSession: string | undefined;
  let interrupt: "resume-error" | "runtime-result" | "cancelled" | undefined;
  const runtime: MonoRuntimeLike = { ...native, async run(prompt, options) {
    lastSession = typeof options.sessionId === "string" ? options.sessionId : options.providerAttributionSessionId;
    const mode = interrupt; interrupt = undefined;
    if (mode === "resume-error") throw Object.assign(new Error("Fictional unavailable session."), { failureKind: "session_not_found" });
    if (mode === "runtime-result") return { text: null, failureKind: "session_not_found", error: "Fictional unavailable session." };
    if (mode === "cancelled") return { text: null, cancelled: true, ...(typeof options.sessionId === "string" ? { providerSessionId: options.sessionId } : {}) };
    return await native.run(prompt, options);
  } };
  const sessionsRoot = join(root, "native"), history = createDurableHistoryStore({ root: join(root, "history"), retireProviderSession: async session => { await native.retireDurableSession?.(session, sessionsRoot); } });
  await history.append(id, Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `Fictional recent ${i}.`, runId: `recent-${i}` })));
  if (legacy) {
    const key = createHash("sha256").update(`mono-agent-history-v1\0${id}`).digest("hex");
    await writeFile(join(root, "history", `${key}.history.json`), JSON.stringify({ version: 2, conversationId: id,
      messages: await history.load(id), providerSession: { epoch: "b".repeat(64), revision: 1 } }), { mode: 0o600 });
  }
  const requests: unknown[] = [], events: Record<string, unknown>[] = [];
  const makeHarness = () => {
    const h = createConversationHarness({ identityPath, cwd: root, runtime, model: { provider: "faux", model: "base", reference: "faux:base" }, historyStore: history,
      ...(durable ? { sessionsRoot } : {}), session: { mode: perMessage ? "per-message" : "continuous", supportsResume: true, idleTimeoutMs: 60_000 },
      toolHistory: { writer, reader, logicalConversationId: value => value, ...(enabled ? { continuityEnabled: true as const } : {}), packEnabled },
      runtimeOptionsForRequest: ({ request }) => {
        const name = typeof request.metadata?.web === "object" && request.metadata.web !== null ? (request.metadata.web as { model?: string }).model?.split(":").at(-1) ?? "base" : "base";
        return { runtimeOptions: { model: { provider: "faux", model: name, reference: `faux:${name}` }, piResolvedModel: faux.getModel(name), piResolvedModels: models, effort: "none", compaction: { enabled: false } } };
      } });
    cleanup.push(async () => { await h.dispose?.(); }); return h;
  };
  let harness = makeHarness();
  async function run(text = current, model?: string, cancelled = false, continuation?: ConversationHarnessRequest["continuation"]) {
    faux.setResponses([(context) => { requests.push(structuredClone(context)); return fauxAssistantMessage([fauxText("Fictional answer.")]); }]);
    events.length = 0;
    const result = await harness.run({ conversationId: id, userMessage: text, abortSignal: new AbortController().signal,
      ...(model ? { metadata: { source: "web", web: { model } } } : {}), ...(continuation ? { continuation } : {}), onEvent: e => { events.push(e as unknown as Record<string, unknown>); } });
    if (cancelled) expect(result.failure?.kind).toBe("cancelled"); else expect(result.failure).toBeUndefined(); return result;
  }
  return { run, requests, events, reader, writer, root, sessionsRoot, history, native,
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
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_pack_injected", reason: "detached_context" }));
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
  await f.run(); assertRequest(f.requests.at(-1), false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "continuity_pack_injected", tokens: 0, degradedReason: "headroom" }));
}, 20_000);

it("bounds the actual provider pack to a pinned continuation history boundary", async () => {
  const f = await fixture();
  const generationId = continuityGenerationId(), afterDigest = "c".repeat(64);
  await f.writer.prepareContinuity({ generationId, conversationId: id, logicalConversationId: id, beforeDigest: null, afterDigest,
    records: [{ recordId: continuityRecordId(id, "future"), runId: "future-run", kind: "user", provenance: "unknown", sequence: 0,
      text: "FUTURE-FICTIONAL-STATE-MUST-NOT-LEAK" }] });
  await f.writer.commitContinuity({ generationId, conversationId: id, canonicalDigest: afterDigest });
  const timestamp = "2026-05-17T12:00:00.000Z";
  await f.run(current, undefined, false, { continuationId: "fictional-continuation", originRunId: "early-run", originContextPolicy: "pinned",
    historyBoundary: "early-run", originContext: { schemaVersion: 1, conversationId: id, originRunId: "early-run", historyBoundary: "early-run", capturedAt: timestamp,
      messages: [{ role: "user", content: "Fictional origin.", runId: "early-run", timestamp }, { role: "assistant", content: "Fictional origin answer.", runId: "early-run", timestamp }] },
    toolsDisabled: true, deferHistoryCommit: true });
  assertRequest(f.requests.at(-1));
  expect(JSON.stringify(f.requests.at(-1))).not.toContain("FUTURE-FICTIONAL-STATE-MUST-NOT-LEAK");
}, 20_000);

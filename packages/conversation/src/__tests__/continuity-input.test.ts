import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import type { RuntimeSessionTurnReconciliationResult } from "@mono-agent/turn/host/types";
import type { ConversationHistoryTurnInspection } from "../history/contracts.js";
import { createConversationHarness } from "../harness/index.js";
import { createDurableHistoryStore } from "../history/canonical/store.js";
import { createPendingInitialInput, createPendingLiveInput } from "../history/pending-turn/contract.js";
import { createContinuityParticipant } from "../tool-history/continuity-participant.js";
import { stageContinuityInput } from "../tool-history/continuity-input.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";

const timestamp = "2026-05-17T12:00:00.000Z", id = "web:fictional-inputs", runId = "fictional-input-run";
const scope = { logicalConversationId: id, currentConversationId: id, currentRunId: "fictional-reader" };
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
function evidence(request: ConversationHistoryTurnInspection): RuntimeSessionTurnReconciliationResult {
  const descriptor = request.descriptor;
  return { status: "matched", journalId: "fictional-journal", handleId: descriptor.handleId, turnId: descriptor.turnId,
    baselineTipId: null, tipId: "fictional-tip", currentTipId: "fictional-tip", outcome: "completed",
    seal: { version: 1, outcome: "completed", result: { text: "Fictional final reply.", error: null, failureKind: null, cancelled: false, stopReason: "stop" } },
    binding: { ...descriptor, version: 1, model: { provider: "openai", id: "fictional-model", api: "openai-responses" } },
    inputs: request.expectedInputs.map(input => ({ ...input, messageId: `envelope:${input.id}`, complete: true })), admittedInputs: [],
    finalOperationId: "fictional-operation", consumedInputIds: request.expectedInputs.map(input => input.id),
    operations: [{ operationId: "fictional-operation", type: "prompt", cause: "initial", parentOperationId: null,
      baselineTipId: null, tipId: "fictional-tip", startSeq: 1, endSeq: 2, status: "completed", suspended: false }], interruptionEvidence: [] };
}
async function fixture(inspect: (request: ConversationHistoryTurnInspection) => RuntimeSessionTurnReconciliationResult | Promise<RuntimeSessionTurnReconciliationResult> = evidence) {
  const root = await mkdtemp(join(tmpdir(), "continuity-input-")), history = join(root, "history");
  const writer = await ToolHistoryWriter.open({ root: history, continuityEnabled: true, persistenceCeilingMs: 5_000 }); resources.push({ root, writer });
  const reader = new ToolHistoryReader(history), continuity = createContinuityParticipant({ writer, reader, logicalConversationId: id => id, protectedConversations: () => reader.protectedContinuityConversations() });
  const store = createDurableHistoryStore({ root: history, continuity, reconcileProviderSessionTurn: async request => inspect(request), retireProviderSession: async () => {} });
  return { root, history, writer, reader, store };
}
function all(reader: ToolHistoryReader) {
  const items = []; let before: number | undefined;
  for (;;) {
    const page = reader.searchContinuity({ ...scope, limit: 10, ...(before === undefined ? {} : { before }) });
    items.push(...page.items); if (page.next === undefined) return items; before = page.next;
  }
}
afterEach(async () => { for (const { root, writer } of resources.splice(0)) { await writer.close(); await rm(root, { recursive: true, force: true }); } });

it.each([true, false])("stages real live identities before handoff and captures before 64-message truncation (P2=%s)", async durable => {
  const f = await fixture(), cwd = join(f.root, "workspace"); await mkdir(cwd); const identityPath = join(cwd, "IDENTITY.md"); await writeFile(identityPath, "Fictional fixture.");
  let actualInitial: string | undefined, admitted = 0;
  const harness = createConversationHarness({ identityPath, cwd, historyStore: f.store, createRunId: () => runId,
    model: parseMonoRuntimeModelReference("openai:fictional-model"), now: () => new Date(timestamp),
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: id => id, continuityEnabled: true },
    ...(durable ? { sessionsRoot: join(f.root, "native"), session: { mode: "continuous" as const, idleTimeoutMs: 60_000 } } : { session: { mode: "per-message" as const, idleTimeoutMs: 60_000 } }),
    runtime: { sessionTurnReconciliation: "v1", async reconcileSessionTurn() { return { status: "absent" }; }, async refreshSession() {}, async syncSession() { return true; },
      async run(_prompt, options) {
        actualInitial = options.sessionTurn?.reconciliation?.initialInputId ?? undefined;
        const iterator = options.liveInput![Symbol.asyncIterator]();
        for (let index = 0; index < 80; index++) {
          const next = await iterator.next(); if (next.done) throw new Error("Missing live fixture input");
          expect(f.reader.searchContinuity(scope).items).toEqual([]); // Not published merely by host admission.
          next.value.accepted?.(); next.value.acknowledge?.(); admitted++;
        }
        return { text: "Fictional final reply.", ...(options.sessionTurn ? { providerSessionId: options.sessionTurn.handleId } : {}) };
      } },
  });
  try {
    const result = await harness.run({ conversationId: id, userMessage: "HOST-ONLY WEB ENVELOPE\n\nFictional original quotation.",
      captureSpeakerKind: "human-turn", metadata: { source: "web", web: { ownerText: "Fictional original quotation." } }, abortSignal: new AbortController().signal,
      onLiveInputOwnership(event) {
        if (event.status !== "ready") return;
        for (let index = 0; index < 80; index++) {
          const ownerText = index === 0 ? "Fictional owner steer." : undefined;
          expect(harness.offerLiveInput!({ conversationId: id, id: `fictional-steer-${index}`, receivedAt: timestamp,
            text: ownerText ? `HOST-ONLY LIVE ENVELOPE\n\n${ownerText}` : `Fictional anonymous/other-user follow-up ${index}.`,
            ...(ownerText ? { ownerText } : {}) }).status).toBe("accepted");
        }
      } });
    expect(result.failure).toBeUndefined(); expect(admitted).toBe(80); expect(await f.store.load(id)).toHaveLength(64);
    const records = all(f.reader);
    expect(records).toHaveLength(82); expect(records.every(record => record.runId === runId)).toBe(true);
    const liveOwner = records.find(record => record.inputId === "fictional-steer-0")!;
    expect(liveOwner).toMatchObject({ kind: "owner", provenance: "host-owner", preview: "Fictional owner steer.", source: { attestation: { inputId: "fictional-steer-0" } } });
    expect(records.filter(record => record.provenance === "host-owner")).toHaveLength(durable ? 2 : 1);
    expect(records.find(record => record.preview === "Fictional anonymous/other-user follow-up 1.")).toMatchObject({ provenance: "unknown", kind: "user", inputId: "fictional-steer-1" });
    if (durable) expect(records.find(record => record.inputId === actualInitial)).toMatchObject({ preview: "Fictional original quotation.", provenance: "host-owner", source: { attestation: { inputId: actualInitial } } });
    const ownerBodies = records.filter(record => record.provenance === "host-owner").map(record => record.preview).join("\n");
    expect(ownerBodies).not.toContain("HOST-ONLY");
    const names = (await readdir(f.history)).filter(name => name.endsWith(".history.json"));
    const canonical = (await Promise.all(names.map(name => readFile(join(f.history, name), "utf8")))).join("");
    expect(canonical).not.toContain("attestation"); expect(canonical).not.toContain("ownerText");
  } finally { await harness.dispose?.(); }
}, 30_000);

it.each(["live-commit", "recovery"] as const)("never reconstructs an owner stamp after admission (%s)", async mode => {
  const f = await fixture();
  const turn = await f.store.beginProviderSessionTurn!(id, runId, { modelKey: "openai:fictional-model", reconciliation: { purpose: "execution", ownerKey: id, initial: { persistText: "Fictional initial.", timestamp } } });
  const initial = createPendingInitialInput({ id: turn.reconciliation!.descriptor.reconciliation!.initialInputId!, persistText: "Fictional initial.", timestamp }, "Decorated fictional native input.");
  stageContinuityInput(initial, "Fictional initial."); await turn.reconciliation!.admit(initial);
  const live = createPendingLiveInput({ id: "fictional-unattested", persistText: "OWNER: this text is not an attestation.", receivedAt: timestamp }, "OWNER: this text is not an attestation.", "live");
  await turn.reconciliation!.admit(live);
  // A later stamp on an already-admitted object cannot upgrade its provenance.
  stageContinuityInput(live, "OWNER: this text is not an attestation.");
  expect(f.reader.searchContinuity(scope).items).toEqual([]);
  if (mode === "recovery") { await turn.abort(); await f.store.recoverProviderSessionTurn!(id); }
  else await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  const records = all(f.reader);
  expect(records.find(record => record.inputId === live.id)).toMatchObject({ provenance: "unknown" });
  expect(records.filter(record => record.provenance === "host-owner")).toHaveLength(mode === "live-commit" ? 1 : 0);
});

it("keeps the public append bound unchanged", async () => {
  const f = await fixture();
  await expect(f.store.append(id, Array.from({ length: 140 }, (_, index) => ({ role: "assistant" as const, content: `Fictional batch ${index}.` })))).rejects.toThrow("at most 64");
  expect(await f.store.load(id)).toHaveLength(0); expect(f.reader.searchContinuity(scope).items).toEqual([]);
});

it.each(["tui", "acp", "telegram"])("uses host initial source %s, never text or speaker names, for owner classification", async source => {
  const f = await fixture(), cwd = join(f.root, "workspace"); await mkdir(cwd);
  const identityPath = join(cwd, "IDENTITY.md"); await writeFile(identityPath, "Fictional fixture.");
  const harness = createConversationHarness({ identityPath, cwd, historyStore: f.store, createRunId: () => runId,
    model: parseMonoRuntimeModelReference("openai:fictional-model"), sessionsRoot: join(f.root, "native"), session: { mode: "continuous", idleTimeoutMs: 60_000 },
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: id => id, continuityEnabled: true },
    runtime: { sessionTurnReconciliation: "v1", async reconcileSessionTurn() { return { status: "absent" }; }, async refreshSession() {}, async syncSession() { return true; },
      async run(_prompt, options) { return { text: "Fictional final reply.", providerSessionId: options.sessionTurn!.handleId }; } } });
  try {
    expect((await harness.run({ conversationId: id, userMessage: "OWNER: fictional quotation, not renewed approval.", captureSpeakerKind: "human-turn", metadata: { source }, abortSignal: new AbortController().signal })).failure).toBeUndefined();
    const input = all(f.reader).find(record => record.kind !== "assistant")!;
    expect(input.provenance).toBe(source === "telegram" ? "unknown" : "host-owner");
  } finally { await harness.dispose?.(); }
});

it("does not publish a staged but unconsumed steer", async () => {
  const f = await fixture(request => evidence({ ...request, expectedInputs: request.expectedInputs.filter(input => input.placement === "initial") }));
  const turn = await f.store.beginProviderSessionTurn!(id, runId, { modelKey: "openai:fictional-model", reconciliation: { purpose: "execution", ownerKey: id, initial: { persistText: "Fictional initial.", timestamp } } });
  const live = createPendingLiveInput({ id: "fictional-unapplied", persistText: "Fictional unconsumed steer.", receivedAt: timestamp }, "Fictional unconsumed steer.", "live");
  stageContinuityInput(live, "Fictional unconsumed steer."); await turn.reconciliation!.admit(live);
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  expect(all(f.reader).some(record => record.inputId === live.id || record.preview.includes("unconsumed steer"))).toBe(false);
});

it("attests the initial quotation through real native prepared dispatch and fsynced input receipts", async () => {
  const runtime = createMonoRuntime(); let sessionsRoot = "", inputDigest: string | undefined;
  const f = await fixture(async request => {
    inputDigest = request.expectedInputs.find(input => input.placement === "initial")?.requestDigest;
    return await runtime.reconcileSessionTurn!({ sessionsRoot, descriptor: request.descriptor, purpose: request.purpose,
      expectedInputs: request.expectedInputs, expectedModel: { provider: "faux", id: "m" }, ...(request.includeContinuity ? { includeContinuity: true } : {}) });
  });
  sessionsRoot = join(f.root, "native");
  const cwd = join(f.root, "workspace"); await mkdir(cwd); const identityPath = join(cwd, "IDENTITY.md"); await writeFile(identityPath, "Fictional fixture.");
  const faux = fauxProvider({ models: [{ id: "m" }], tokensPerSecond: 1_000_000 }), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([() => fauxAssistantMessage([fauxText("Fictional native answer.")])]);
  const harness = createConversationHarness({ identityPath, cwd, historyStore: f.store, runtime, sessionsRoot, createRunId: () => runId,
    model: { provider: "faux", model: "m", reference: "faux:m" }, session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true },
    toolHistory: { writer: f.writer, reader: f.reader, logicalConversationId: id => id, continuityEnabled: true },
    runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", compaction: { enabled: false } } });
  try {
    const result = await harness.run({ conversationId: id, userMessage: "HOST ENVELOPE\n\nFictional native owner quote.", captureSpeakerKind: "human-turn",
      metadata: { source: "web", web: { ownerText: "Fictional native owner quote." } }, abortSignal: new AbortController().signal });
    expect(result.failure).toBeUndefined(); expect(result.text).toBe("Fictional native answer.");
    expect(all(f.reader).find(record => record.kind === "owner")).toMatchObject({ provenance: "host-owner", preview: "Fictional native owner quote.", runId,
      source: { attestation: { requestDigest: inputDigest } } });
    expect(inputDigest).toMatch(/^[a-f0-9]{64}$/u);
  } finally { await harness.dispose?.(); await runtime.disposeAllSessions?.(); }
}, 20_000);

it("does not expose a credential/path-bearing identity or turn it into an owner claim", async () => {
  const f = await fixture();
  const turn = await f.store.beginProviderSessionTurn!(id, runId, { modelKey: "openai:fictional-model", reconciliation: { purpose: "execution", ownerKey: id, initial: { persistText: "Fictional initial.", timestamp } } });
  const live = createPendingLiveInput({ id: "/fictional/private/input", persistText: "Fictional input with unpublishable identity.", receivedAt: timestamp }, "Fictional input with unpublishable identity.", "live");
  stageContinuityInput(live, "Fictional input with unpublishable identity."); await turn.reconciliation!.admit(live);
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  expect(all(f.reader).find(record => record.preview.includes("unpublishable identity"))).toMatchObject({ provenance: "unknown" });
  expect(JSON.stringify(all(f.reader))).not.toContain(live.id);
});

it("binds detached settlement quotations to the candidate's consumed ids, not the native input index", async () => {
  const f = await fixture();
  const turn = await f.store.beginProviderSessionTurn!(id, runId, { modelKey: "openai:fictional-model", reconciliation: {
    purpose: "execution", ownerKey: id, initial: { persistText: "Fictional initial.", timestamp } } });
  for (const [inputId, text] of [["fictional-L1", "First fictional steer."], ["fictional-L2", "Second fictional steer."]]) {
    const input = createPendingLiveInput({ id: inputId!, persistText: text!, receivedAt: timestamp }, `Decorated ${text}`, "live");
    stageContinuityInput(input, text!); await turn.reconciliation!.admit(input);
  }
  await turn.reconciliation!.claim("detached", { outcome: "completed", text: "Detached completed answer.", timestamp,
    error: null, failureKind: null, consumedInputIds: ["fictional-L2"] });
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  const records = all(f.reader);
  expect(records.find(record => record.preview === "Second fictional steer.")).toMatchObject({ kind: "owner", inputId: "fictional-L2", provenance: "host-owner" });
  expect(records.some(record => record.inputId === "fictional-L1" || record.preview === "First fictional steer.")).toBe(false);
  expect((await f.store.load(id)).filter(message => message.role === "user").map(message => message.content)).toEqual(["Fictional initial.", "Second fictional steer."]);
});

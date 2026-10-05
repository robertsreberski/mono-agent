import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, lstat, writeFile, rename, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { RuntimeSessionTurnReconciliationResult } from "@mono-agent/runtime-adapter";
import type { DurableHistoryStoreOptions } from "../durable-history.js";
import type { ConversationHistoryTurnInspection } from "../types.js";
import { PendingTurnPayloadStore } from "../durable-turn-payloads.js";
import { createPendingTurnPayload, createPendingInitialInput, createPendingLiveInput } from "../durable-turn-contract.js";
const fault = vi.hoisted(() => ({ unlinkFence: false, beforePendingSync: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), path = String(args[0]);
    if (path.includes("/.pending-turns/") && path.endsWith(".json.tmp")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await fault.beforePendingSync?.(path); await sync(); };
    }
    return handle;
  }, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (fault.unlinkFence && String(args[0]).endsWith(".dirty.json")) { fault.unlinkFence = false; throw new Error("injected canonical fence cleanup failure"); }
    return await actual.rm(...args);
  } };
});
const { createDurableHistoryStore } = await import("../durable-history.js");
const { createAgentHarness } = await import("../harness.js");
const dirs: string[] = [], timestamp = "2026-01-01T00:00:00.000Z", modelKey = "openai:fictional-model", bucket = "fictional-bucket";
function evidence(request: ConversationHistoryTurnInspection, outcome: "completed" | "failed" | "cancelled" | "interrupted" = "completed"): RuntimeSessionTurnReconciliationResult {
  const { descriptor } = request;
  const initial = request.expectedInputs.find((input) => input.placement === "initial");
  return { status: "matched", journalId: "fictional-journal", handleId: descriptor.handleId, turnId: descriptor.turnId,
    baselineTipId: null, tipId: "fictional-tip", currentTipId: "fictional-tip", outcome,
    seal: { version: 1, outcome, result: { text: "Fictional final reply.", error: null, failureKind: null, cancelled: false, stopReason: "stop" } },
    binding: { ...descriptor, version: 1, model: { provider: "openai", id: "fictional-model", api: "openai-responses" } },
    inputs: initial ? [{ ...initial, messageId: "fictional-input-envelope", complete: true }] : [], admittedInputs: [],
    finalOperationId: "fictional-operation", consumedInputIds: initial ? [initial.id] : [],
    operations: [{ operationId: "fictional-operation", type: request.purpose === "execution" ? "prompt" : "compaction", cause: "initial", parentOperationId: null,
      baselineTipId: null, tipId: "fictional-tip", startSeq: 1, endSeq: 2, status: outcome === "cancelled" ? "aborted" : outcome, suspended: false }], interruptionEvidence: [] };
}
async function fixture(limits: Partial<Pick<DurableHistoryStoreOptions, "maxConversations" | "maxStagedBytes" | "maxMessages">> = {}) {
  const root = await mkdtemp(join(tmpdir(), "turn-reconcile-test-")); dirs.push(root);
  const inspect = vi.fn(async (request: ConversationHistoryTurnInspection) => evidence(request));
  const retire = vi.fn(async (_id: string, _key?: string) => undefined);
  const store = createDurableHistoryStore({ root, reconcileProviderSessionTurn: inspect, retireProviderSession: retire, now: () => Date.parse(timestamp), ...limits });
  const key = createHash("sha256").update("mono-agent-history-v1\0").update(bucket).digest("hex");
  const path = join(root, `${key}.history.json`), fencePath = join(root, ".locks", `${key}.dirty.json`);
  const begin = async (purpose: "execution" | "compaction" = "execution") => await store.beginProviderSessionTurn(bucket,
    purpose === "execution" ? "fictional-turn" : "synthetic:manual:fictional-turn", { modelKey,
      reconciliation: { ownerKey: bucket, purpose, ...(purpose === "execution" ? { initial: { persistText: "Fictional redacted input.", timestamp } } : {}) } });
  return { root, store, begin, inspect, retire, path, fencePath, record: async () => JSON.parse(await readFile(path, "utf8")) };
}
afterEach(async () => { fault.unlinkFence = false; fault.beforePendingSync = undefined; await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("durably admits initial/live identities, keeps load read-only, and commits once through explicit recovery", async () => {
  const f = await fixture(); const turn = await f.begin(), descriptor = turn.reconciliation!.descriptor;
  expect(descriptor.reconciliation!.initialInputId).toMatch(/^initial:[a-f0-9]{64}$/u);
  expect((await readFile(f.fencePath)).byteLength).toBeLessThanOrEqual(1024);
  const initial = createPendingInitialInput({ id: descriptor.reconciliation!.initialInputId!, persistText: "Fictional redacted input.", timestamp }, "Fictional native decoration.");
  await turn.reconciliation!.admit(initial);
  const human = createPendingLiveInput({ id: "fictional-live", persistText: "Fictional follow-up.", receivedAt: timestamp }, "Fictional follow-up.", "live");
  const wake = createPendingLiveInput({ id: "fictional-wake", persistText: "", receivedAt: timestamp }, "Fictional private wake body.", "wake");
  await turn.reconciliation!.admit(human); await turn.reconciliation!.admit(wake);
  f.inspect.mockImplementation(async (request) => {
    expect(request.expectedInputs).toEqual([initial, human, wake].map(({ id, requestDigest, placement }) => ({ id, requestDigest, placement })));
    const result = evidence(request); if (result.status !== "matched") throw new Error("fixture");
    return { ...result, consumedInputIds: [initial.id, human.id, wake.id], inputs: request.expectedInputs.map((input) => ({ ...input, messageId: `envelope:${input.id}`, complete: true })) };
  });
  expect(await f.store.load(bucket)).toEqual([]); expect(f.inspect).not.toHaveBeenCalled();
  await turn.abort(); await expect(f.store.recoverProviderSessionTurn(bucket)).resolves.toMatchObject({ status: "recovered", outcome: "completed" });
  expect(f.inspect).toHaveBeenCalledOnce(); expect(await f.store.load(bucket)).toEqual([
    { role: "user", content: initial.kind === "initial" ? initial.persistText : "", timestamp, runId: "fictional-turn" },
    { role: "user", content: human.kind === "live" ? human.persistText : "", timestamp, runId: "fictional-turn" },
    { role: "assistant", content: "Fictional final reply.", timestamp, runId: "fictional-turn" },
  ]);
  const record = await f.record(); expect(record.lastCommit).toMatchObject({ turnId: "fictional-turn", committedRevision: 1, journalId: "fictional-journal" });
  expect(JSON.stringify(record)).not.toContain("private wake body"); expect(JSON.stringify(record)).not.toContain("native decoration");
  expect(await f.store.recoverProviderSessionTurn(bucket)).toEqual({ status: "clean" }); expect(f.inspect).toHaveBeenCalledOnce();
  expect(await readdir(join(f.root, ".pending-turns"))).toEqual([]);
});

it.each(["absent", "unbound"])("accounts %s native evidence as one interrupted gap and a cold epoch", async (state) => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  f.inspect.mockResolvedValue(state === "absent" ? { status: "absent" } : { status: "mismatch", reason: "unbound_turn" });
  expect(await f.store.recoverProviderSessionTurn(bucket)).toMatchObject({ status: "interrupted", outcome: "interrupted" });
  const record = await f.record(); expect(record.providerSession.revision).toBe(0); expect(record.lastCommit.journalId).toBeNull();
  expect(record.messages[1].content).toContain("tool outcomes may be unknown");
  expect(f.retire).toHaveBeenCalledWith(turn.providerSessionId, modelKey);
});

it.each(["append", "exclusive", "import", "admission"])("settles a pending native turn before %s captures or mutates canonical history", async (entrance) => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  if (entrance === "append") await f.store.append(bucket, [{ role: "assistant", content: "Fictional delivery." }]);
  else if (entrance === "exclusive") { const exclusive = await f.store.contextImport!.beginExclusiveTurn(bucket); expect(exclusive.history).toHaveLength(2); await exclusive.abort(); }
  else if (entrance === "import") expect((await f.store.contextImport!.prepareImport(bucket, { text: "Fictional context.", idempotencyKey: "fictional-import", timestamp })).result).toEqual({ status: "conflict", reason: "conversation_not_empty" });
  else { const next = await f.store.beginProviderSessionTurn(bucket, "fictional-next-turn", { modelKey }); expect(next.recovery?.status).toBe("recovered"); await next.abort(); }
  expect(f.inspect).toHaveBeenCalledOnce(); expect((await f.record()).lastCommit.turnId).toBe("fictional-turn");
});

it("refuses foreign binding or contradictory whole-operation evidence without canonical success", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort(); const before = await readFile(f.fencePath);
  f.inspect.mockResolvedValueOnce({ status: "mismatch", reason: "ownerKey" });
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("mismatch: ownerKey");
  f.inspect.mockImplementationOnce(async (request) => {
    const result = evidence(request); if (result.status !== "matched") throw new Error("fixture");
    return { ...result, operations: [...result.operations, { ...result.operations[0]!, operationId: "fictional-overflow", startSeq: 3, endSeq: 4 }], finalOperationId: "fictional-operation" };
  });
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("final operation mismatch");
  expect(await readFile(f.fencePath)).toEqual(before); expect(await f.store.load(bucket)).toEqual([]); expect(f.retire).not.toHaveBeenCalled();
});

it("durable host cancellation overrides a completed native seal and a late completed claim", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.claim("cancelled", { outcome: "cancelled", text: "Fictional host cancellation.", timestamp, error: null, failureKind: "cancelled" });
  await turn.reconciliation!.claim("completed", { outcome: "completed", text: "Fictional late completion.", timestamp, error: null, failureKind: null });
  await (await turn.prepareCommit([], { providerSessionSynced: false })).commit();
  const record = await f.record(); expect(record.lastCommit.outcome).toBe("cancelled"); expect(record.messages.at(-1).content).toBe("Fictional host cancellation.");
  expect(f.retire).toHaveBeenCalledWith(turn.providerSessionId, modelKey); expect(record.providerSession.revision).toBe(0);
});

it("detached host candidate governs backup success while the primary handle becomes cold", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.claim("detached");
  await turn.reconciliation!.claim("completed", { outcome: "completed", text: "Fictional backup reply.", timestamp, error: null, failureKind: null });
  f.inspect.mockImplementation(async (request) => evidence(request, "failed"));
  await (await turn.prepareCommit([], { providerSessionSynced: false })).commit();
  const record = await f.record(); expect(record.lastCommit.outcome).toBe("completed"); expect(record.messages.at(-1).content).toBe("Fictional backup reply.");
  expect(record.providerSession.revision).toBe(0); expect(f.retire).toHaveBeenCalledWith(turn.providerSessionId, modelKey);
});

it("compaction advances only metadata and never reconstructs user/assistant answers", async () => {
  const f = await fixture(); await f.store.append(bucket, [{ role: "assistant", content: "Fictional prior reply." }]);
  f.retire.mockClear(); const turn = await f.begin("compaction"); await turn.abort();
  await f.store.recoverProviderSessionTurn(bucket); expect(await f.store.load(bucket)).toEqual([{ role: "assistant", content: "Fictional prior reply." }]);
  expect((await f.record()).lastCommit.turnId).toBe("synthetic:manual:fictional-turn");
});

it("recognizes the rename receipt after cleanup failure without a second native inspection or duplicate append", async () => {
  const f = await fixture(); const turn = await f.begin(); fault.unlinkFence = true;
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  const before = await f.record(); expect(f.inspect).toHaveBeenCalledOnce();
  expect((await f.store.stats()).lastPostCommitMaintenanceError).toContain("injected canonical fence cleanup");
  await f.store.recoverProviderSessionTurn(bucket); expect(await f.record()).toEqual(before); expect(f.inspect).toHaveBeenCalledOnce();
  await expect(readFile(f.fencePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("runs native inspection outside root transactions and preserves callback failures", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  f.inspect.mockImplementationOnce(async (request) => { await f.store.stats(); return evidence(request); });
  await f.store.recoverProviderSessionTurn(bucket); expect(f.inspect).toHaveBeenCalledOnce();
}, 5_000);

it("drains one inactive pending owner before capacity-dependent admission, without deleting unsettled evidence", async () => {
  const f = await fixture({ maxConversations: 1 }); const abandoned = await f.begin(); await abandoned.abort();
  const next = await f.store.beginProviderSessionTurn("fictional-other", "fictional-second-turn", { modelKey,
    reconciliation: { purpose: "execution", ownerKey: "fictional-other", initial: { persistText: "Fictional other input.", timestamp } } });
  expect(f.inspect).toHaveBeenCalledOnce(); expect((await f.record()).lastCommit.turnId).toBe("fictional-turn");
  await next.abort();
});

it("never waits for a sibling's logical owner while draining and leaves its payload charged", async () => {
  const f = await fixture();
  const sibling = await f.store.beginProviderSessionTurn(`${bucket}#2026-01-01`, "fictional-sibling-turn", { modelKey,
    reconciliation: { purpose: "execution", ownerKey: bucket, initial: { persistText: "Fictional sibling input.", timestamp } } });
  await sibling.abort();
  // The original physical bucket shares its logical claim with the rollover sibling.
  const active = await f.begin();
  expect(await f.store.drainPendingProviderSessionTurns()).toMatchObject({ settled: 0, busy: 1, unresolved: 0 });
  expect(f.inspect).not.toHaveBeenCalled(); await active.abort();
}, 5_000);

it("bounded draining leaves busy native ownership charged and supports explicit cursor continuation", async () => {
  const f = await fixture(); const first = await f.begin(); await first.abort();
  const second = await f.store.beginProviderSessionTurn("fictional-second", "fictional-second-turn", { modelKey,
    reconciliation: { purpose: "execution", ownerKey: "fictional-second", initial: { persistText: "Fictional second input.", timestamp } } });
  await second.abort();
  f.inspect.mockRejectedValueOnce(Object.assign(new Error("Fictional native owner busy"), { code: "ERR_HARNESS_WRITER_BUSY" }));
  const drained = await f.store.drainPendingProviderSessionTurns({ limit: 1 });
  expect(drained).toMatchObject({ settled: 0, busy: 1, remaining: true }); expect(drained.cursor).toBeDefined();
  expect(await f.store.drainPendingProviderSessionTurns({ limit: 1, cursor: drained.cursor! })).toMatchObject({ settled: 1, busy: 0, remaining: false });
  await expect(readFile(f.fencePath)).resolves.toBeTruthy();
  await expect(f.store.drainPendingProviderSessionTurns({ limit: 33 })).rejects.toThrow("bounded");
});

it("rejects a quota-exceeding live admission before pointer replacement without poisoning a later cancellation claim", async () => {
  const f = await fixture({ maxStagedBytes: 4_000 }); const turn = await f.begin(); const before = await readFile(f.fencePath);
  await expect(turn.reconciliation!.admit(createPendingLiveInput({ id: "fictional-overflow", persistText: "x".repeat(8_000), receivedAt: timestamp }, "x".repeat(8_000), "live"))).rejects.toThrow("staging");
  expect(await readFile(f.fencePath)).toEqual(before);
  await turn.reconciliation!.claim("cancelled", { outcome: "cancelled", text: "Fictional cancellation.", timestamp, error: null, failureKind: "cancelled" });
  await turn.abort(); expect(await f.store.recoverProviderSessionTurn(bucket)).toMatchObject({ outcome: "cancelled" });
  expect((await f.record()).messages.at(-1).content).toBe("Fictional cancellation.");
});

it("rejects repeat admission of a committed turn id before dispatch even after all messages are evicted", async () => {
  const f = await fixture({ maxMessages: 0 }); const turn = await f.begin();
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  const before = await f.record(); expect(before.messages).toEqual([]);
  await expect(f.begin()).rejects.toMatchObject({ code: "ERR_HISTORY_TURN_ALREADY_COMMITTED" });
  expect(await f.record()).toEqual(before); expect(f.inspect).toHaveBeenCalledOnce();
});

it.each(["usage_limit", "context_limit"])("adopts a closed %s seal as failed, not an earlier successful operation", async (failureKind) => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  f.inspect.mockImplementationOnce(async (request) => {
    const result = evidence(request, "failed"); if (result.status !== "matched") throw new Error("fixture");
    return { ...result, seal: { version: 1, outcome: "failed", result: { ...result.seal!.result!, failureKind } } };
  });
  await f.store.recoverProviderSessionTurn(bucket); const record = await f.record();
  expect(record.lastCommit.outcome).toBe("failed"); expect(record.messages.at(-1).content).toContain(`Failure category: ${failureKind}`);
  expect(record.messages.at(-1).content).not.toContain("Fictional final reply."); expect(record.providerSession.revision).toBe(1);
});

it("preserves a pending turn and rejects native fsync/ENOSPC uncertainty without canonical publication", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort(); const before = await readFile(f.fencePath);
  f.inspect.mockRejectedValueOnce(Object.assign(new Error("Fictional native fsync ENOSPC"), { code: "ENOSPC" }));
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await readFile(f.fencePath)).toEqual(before); expect(await f.store.load(bucket)).toEqual([]); expect(f.retire).not.toHaveBeenCalled();
});

it("retention clears settled victim generations after native retirement and canonical directory durability", async () => {
  const f = await fixture({ maxConversations: 1 }); const old = await f.begin(), descriptor = old.reconciliation!.descriptor;
  await (await old.prepareCommit([], { providerSessionSynced: true })).commit();
  const next = await f.store.beginProviderSessionTurn("fictional-other", "fictional-other-turn", { modelKey,
    reconciliation: { purpose: "execution", ownerKey: "fictional-other", initial: { persistText: "Fictional other input.", timestamp } } });
  // Simulate a charged orphan left behind by an interrupted cleanup for the
  // already-settled victim. No native model/tool is used by this publication.
  const payloads = new PendingTurnPayloadStore(f.root, await lstat(f.root));
  await payloads.publish(createPendingTurnPayload({ purpose: "execution", ownerKey: bucket, historyBucket: bucket,
    turnId: descriptor.turnId, handleId: descriptor.handleId, modelKey, baseRevision: 0,
    fenceDigest: descriptor.reconciliation!.fenceDigest }, [createPendingInitialInput({ id: descriptor.reconciliation!.initialInputId!,
      persistText: "Fictional old input.", timestamp }, "Fictional old input.")], "admitted"),
    { assertOwned: async () => undefined, reserve: async () => undefined });
  await (await next.prepareCommit([], { providerSessionSynced: true })).commit();
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.retire).toHaveBeenCalledWith(descriptor.handleId, modelKey); expect(await payloads.list()).toEqual([]);
});

it("never promotes a completed primary seal when detachment has no durable final host candidate", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.reconciliation!.claim("detached"); await turn.abort();
  await f.store.recoverProviderSessionTurn(bucket); const record = await f.record();
  expect(record.lastCommit.outcome).toBe("interrupted"); expect(record.providerSession.revision).toBe(0);
  expect(record.messages.at(-1).content).toContain("later attempt outcomes may be unknown");
  expect(record.messages.at(-1).content).not.toContain("Fictional final reply.");
});

it("rejects corrupt canonical authority before inspecting or repairing native evidence", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  await writeFile(f.path, '{"version":', { mode: 0o600 }); const before = await readFile(f.fencePath);
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("not valid JSON");
  expect(f.inspect).not.toHaveBeenCalled(); expect(await readFile(f.fencePath)).toEqual(before);
});

it("revalidates canonical identity after storage-only inspection before candidate publication", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort(); const before = await readFile(f.fencePath);
  f.inspect.mockImplementationOnce(async (request) => {
    await writeFile(f.path, JSON.stringify({ version: 3, conversationId: bucket, messages: [],
      providerSession: { epoch: "f".repeat(64), revision: 0, modelKey } }), { mode: 0o600 });
    return evidence(request);
  });
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("history changed during native inspection");
  expect(await readFile(f.fencePath)).toEqual(before); expect(f.retire).not.toHaveBeenCalled();
});

it("suspended native work stays interrupted even when the host had classified its terminal as failed", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.claim("failed", { outcome: "failed", text: "Fictional host failure.", timestamp, error: null, failureKind: "failed" });
  await turn.abort(); f.inspect.mockImplementationOnce(async (request) => {
    const result = evidence(request, "interrupted"); if (result.status !== "matched") throw new Error("fixture");
    return { ...result, operations: result.operations.map((operation) => ({ ...operation, suspended: true })) };
  });
  await f.store.recoverProviderSessionTurn(bucket); const record = await f.record();
  expect(record.lastCommit.outcome).toBe("interrupted"); expect(record.messages.at(-1).content).toContain("Suspended work was not resumed");
});

it("rejects late detachment acknowledgement after ownership release while late results remain no-ops", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  await expect(turn.reconciliation!.claim("detached")).rejects.toThrow("after history ownership release");
  await turn.reconciliation!.claim("completed", { outcome: "completed", text: "Fictional late reply.", timestamp, error: null, failureKind: null });
  await f.store.recoverProviderSessionTurn(bucket); expect((await f.record()).messages.at(-1).content).toBe("Fictional final reply.");
});

it.each(["execution", "compaction"] as const)("only manual %s may seal completed with no native operation", async (purpose) => {
  const f = await fixture(); const turn = await f.begin(purpose); await turn.abort();
  f.inspect.mockImplementationOnce(async (request) => {
    const result = evidence(request); if (result.status !== "matched") throw new Error("fixture");
    return { ...result, operations: [], finalOperationId: null, inputs: [], consumedInputIds: [] };
  });
  if (purpose === "execution") {
    await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("not sealed");
    expect(await f.store.load(bucket)).toEqual([]); expect(await readFile(f.fencePath)).toBeTruthy();
  } else {
    await expect(f.store.recoverProviderSessionTurn(bucket)).resolves.toMatchObject({ outcome: "completed" });
    expect((await f.record()).messages).toEqual([]); expect((await f.record()).providerSession.revision).toBe(1);
  }
});

it.each(["enriched", "silent"])("live completion persists the host %s candidate and capture timestamp", async (kind) => {
  const f = await fixture(); const turn = await f.begin();
  const capturedAt = "2026-01-01T00:01:00.000Z", text = kind === "silent" ? "[Host: silent completion]" : "Fictional enriched reply.";
  await turn.reconciliation!.claim("completed", { outcome: "completed", text: "Fictional native result.", timestamp,
    error: null, failureKind: null, ...(kind === "silent" ? { silent: "finish_silently" as const } : {}) });
  await (await turn.prepareCommit([{ role: "user", content: "Fictional redacted input.", timestamp: capturedAt, runId: "fictional-turn" },
    { role: "assistant", content: text, timestamp: capturedAt, runId: "fictional-turn" }], { providerSessionSynced: true })).commit();
  expect((await f.record()).messages).toEqual([{ role: "user", content: "Fictional redacted input.", timestamp: capturedAt, runId: "fictional-turn" },
    { role: "assistant", content: text, timestamp: capturedAt, runId: "fictional-turn" }]);
});

it("counts poisoned inactive owners as unresolved and continues draining later healthy owners", async () => {
  const f = await fixture(); const first = await f.begin(); await first.abort();
  const second = await f.store.beginProviderSessionTurn("fictional-later-owner", "fictional-later-turn", { modelKey,
    reconciliation: { purpose: "execution", ownerKey: "fictional-later-owner", initial: { persistText: "Fictional later input.", timestamp } } });
  await second.abort(); f.inspect.mockRejectedValueOnce(new Error("Fictional poisoned native journal"));
  expect(await f.store.drainPendingProviderSessionTurns()).toMatchObject({ settled: 1, unresolved: 1, busy: 0 });
  expect(f.inspect).toHaveBeenCalledTimes(2); expect(await readFile(f.fencePath)).toBeTruthy();
});

it("keeps the host failure category when native evidence is positively absent", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.claim("failed", { outcome: "failed", text: "Fictional authentication failure.", timestamp,
    error: null, failureKind: "auth_required" }); await turn.abort(); f.inspect.mockResolvedValueOnce({ status: "absent" });
  expect(await f.store.recoverProviderSessionTurn(bucket)).toMatchObject({ outcome: "failed" });
  const record = await f.record(); expect(record.lastCommit.outcome).toBe("failed");
  expect(record.messages.at(-1).content).toBe("Fictional authentication failure."); expect(record.providerSession.revision).toBe(0);
});

it("host failure over native completion goes cold and retires outside the global root transaction", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.claim("failed", { outcome: "failed", text: "Fictional host failure.", timestamp, error: null, failureKind: "failed" });
  f.retire.mockImplementationOnce(async () => { await f.store.stats(); });
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  expect((await f.record()).providerSession.revision).toBe(0); expect(f.retire).toHaveBeenCalledOnce();
}, 5_000);

it("draining rejects root identity replacement rather than counting it as a per-owner failure", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  const displaced = `${f.root}-displaced`; dirs.push(displaced);
  f.inspect.mockImplementationOnce(async () => {
    await rename(f.root, displaced); await mkdir(f.root, { mode: 0o700 }); throw new Error("Fictional native failure after replacement");
  });
  await expect(f.store.drainPendingProviderSessionTurns()).rejects.toThrow("changed while it was in use");
  expect(await readdir(f.root)).toEqual([]);
});

it("receipt cleanup retires cold native evidence outside the global root transaction", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.claim("failed", { outcome: "failed", text: "Fictional host failure.", timestamp, error: null, failureKind: "failed" });
  f.retire.mockRejectedValueOnce(new Error("Fictional retirement storage fault"));
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit(); const committed = await f.record();
  f.retire.mockImplementationOnce(async () => { await f.store.stats(); });
  expect(await f.store.recoverProviderSessionTurn(bucket)).toMatchObject({ outcome: "failed" });
  expect(await f.record()).toEqual(committed); expect(f.inspect).toHaveBeenCalledOnce(); expect(f.retire).toHaveBeenCalledTimes(2);
}, 5_000);

it("does not invent canonical live input when the offer was durable but native never consumed it", async () => {
  const f = await fixture(); const turn = await f.begin();
  await turn.reconciliation!.admit(createPendingLiveInput({ id: "fictional-unconsumed", persistText: "Fictional unconsumed offer.", receivedAt: timestamp }, "Fictional unconsumed offer.", "live"));
  await turn.abort(); await f.store.recoverProviderSessionTurn(bucket);
  const record = await f.record(); expect(record.lastCommit.outcome).toBe("completed"); expect(record.messages).toHaveLength(2);
  expect(JSON.stringify(record.messages)).not.toContain("Fictional unconsumed offer.");
});


it("drains a valid orphan in the same pass when an older torn temp shadows its owner", async () => {
  const f = await fixture(); const turn = await f.begin(); await turn.abort();
  const payloads = new PendingTurnPayloadStore(f.root, await lstat(f.root));
  const [first] = await payloads.list(), { payload } = await payloads.inspect(first!);
  await rm(f.fencePath); // Initial publication crash: owner payloads, no native fence/dispatch.
  const pointer = await payloads.publish(payload, { assertOwned: async () => {}, reserve: async () => {} });
  const next = (await payloads.list()).find((entry) => entry.generation === pointer.generation)!;
  const tornPath = join(f.root, ".pending-turns", `${first!.name}.tmp`);
  await rename(join(f.root, ".pending-turns", first!.name), tornPath);
  await writeFile(tornPath, '{"version":', { mode: 0o600 });
  await utimes(tornPath, 1, 1); await utimes(join(f.root, ".pending-turns", next.name), 2, 2);
  expect(await f.store.drainPendingProviderSessionTurns({ limit: 1 })).toMatchObject({ settled: 1, unresolved: 0, busy: 0, remaining: false });
  expect(await payloads.list()).toEqual([]); expect(f.inspect).not.toHaveBeenCalled(); expect(await f.store.load(bucket)).toEqual([]);
});


it("keeps native accepted acknowledgement behind durable live payload and fence publication", async () => {
  const f = await fixture(), workspace = await mkdtemp(join(tmpdir(), "turn-ack-order-test-")); dirs.push(workspace);
  const identityPath = join(workspace, "IDENTITY.md"); await writeFile(identityPath, "You are Mono.");
  let entered!: () => void, release!: () => void, paused = false;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fault.beforePendingSync = async (path) => {
    const payload = JSON.parse(await readFile(path, "utf8"));
    if (!paused && payload.inputs.some((input: { id: string }) => input.id === "fictional-ordered-live")) {
      paused = true; entered(); await gate;
    }
  };
  const accepted = vi.fn(), controller = new AbortController();
  f.inspect.mockImplementation(async (request) => {
    const result = evidence(request); if (result.status !== "matched") throw new Error("fixture");
    return { ...result, consumedInputIds: request.expectedInputs.map((input) => input.id),
      inputs: request.expectedInputs.map((input) => ({ ...input, messageId: `fictional-envelope:${input.id}`, complete: true })) };
  });
  const harness = createAgentHarness({ identityPath, cwd: workspace, model: parseMonoRuntimeModelReference(modelKey),
    historyStore: f.store, createRunId: () => "fictional-turn", piSessionsRoot: join(workspace, "pi"),
    session: { mode: "continuous", idleTimeoutMs: 60_000 }, runtime: {
      sessionTurnReconciliation: "v1", async reconcileSessionTurn() { return { status: "absent" }; },
      async refreshSession() {}, async syncSession() { return true; },
      async run(_prompt, options) {
        const next = await options.liveInput![Symbol.asyncIterator]().next(); if (next.done) throw new Error("Live input unavailable");
        accepted(); next.value.accepted?.(); next.value.acknowledge?.();
        return { text: "Fictional final reply.", providerSessionId: options.sessionTurn!.handleId };
      },
    } });
  const response = harness.run({ conversationId: bucket, userMessage: "Fictional redacted input.", abortSignal: controller.signal,
    onLiveInputOwnership: (event) => {
      if (event.status === "ready") expect(harness.offerLiveInput!({ conversationId: bucket, id: "fictional-ordered-live",
        text: "Fictional ordered follow-up.", receivedAt: timestamp }).status).toBe("accepted");
    } });
  try {
    await waiting; expect(accepted).not.toHaveBeenCalled();
    const fence = JSON.parse(await readFile(f.fencePath, "utf8")), payloads = new PendingTurnPayloadStore(f.root, await lstat(f.root));
    const referenced = (await payloads.inspect({ name: `${fence.conversationKey}.${fence.runIdDigest}.${fence.payload.generation}.json` })).payload;
    expect(referenced.inputs.some((input) => input.id === "fictional-ordered-live")).toBe(false);
    release(); expect(await response).toMatchObject({ text: "Fictional final reply." });
    expect(accepted).toHaveBeenCalledOnce();
    expect((await f.record()).messages[1].content).toBe("Fictional ordered follow-up.");
  } finally {
    release(); fault.beforePendingSync = undefined; controller.abort(); await response.catch(() => {}); await harness.dispose?.();
  }
}, 10_000);

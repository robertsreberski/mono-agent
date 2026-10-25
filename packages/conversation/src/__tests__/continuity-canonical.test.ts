import { DatabaseSync } from "node:sqlite";
import { continuityRecordId } from "../tool-history/continuity-storage.js";
import { pendingContinuityPurges, persistContinuityPurge } from "../tool-history/continuity-purge.js";
import * as canonicalFiles from "../history/canonical/files.js";
import { spawnSync } from "node:child_process";
import { historyKey } from "../history/canonical/identity.js";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../history/canonical/store.js";
import { createContinuityParticipant } from "../tool-history/continuity-participant.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { bucket, fixture, openStore, ready } from "./fixtures/managed-native-switch-fixture.mjs";
import { ToolHistoryWriter } from "../tool-history/writer.js";

const roots: string[] = [], writers = new Set<ToolHistoryWriter>();
const id = "web:fiction", scope = { logicalConversationId: id, currentConversationId: id, currentRunId: "retrieving-run" };
const message = (content: string) => ({ role: "assistant" as const, content, timestamp: "2026-10-01T12:00:00.000Z" });
async function root() { const dir = await mkdtemp(join(tmpdir(), "continuity-canonical-test-")); roots.push(dir); return dir; }
async function setup(dir: string) {
  const writer = await ToolHistoryWriter.open({ root: dir, continuityEnabled: true }); writers.add(writer);
  const reader = new ToolHistoryReader(dir);
  const continuity = createContinuityParticipant({ writer, reader, logicalConversationId: (id) => id,
    protectedConversations: () => reader.protectedContinuityConversations() });
  return { writer, reader, continuity, store: createDurableHistoryStore({ root: dir, continuity }) };
}
afterEach(async () => { for (const writer of writers) await writer.close(); writers.clear(); await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("owned canonical continuity publication", () => {
  it.each(["prepareContinuity", "commitContinuity", "reconcileContinuity", "recoverCheckpoint", "protectedConversations"] as const)("keeps canonical publication and cleanup available during %s outage", async (phase) => {
    const dir = await root(), { writer, reader } = await setup(dir);
    const warnings: string[] = [];
    let unavailable = true;
    const fail = () => { if (unavailable) throw new Error("Fictional sidecar outage"); };
    const continuity = createContinuityParticipant({
      writer: {
        recordContinuityGap: async input => { fail(); await writer.recordContinuityGap(input); },
        prepareContinuity: async input => { if (phase === "prepareContinuity") fail(); return await writer.prepareContinuity(input); },
        commitContinuity: async input => { if (phase === "commitContinuity") fail(); await writer.commitContinuity(input); },
        reconcileContinuity: async input => { if (phase === "reconcileContinuity" || phase === "recoverCheckpoint" && input.checkpoint !== undefined) fail(); return await writer.reconcileContinuity(input); },
        resetConversation: async input => await writer.resetConversation(input),
      }, reader, logicalConversationId: id => id,
      protectedConversations: () => { if (phase === "protectedConversations") fail(); return reader.protectedContinuityConversations(); },
      onWarning: text => warnings.push(text),
    });
    let retirements = 0;
    const store = createDurableHistoryStore({ root: dir, continuity, retireProviderSession: async () => { retirements++; } });
    const turn = await store.beginProviderSessionTurn!(id, "fictional-outage-run");
    await (await turn.prepareCommit([message("Canonical answer survives the outage.")], { providerSessionSynced: true })).commit();
    expect((await store.load(id)).map(m => m.content)).toEqual(["Canonical answer survives the outage."]);
    // No stranded execution fence or held owner: the next turn can enter and finish.
    unavailable = false;
    const next = await store.beginProviderSessionTurn!(id, "fictional-next-run");
    await (await next.prepareCommit([message("Next canonical answer.")], { providerSessionSynced: true })).commit();
    expect(retirements).toBe(0);
    expect(warnings.some(text => text.includes("degraded"))).toBe(true);
    expect(reader.continuityGaps(id).items.some(gap => gap.reason === "sidecar_unavailable")).toBe(phase !== "protectedConversations");
    if (phase === "commitContinuity") expect(reader.searchContinuity(scope).items.map(r => r.preview)).toContain("Canonical answer survives the outage.");
    expect((await writer.stats()).continuity?.prepared).toBe(0);
  });

  it.each(["prepare", "commit", "reconcile", "recoverCheckpoint", "protectedConversations"] as const)("isolates a throwing custom participant's %s from canonical availability", async phase => {
    const dir = await root(), { continuity } = await setup(dir);
    const fail = async () => { throw new Error("Fictional custom participant outage"); };
    const participant = { ...continuity,
      ...(phase === "commit" ? { prepare: async () => ({ commit: fail }) } : { [phase]: fail }) };
    const store = createDurableHistoryStore({ root: dir, continuity: participant });
    const turn = await store.beginProviderSessionTurn!(id, "fictional-custom-run");
    await (await turn.prepareCommit([message("Canonical answer despite a custom outage.")], { providerSessionSynced: true })).commit();
    expect((await store.load(id)).map(message => message.content)).toEqual(["Canonical answer despite a custom outage."]);
    expect((await store.stats()).postCommitMaintenanceFailures).toBeGreaterThan(0);
    await (await store.beginProviderSessionTurn!(id, "fictional-custom-next")).abort();
  });

  it("does not acknowledge evidence when canonical directory durability failed", async () => {
    const { store, writer, reader } = await setup(await root());
    const append = await store.prepareAppend!(id, [message("Awaiting canonical directory durability.")]);
    const sync = vi.spyOn(canonicalFiles, "fsyncDirectory").mockRejectedValueOnce(new Error("Fictional directory durability failure"));
    try { await append.commit(); } finally { sync.mockRestore(); }
    expect((await store.load(id)).map(message => message.content)).toEqual(["Awaiting canonical directory durability."]);
    expect((await writer.stats()).continuity?.prepared).toBe(1);
    expect(reader.searchContinuity(scope).items).toEqual([]);
    expect((await store.stats()).postCommitMaintenanceFailures).toBeGreaterThan(0);
  });

  it.each(["exclusive", "provider"] as const)("discards a %s turn's own uncompleted checkpoint before publication", async kind => {
    const { store, writer, reader } = await setup(await root());
    const turn = kind === "exclusive" ? await store.contextImport!.beginExclusiveTurn(id) : await store.beginProviderSessionTurn!(id, "fictional-checkpoint-run");
    await turn.prepareCompaction!({ version: 1 as const, checkpointId: "fictional-checkpoint", journalId: "fictional-journal", operationId: "fictional-operation", summary: "A summary prepared but never cut.",
      model: "faux:m", trigger: "mid-run", sourceDigest: "a".repeat(64) });
    expect((await writer.stats()).continuity?.prepared).toBe(1);
    const prepared = await turn.prepareCommit([message("The completed answer.")], { providerSessionSynced: true });
    if ("append" in prepared) await prepared.append.commit(); else await prepared.commit();
    expect((await store.load(id)).map(m => m.content)).toEqual(["The completed answer."]);
    expect(reader.latestContinuitySummary(scope)).toBeUndefined();
    expect(reader.searchContinuity(scope).items.map(r => r.preview)).toEqual(["The completed answer."]);
    expect((await writer.stats()).continuity?.prepared).toBe(0);
  });

  it.each(["quota", "age"] as const)("keeps canonical %s retention working after summary pinning", async mode => {
    const dir = await root(), { writer, reader, continuity, store } = await setup(dir);
    await store.append(id, [message("An older canonical answer.")]);
    const turn = await store.contextImport!.beginExclusiveTurn(id);
    const checkpoint = { version: 1 as const, checkpointId: "fictional-checkpoint", journalId: "fictional-journal", operationId: "fictional-operation", summary: "A pinned summary.", model: "faux:m", trigger: "mid-run" as const, sourceDigest: "a".repeat(64) };
    await turn.prepareCompaction!(checkpoint);
    await turn.recordCompaction!({ checkpoint, task_run_id: "fictional-run", model: "faux:m", provider_kind: "pi", trigger: "mid-run", summary: checkpoint.summary, tokens_before: 100, first_kept_entry_id: null, status: "succeeded", created_at: 1 });
    await turn.abort();
    expect((await writer.stats()).continuity?.pins).toBe(1);
    const limited = createDurableHistoryStore({ root: dir, continuity, ...(mode === "quota" ? { maxConversations: 1 } : { maxAgeMs: 1, now: () => Date.now() + 100000 }) });
    await limited.append("web:quota", [message("Quota replacement.")]);
    expect(await store.load(id)).toEqual([]);
    expect(reader.latestContinuitySummary(scope)).toBeUndefined();
    expect((await writer.stats()).continuity?.pins).toBe(0);
  });

  it.each(["physical-reset", "logical-reset", "age-delete", "quota-delete"] as const)("durably owes a purge across a writer outage during %s", async mode => {
    const dir = await root(), { store, writer, reader, continuity } = await setup(dir);
    await store.append(id, [message("Text that must never survive its canonical purge.")]);
    const old = reader.searchContinuity(scope).items[0]!;
    await writer.close(); // Real unavailable writer, not a successful mock reset.
    if (mode === "physical-reset") await store.reset(id);
    else if (mode === "logical-reset") await store.resetLogicalConversation!(id);
    else {
      const limited = createDurableHistoryStore({ root: dir, continuity, ...(mode === "quota-delete" ? { maxConversations: 1 } : { maxAgeMs: 1, now: () => Date.now() + 100000 }) });
      await limited.append("web:replacement", [message("Replacement canonical answer.")]);
    }
    expect(await store.load(id)).toEqual([]);
    expect(pendingContinuityPurges(dir).length).toBeGreaterThan(0);
    expect(reader.searchContinuity(scope)).toMatchObject({ available: false, items: [] });
    expect(reader.getContinuity({ ...scope, recordId: old.recordId }).status).toBe("unavailable");
    // Brand-new writer/participant: neither the purge nor read suppression depends
    // on the old participant's in-memory outage queue.
    const recovered = await setup(dir);
    expect(pendingContinuityPurges(dir)).toEqual([]);
    expect(recovered.reader.getContinuity({ ...scope, recordId: old.recordId }).status).toBe("unavailable");
    expect((await recovered.writer.stats()).continuity?.records).toBe(0);
    await recovered.store.append(id, [message("New text after purge recovery.")]);
    await recovered.writer.stats(); await recovered.writer.stats();
    expect(recovered.reader.searchContinuity(scope).items.map(row => row.preview)).toEqual(["New text after purge recovery."]);
    expect(pendingContinuityPurges(dir)).toEqual([]); // Not re-applied to new capture.
  });

  it.each(["logical", "physical"] as const)("suppresses only the covered logical query while a %s journal awaits an already-open writer", async purgeScope => {
    const dir = await root(), { writer, reader } = await setup(dir), child = `${id}:day:2026-10-01`;
    const continuity = createContinuityParticipant({ writer, reader, logicalConversationId: conversation => conversation === child ? id : conversation, protectedConversations: () => [] });
    const store = createDurableHistoryStore({ root: dir, continuity });
    await store.append(child, [message("Older bucket quotation.")]);
    await store.append("web:unrelated", [message("Unrelated quotation.")]);
    const old = reader.searchContinuity(scope).items[0]!;
    persistContinuityPurge(dir, { scope: purgeScope, conversationId: purgeScope === "logical" ? id : child });
    expect(reader.searchContinuity(scope)).toMatchObject({ available: false, items: [] });
    expect(reader.getContinuity({ ...scope, recordId: old.recordId }).status).toBe("unavailable");
    expect(reader.latestContinuitySummary(scope)).toBeUndefined();
    expect(reader.searchContinuity({ ...scope, logicalConversationId: "web:unrelated", currentConversationId: "web:unrelated" }).items).toHaveLength(1);
    await writer.stats(); // Existing writer applies an intent created after acquisition.
    expect(pendingContinuityPurges(dir)).toEqual([]);
    expect(reader.getContinuity({ ...scope, recordId: old.recordId }).status).toBe("unavailable");
    await store.append(child, [message("New bucket quotation.")]);
    await writer.stats();
    expect(reader.searchContinuity(scope).items.map(row => row.preview)).toEqual(["New bucket quotation."]);
  });

  it.each(["web:fiction\nchild", "web:fiction\u0001child", "web:" + "\u0001".repeat(4092)])("does not narrow legacy canonical reset IDs through the sidecar journal (%#)", async conversationId => {
    const dir = await root(), { writer, store } = await setup(dir);
    await store.append(conversationId, [message("Canonical-only quotation.")]);
    await writer.close();
    await expect(store.resetLogicalConversation!(conversationId)).resolves.toBeUndefined();
    expect(await store.load(conversationId)).toEqual([]);
    expect(pendingContinuityPurges(dir).length).toBeGreaterThan(0);
    const recovered = await setup(dir);
    expect(pendingContinuityPurges(dir)).toEqual([]);
    expect((await recovered.writer.stats()).continuity?.records).toBe(0);
  });

  it.each(["age", "quota"] as const)("evicts inactive stranded publish and checkpoint preparations by %s", async mode => {
    const dir = await root(), { store, writer, reader, continuity } = await setup(dir);
    for (const action of ["publish", "checkpoint"] as const) {
      const conversationId = `web:stranded-${action}`;
      await store.append(conversationId, [message(`Old ${action} answer.`)]);
      const generation = reader.searchContinuity({ ...scope, logicalConversationId: conversationId, currentConversationId: conversationId }).items[0]!.generationId;
      const database = new DatabaseSync(reader.databasePath, { readOnly: true });
      const digest = (database.prepare("SELECT after_digest FROM continuity_generations WHERE generation_id=?").get(generation) as { after_digest: string }).after_digest;
      database.close();
      // Prepare directly to simulate process death after staging evidence. No
      // active canonical marker or dirty fence remains to protect this owner.
      await writer.prepareContinuity({ generationId: "chg1_" + (action === "publish" ? "a" : "b").repeat(32), conversationId, logicalConversationId: conversationId,
        action, beforeDigest: digest, afterDigest: action === "checkpoint" ? digest : "b".repeat(64),
        records: action === "checkpoint" ? [{ recordId: continuityRecordId(conversationId, "stranded-summary"), runId: "fictional-run", kind: "summary", sequence: 0, provenance: "generated", text: "A stranded checkpoint summary.",
          source: { journalId: "fictional-journal", operationId: "fictional-operation" }, summary: { model: "faux:m", operationId: "fictional-operation", trigger: "mid-run", coverage: { sourceDigest: "a".repeat(64) } } }] : [] });
      expect(digest).toBeTruthy();
    }
    expect((await writer.stats()).continuity?.prepared).toBe(2);
    const limited = createDurableHistoryStore({ root: dir, continuity, ...(mode === "quota" ? { maxConversations: 1 } : { maxAgeMs: 1, now: () => Date.now() + 100000 }) });
    await expect(limited.append("web:replacement", [message("An append that must fit.")])).resolves.toBeUndefined();
    for (const action of ["publish", "checkpoint"]) {
      expect(await store.load(`web:stranded-${action}`)).toEqual([]);
      expect(reader.searchContinuity({ ...scope, logicalConversationId: `web:stranded-${action}`, currentConversationId: `web:stranded-${action}` }).items).toEqual([]);
    }
    expect((await writer.stats()).continuity?.prepared).toBe(0);
    await limited.append("web:next", [message("Another append still fits.")]);
  });

  it("does not attribute a protection-query outage to a previously reconciled conversation", async () => {
    const { reader, writer } = await setup(await root()), warnings: string[] = [];
    const recordGap = vi.spyOn(writer, "recordContinuityGap");
    const participant = createContinuityParticipant({ writer, reader, logicalConversationId: id => id,
      protectedConversations: () => { throw new Error("Fictional retention query outage"); }, onWarning: text => warnings.push(text) });
    await participant.reconcile({ conversationId: id, assertOwned: async () => {}, current: { digest: null, messages: [] } });
    expect(await participant.protectedConversations()).toEqual([]);
    expect(warnings).toHaveLength(1); expect(recordGap).not.toHaveBeenCalled();
    expect(reader.continuityGaps(id).total).toBe(0);
  });

  it("defers outage gaps until a successful operation instead of making a second failing call", async () => {
    const { writer, reader } = await setup(await root());
    const reconcile = vi.spyOn(writer, "reconcileContinuity").mockRejectedValueOnce(new Error("Fictional outage"));
    const recordGap = vi.spyOn(writer, "recordContinuityGap");
    const participant = createContinuityParticipant({ writer, reader, logicalConversationId: id => id, protectedConversations: () => [] });
    const context = { conversationId: id, assertOwned: async () => {}, current: { digest: null, messages: [] } };
    await participant.reconcile(context);
    expect(reconcile).toHaveBeenCalledTimes(1); expect(recordGap).not.toHaveBeenCalled();
    await participant.reconcile(context);
    expect(recordGap).toHaveBeenCalledTimes(1);
    expect(reader.continuityGaps(id).items).toEqual([expect.objectContaining({ reason: "sidecar_unavailable" })]);
  });

  it("preserves the original preparation error type when reconciliation cleanup also fails", async () => {
    const { store } = await setup(await root());
    const original = Object.assign(new TypeError("Fictional classified preparation failure"), { code: "fictional_quota" });
    let recovery: ReturnType<typeof vi.spyOn> | undefined;
    const stage = vi.spyOn(store as any, "writeStage").mockImplementationOnce(async () => {
      recovery = vi.spyOn(store as any, "reconcileContinuity").mockRejectedValueOnce(new Error("Fictional recovery failure"));
      throw original;
    });
    try { await expect(store.prepareAppend!(id, [message("Unpublished answer.")])).rejects.toBe(original); }
    finally { stage.mockRestore(); recovery?.mockRestore(); }
    expect((await store.stats()).postCommitMaintenanceFailures).toBeGreaterThan(0);
  });

  it.each(["bounds", "quota"] as const)("records a content-free gap when capture exceeds %s", async reason => {
    const dir = await root();
    const writer = await ToolHistoryWriter.open({ root: dir, continuityEnabled: true, retention: { maxBytes: reason === "quota" ? 1 : 100000 } }); writers.add(writer);
    const reader = new ToolHistoryReader(dir), warnings: string[] = [];
    const continuity = createContinuityParticipant({ writer, reader, logicalConversationId: id => id, protectedConversations: () => reader.protectedContinuityConversations(), onWarning: text => warnings.push(text) });
    if (reason === "bounds") {
      expect(await continuity.prepare({ conversationId: id, assertOwned: async () => {}, action: "publish", before: { digest: null, messages: [] },
        after: { digest: "a".repeat(64), messages: Array.from({ length: 129 }, () => message("Skipped fictional content.")) } })).toBeUndefined();
    } else await createDurableHistoryStore({ root: dir, continuity }).append(id, [message("Skipped fictional content.")]);
    expect(reader.continuityGaps(id).items).toEqual([expect.objectContaining({ reason: reason === "bounds" ? "capture_bounds" : "capture_quota" })]);
    expect(JSON.stringify(reader.continuityGaps(id))).not.toContain("Skipped fictional content");
    expect((await writer.stats()).continuity).toMatchObject({ records: 0, prepared: 0, degraded: true, coverageGaps: 1 });
    expect(warnings).not.toEqual([]);
  });

  it("keeps prepared text invisible, discards aborts, and captures bounded rollover without duplicating retained messages", async () => {
    const dir = await root(), { writer, reader, continuity } = await setup(dir);
    const store = createDurableHistoryStore({ root: dir, continuity, maxMessages: 2 });
    const aborted = await store.prepareAppend!(id, [message("Unpublished draft")]);
    expect(reader.searchContinuity(scope).items).toEqual([]);
    await aborted.abort(); expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 0 });
    await store.append(id, [message("Morgan chose cobalt.")]);
    await store.append(id, [message("The second completed answer.")]);
    await store.append(id, [message("The third completed answer.")]);
    expect(await store.load(id)).toHaveLength(2);
    const records = reader.searchContinuity(scope).items;
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.preview)).toContain("Morgan chose cobalt.");
    expect(records.every((r) => r.provenance === "unknown")).toBe(true);
  });

  it.each(["exclusive", "provider"] as const)("serializes %s evidence admission before abort releases its borrowed owner", async (kind) => {
    const { store } = await setup(await root());
    const turn = kind === "exclusive" ? await store.contextImport!.beginExclusiveTurn(id) : await store.beginProviderSessionTurn!(id, "fictional-owned-run");
    let entered!: () => void, release!: () => void, aborted = false;
    const started = new Promise<void>(yes => { entered = yes; }), gate = new Promise<void>(yes => { release = yes; });
    const publication = turn.withContinuityOwner!(async () => { entered(); await gate; return "admitted"; });
    await started;
    const abort = turn.abort().then(() => { aborted = true; });
    await new Promise<void>(yes => setImmediate(yes)); expect(aborted).toBe(false);
    release(); expect(await publication).toBe("admitted"); await abort; expect(aborted).toBe(true);
    await expect(turn.withContinuityOwner!(async () => undefined)).rejects.toThrow("settled");
  });

  it("clears physical evidence only with a durable reset, then allows new capture", async () => {
    const dir = await root(), { store, writer, reader } = await setup(dir);
    await store.append(id, [message("Old completed answer.")]);
    const old = reader.searchContinuity(scope).items[0]!;
    await writer.pinContinuity({ logicalConversationId: id, recordId: old.recordId, ownerKind: "handoff", ownerId: "fictional-reference" });
    await store.resetLogicalConversation!(id);
    expect(reader.searchContinuity(scope).items).toEqual([]);
    expect(reader.getContinuity({ ...scope, recordId: old.recordId }).status).toBe("unavailable");
    expect((await writer.stats()).continuity).toMatchObject({ pins: 0, records: 0, coverageGaps: 0 });
    await store.append(id, [message("New completed answer.")]);
    expect(reader.searchContinuity(scope).items.map((r) => r.preview)).toEqual(["New completed answer."]);
  });

  it("covers import/exclusive publication without promoting provenance envelopes or owner text", async () => {
    const dir = await root(), { store, reader } = await setup(dir);
    const imported = await store.contextImport!.prepareImport(id, { text: "Imported context.", idempotencyKey: "fiction-import", timestamp: "2026-10-01T12:00:00.000Z" });
    await imported.append!.commit();
    expect(reader.searchContinuity(scope).items.map((r) => r.preview)).toEqual(["Imported context."]);
    const exclusive = await store.contextImport!.beginExclusiveTurn(id);
    await (await exclusive.prepareCommit([message("Verbatim completed answer.")])).append.commit();
    const records = reader.searchContinuity(scope).items;
    expect(records.map((r) => r.preview)).toEqual(["Verbatim completed answer.", "Imported context."]);
    expect(records.map(r => [r.kind, r.provenance])).toEqual([["assistant", "unknown"], ["imported", "unknown"]]);
  });

  it("does not retain cancelled/failed stream envelopes as completed assistant evidence", async () => {
    const dir = await root(), { store, reader } = await setup(dir);
    await store.append(id, [
      { role: "user", content: "A retained input." },
      { ...message("Unfinished cancellation stream and nested retrieval data."), idempotencyKey: "cancelled-turn:v1:fictional-run" },
      { ...message("Unfinished failure stream and nested retrieval data."), idempotencyKey: "failed-turn:v1:fictional-run" },
    ]);
    expect(reader.searchContinuity(scope).items.map((r) => r.preview)).toEqual(["A retained input."]);
  });

  it("omits an unfinished detached candidate even if it was published in a durable canonical account", async () => {
    const dir = await root(), f = await fixture(dir);
    const { continuity, reader } = await setup(join(dir, "history"));
    const { store } = openStore(dir, undefined, { continuity, reconcileProviderSessionTurn: async () => ({ status: "absent" }) });
    await ready({ ...f, store }); await store.rollForwardModelSwitch(bucket, f.state.identity.switchId, {});
    const turn = await store.beginProviderSessionTurn(bucket, "fictional-detached", { modelKey: "faux:B", reconciliation: {
      purpose: "execution", ownerKey: bucket, initial: { persistText: "A durable input.", timestamp: "2026-10-01T12:00:00.000Z" } } });
    await turn.reconciliation!.claim("detached", { outcome: "interrupted", text: "An unfinished assistant draft.", timestamp: "2026-10-01T12:00:00.000Z", error: null, failureKind: "interrupted" });
    await turn.abort(); await store.recoverProviderSessionTurn(bucket);
    expect((await store.load(bucket)).some((m: { content: string }) => m.content === "An unfinished assistant draft.")).toBe(true);
    expect(reader.searchContinuity({ ...scope, currentConversationId: bucket, logicalConversationId: bucket }).items.map((r) => r.preview)).toEqual(["A durable input."]);
  });

  it("acknowledges legacy inactive epoch rotation before its existing maintenance owner releases", async () => {
    const dir = await root(), { writer, reader, continuity } = await setup(dir);
    const store = createDurableHistoryStore({ root: dir, continuity, retireProviderSession: async () => {} });
    await store.append(id, [message("Existing completed answer.")]);
    const turn = await store.beginProviderSessionTurn(id, "fiction-aborted-turn"); await turn.abort();
    await store.append("web:maintenance", [message("Unrelated completed answer.")]);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 2 });
    expect(reader.searchContinuity(scope).items.map((r) => r.preview)).toEqual(["Existing completed answer."]);
  });

  it("borrows an already held logical owner to retire a sibling daily bucket's inactive fence", async () => {
    const dir = await root(), { continuity } = await setup(dir), retired: string[] = [];
    const store = createDurableHistoryStore({ root: dir, continuity, retireProviderSession: async id => { retired.push(id); } });
    const first = `${id}#2026-10-01`, second = `${id}#2026-10-02`;
    await store.append(first, [message("First daily bucket answer.")]);
    const prior = await store.beginProviderSessionTurn!(first, "fictional-aborted-run"); await prior.abort();
    const next = await store.contextImport!.beginExclusiveTurn(second);
    await next.abort();
    expect(retired).toEqual([prior.providerSessionId]);
  });

  it("covers model-switch and direct/prepared native publication without taking another owner", async () => {
    const dir = await root(), f = await fixture(dir);
    const { continuity, reader, writer } = await setup(join(dir, "history"));
    const { store } = openStore(dir, undefined, { continuity });
    await ready({ ...f, store }); await store.rollForwardModelSwitch(bucket, f.state.identity.switchId, {});
    const nativeScope = { ...scope, currentConversationId: bucket, logicalConversationId: bucket };
    await store.append(bucket, [message("Completed native cold append.")]);
    const turn = await store.beginProviderSessionTurn(bucket, "fictional-unsynced", { modelKey: "faux:B" });
    await (await turn.prepareCommit([message("Completed unsynced provider answer.")], { providerSessionSynced: false })).commit();
    expect(reader.searchContinuity(nativeScope).items.map((r) => r.preview)).toEqual(["Completed unsynced provider answer.", "Completed native cold append."]);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0 });
    await store.reset(bucket);
    expect(reader.searchContinuity(nativeScope).items).toEqual([]);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, pins: 0, records: 0 });
  });

  it("reconciles a native reset acknowledgement gap under its maintenance owner before dropping the intent", async () => {
    const dir = await root(), f = await fixture(dir);
    const { continuity, reader, writer } = await setup(join(dir, "history"));
    const { store } = openStore(dir, undefined, { continuity });
    await ready({ ...f, store }); await store.rollForwardModelSwitch(bucket, f.state.identity.switchId, {});
    await store.append(bucket, [message("Completed answer before reset.")]);
    const { store: interrupted } = openStore(dir, undefined, { continuity, onContinuityPhase: async (phase: string) => {
      if (phase === "canonical_durable") throw new Error("Fictional reset acknowledgement interruption.");
    } });
    await expect(interrupted.reset(bucket)).rejects.toThrow("acknowledgement interruption");
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 1 });
    expect(reader.searchContinuity({ ...scope, currentConversationId: bucket, logicalConversationId: bucket }).items).toEqual([]);
    await store.append("fictional-maintenance", [message("Unrelated completed answer.")]);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 1 });
    expect((await readdir(join(dir, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
  });

  it("does not canonical-retain away pinned evidence and releases failed reservations", async () => {
    const dir = await root(), { continuity, writer, reader, store } = await setup(dir);
    await store.append(id, [message("Pinned completed answer.")]);
    const old = reader.searchContinuity(scope).items[0]!;
    await writer.pinContinuity({ logicalConversationId: id, recordId: old.recordId, ownerKind: "handoff", ownerId: "fictional-reference" });
    const limited = createDurableHistoryStore({ root: dir, continuity, maxConversations: 1 });
    await expect(limited.append("web:other", [message("Not admitted.")])).rejects.toThrow("quota");
    expect(await store.load(id)).toHaveLength(1);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 1, pins: 1 });
    await writer.unpinContinuity({ logicalConversationId: id, recordId: old.recordId, ownerKind: "handoff", ownerId: "fictional-reference" });
    await limited.append("web:other", [message("Now admitted.")]);
    expect(await store.load(id)).toEqual([]);
    expect(reader.getContinuity({ ...scope, recordId: old.recordId }).status).toBe("unavailable");
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 1, pins: 0 });
  });

  it("keeps explicit false paths byte-identical with no participant, probe, phase or v3 upgrade", async () => {
    const baseline = await root(), disabled = await root();
    const legacy = createDurableHistoryStore({ root: baseline });
    await legacy.append(id, [message("Existing completed answer.")]);
    const before = await ToolHistoryWriter.open({ root: baseline, continuityEnabled: false }); await before.close();
    await cp(baseline, disabled, { recursive: true });
    const off = createDurableHistoryStore({ root: disabled, onContinuityPhase: async () => { throw new Error("OFF must not enter continuity"); } });
    // Reusing the same copied epoch avoids the independent entropy of a cold
    // append; compare actual canonical serialization, not normalized JSON.
    for (const store of [legacy, off]) {
      const turn = await store.beginProviderSessionTurn(id, "same-successful-turn");
      await (await turn.prepareCommit([message("Same later answer.")], { providerSessionSynced: true })).commit();
    }
    const file = `${historyKey(id)}.history.json`;
    expect(await readFile(join(disabled, file))).toEqual(await readFile(join(baseline, file)));
    expect(await readFile(join(disabled, "tool-history/tool-lifecycles.sqlite"))).toEqual(await readFile(join(baseline, "tool-history/tool-lifecycles.sqlite")));
    expect((await readdir(disabled)).some((name) => name.includes("continuity"))).toBe(false);
  });

  it.each(["continuity_prepared", "canonical_durable", "continuity_committed"])("recovers real process death at %s before another canonical mutation", async (phase) => {
    const dir = await root(); await crash(dir, phase);
    const { store, reader, writer } = await setup(dir);
    await store.append(id, [message("Next successful answer.")]);
    const records = reader.searchContinuity(scope).items;
    expect(records.map((r) => r.preview)).toEqual(phase === "continuity_prepared"
      ? ["Next successful answer."] : ["Next successful answer.", "Morgan chose cobalt."]);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, coverageGaps: 0 });
  });

  it("abandons stranded preparation after OFF canonical mutations, reports a gap, releases pins and admits new evidence", async () => {
    const dir = await root(); await crash(dir, "continuity_prepared", true);
    const off = createDurableHistoryStore({ root: dir });
    await off.append(id, [message("Uncaptured OFF interval answer.")]);
    const { store, reader, writer } = await setup(dir);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 1, pins: 1 });
    await store.append(id, [message("Re-enabled answer.")]);
    expect(reader.searchContinuity(scope).items.map((r) => r.preview)).toEqual(["Re-enabled answer."]);
    expect(reader.continuityGaps(id)).toMatchObject({ total: 1, items: [{ reason: "canonical_advanced_past_preparation" }] });
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, pins: 0, records: 1, coverageGaps: 1 });
  });
});

async function crash(dir: string, phase: string, pin = false): Promise<void> {
  const fixture = join(dir, "crash.mjs");
  const entry = new URL("../../dist/index.js", import.meta.url).href;
  await writeFile(fixture, `
    import { DatabaseSync } from 'node:sqlite';
    import { createDurableHistoryStore, ToolHistoryWriter, ToolHistoryReader, createContinuityParticipant } from ${JSON.stringify(entry)};
    const root = process.argv[2], phase = process.argv[3], id = 'web:fiction';
    const writer = await ToolHistoryWriter.open({root,continuityEnabled:true}), reader = new ToolHistoryReader(root);
    const continuity = createContinuityParticipant({writer,reader,logicalConversationId:id=>id,protectedConversations:()=>reader.protectedContinuityConversations()});
    const store = createDurableHistoryStore({root,continuity,onContinuityPhase:async point=>{
      if(point!==phase)return;
      if(process.argv[4]==='pin') {
        const db = new DatabaseSync(root+'/tool-history/tool-lifecycles.sqlite');
        const row = db.prepare('SELECT record_id FROM continuity_records LIMIT 1').get(); db.close();
        await writer.pinContinuity({logicalConversationId:id,recordId:row.record_id,ownerKind:'handoff',ownerId:'fictional-reference'});
      }
      process.kill(process.pid,'SIGKILL');
    }});
    await store.append(id,[{role:'assistant',content:'Morgan chose cobalt.',timestamp:'2026-10-01T12:00:00.000Z'}]);
  `);
  const child = spawnSync(process.execPath, [fixture, dir, phase, pin ? "pin" : ""], { encoding: "utf8", timeout: 30_000 });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}

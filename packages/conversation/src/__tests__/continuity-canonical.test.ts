import { spawnSync } from "node:child_process";
import { historyKey } from "../history/canonical/identity.js";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(records.every((r) => r.kind === "assistant" && r.provenance === "unknown")).toBe(true);
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

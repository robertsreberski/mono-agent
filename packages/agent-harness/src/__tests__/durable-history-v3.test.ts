import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import type { TurnHistoryV3 } from "../durable-turn-history.js";
import { recognizesTurnCommit } from "../durable-turn-history.js";

const dirs: string[] = [];
const conversationId = "fictional-bucket";
const hash = "a".repeat(64);
const modelKey = "openai:fictional-model";
const receipt = { version: 1 as const, turnId: "fictional-turn", inputDigest: hash, candidateDigest: hash,
  journalId: "fictional-journal", tipId: "fictional-tip", baseRevision: 6, committedRevision: 7, outcome: "completed" as const };
const filename = `${createHash("sha256").update("mono-agent-history-v1\0").update(conversationId).digest("hex")}.history.json`;
const record = (): TurnHistoryV3 => ({ version: 3, conversationId, messages: [{ role: "assistant", content: "Fictional reply." }],
  providerSession: { epoch: hash, revision: 7, modelKey }, lastCommit: receipt });
async function fixture(value: unknown = record()) {
  const dir = await mkdtemp(join(tmpdir(), "history-v3-test-")); dirs.push(dir);
  const root = join(dir, "history"); await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  const path = join(root, filename); await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const retireProviderSession = vi.fn(async () => undefined);
  return { root, path, retireProviderSession,
    store: createDurableHistoryStore({ root, maxMessages: 1, retireProviderSession }),
    read: async () => JSON.parse(await readFile(path, "utf8")) as TurnHistoryV3 };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it.each([1, 2, 3])("reads version %i without migrating, retiring, or dispatching on load", async (version) => {
  const value = version === 1 ? { version, conversationId, messages: record().messages }
    : { ...record(), version, ...(version === 2 ? { lastCommit: undefined } : {}) };
  const f = await fixture(value); const before = await readFile(f.path);
  expect(await f.store.load(conversationId)).toEqual(record().messages);
  expect(await readFile(f.path)).toEqual(before); expect(f.retireProviderSession).not.toHaveBeenCalled();
  await f.store.append(conversationId, [{ role: "user", content: "Fictional follow-up." }]);
  expect((await f.read()).version).toBe(3);
});

it.each([{}, { revision: 4 }, { revision: 4, dirtyRunId: "fictional-old-run" }])("migrates a legacy v2 provider variant without guessing dirty continuity: %j", async (fields) => {
  const f = await fixture({ version: 2, conversationId, messages: record().messages, providerSession: { epoch: hash, ...fields } });
  const turn = await f.store.beginProviderSessionTurn(conversationId, "fictional-new-turn");
  expect(turn.providerSessionRevision).toBe("revision" in fields && !("dirtyRunId" in fields) ? 4 : 0);
  const append = await turn.prepareCommit([], { providerSessionSynced: true }); await append.commit();
  expect((await f.read()).version).toBe(3); expect((await f.read()).providerSession).not.toHaveProperty("dirtyRunId");
});

it("keeps the receipt after host-only rotation, message eviction, a cold turn, and native revision advancement", async () => {
  const f = await fixture();
  await f.store.append(conversationId, [{ role: "user", content: "Fictional delivery." }]);
  let value = await f.read(); expect(value.lastCommit).toEqual(receipt); expect(value.providerSession.revision).toBe(0);
  expect(value.messages).toEqual([{ role: "user", content: "Fictional delivery." }]);
  const turn = await f.store.beginProviderSessionTurn(conversationId, "fictional-next-turn", { modelKey });
  const append = await turn.prepareCommit([{ role: "assistant", content: "Fictional next reply." }], { providerSessionSynced: true });
  await append.commit(); value = await f.read();
  expect(value.providerSession.revision).toBe(1); expect(value.lastCommit).toEqual(receipt);
  expect(recognizesTurnCommit(value, conversationId, receipt.turnId, hash, hash)).toBe(true);
  expect(await createDurableHistoryStore({ root: f.root }).load(conversationId)).toEqual(value.messages);
});

it("keeps the receipt through an unsynced commit and an exclusive host-only commit", async () => {
  const f = await fixture(); const store = createDurableHistoryStore({ root: f.root, retireProviderSession: f.retireProviderSession });
  const turn = await store.beginProviderSessionTurn(conversationId, "fictional-failed-turn", { modelKey });
  const append = await turn.prepareCommit([{ role: "assistant", content: "Fictional failure account." }], { providerSessionSynced: false });
  await append.commit(); expect((await f.read()).lastCommit).toEqual(receipt);
  const exclusive = await store.contextImport!.beginExclusiveTurn(conversationId);
  const prepared = await exclusive.prepareCommit([{ role: "assistant", content: "Fictional delivery." }]);
  await prepared.append.commit(); expect((await f.read()).lastCommit).toEqual(receipt);
});

it("keeps a receipt-only bucket on context import but explicitly clears the receipt on reset", async () => {
  const f = await fixture({ ...record(), messages: [] });
  const store = createDurableHistoryStore({ root: f.root, retireProviderSession: f.retireProviderSession });
  const imported = await store.contextImport!.prepareImport(conversationId,
    { text: "Fictional context.", idempotencyKey: "fictional-import", timestamp: "2026-01-01T00:00:00.000Z" });
  await imported.append!.commit(); expect((await f.read()).lastCommit).toEqual(receipt);
  await store.reset(conversationId); const value = await f.read(); expect(value.version).toBe(3);
  expect(value.messages).toEqual([]); expect(value.lastCommit).toBeUndefined();
});

it.each([
  { ...record(), deliveryKey: "fictional-private" },
  { ...record(), lastCommit: { ...receipt, ownerText: "fictional-private" } },
  { ...record(), lastCommit: { ...receipt, committedRevision: 9 } },
  { ...record(), providerSession: { ...record().providerSession, dirtyRunId: "fictional-run" } },
  { ...record(), providerSession: { epoch: hash } },
  { ...record(), messages: [{ role: "assistant", content: "Fictional reply.", metadata: {} }] },
])("rejects malformed v3 fields without changing canonical bytes", async (value) => {
  const f = await fixture(value); const before = await readFile(f.path);
  await expect(f.store.load(conversationId)).rejects.toThrow();
  expect(await readFile(f.path)).toEqual(before); expect(f.retireProviderSession).not.toHaveBeenCalled();
});

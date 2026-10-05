import { afterEach, expect, it, vi } from "vitest";
const meter = vi.hoisted(() => ({ enabled: false, journal: 0, directory: 0, lock: 0, reads: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original();
  return { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); const path = String(args[0]);
    const sync = handle.sync.bind(handle), read = handle.read.bind(handle);
    handle.sync = async (...rest) => { if (meter.enabled) meter[path.includes(".jsonl") ? "journal" : path.endsWith(".sqlite") ? "lock" : "directory"] += 1; return sync(...rest); };
    handle.read = async (...rest) => { if (meter.enabled && path.includes(".jsonl")) meter.reads += 1; return read(...rest); };
    return handle;
  } };
});
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";
import { JournalReader } from "../journal-reader.js";
const roots = [];
afterEach(async () => { meter.enabled = false; vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const reset = () => { Object.assign(meter, { journal: 0, directory: 0, lock: 0, reads: 0, enabled: true }); };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "durability-cost-")); roots.push(root); const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const raw = await repo.create({ id: "fictional-cost" });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "cost" }], tokensPerSecond: undefined }); const models = createModels(); models.setProvider(faux.provider);
  return { root, repo, raw, faux, models };
}
async function turn(raw, faux, models) {
  let effects = 0;
  faux.setResponses([fauxAssistantMessage([fauxToolCall("Read", {}, { id: `call-${raw.seq}` })]), fauxAssistantMessage([fauxText("Fictional completed.")])]);
  const driver = createRunDriver(raw, { models, model: faux.getModel(), systemPrompt: "Fictional test.", retry: { enabled: false },
    tools: [{ name: "Read", description: "Fictional bounded read", parameters: { type: "object", properties: {} }, execute: async () => {
      expect([...raw.validator.calls.values()].at(-1).admission).toBe("started"); expect(meter.journal).toBe(5);
      effects += 1; return { content: [{ type: "text", text: "Fictional observation." }] };
    } }] });
  expect((await driver.prompt("Fictional tool turn.")).status).toBe("completed"); expect(effects).toBe(1); await driver.close();
}
it("keeps all nine tool-turn file barriers but zero repeated directory fsyncs or parsed-envelope reads", async () => {
  const { repo, raw, faux, models } = await fixture(); reset();
  await turn(raw, faux, models);
  const first = { journal: meter.journal, directory: meter.directory, lock: meter.lock, reads: meter.reads };
  console.log("durability-cost", JSON.stringify(first));
  expect(first).toEqual({ journal: 9, directory: 0, lock: 0, reads: 0 });
  const metadata = raw.metadata; await raw.close(); const scan = vi.spyOn(JournalReader.prototype, "scan"); reset();
  const reopened = await repo.open(metadata); expect(scan).not.toHaveBeenCalled();
  expect({ journal: meter.journal, directory: meter.directory, lock: meter.lock, reads: meter.reads }).toEqual({ journal: 0, directory: 0, lock: 0, reads: 0 });
  await turn(reopened, faux, models); expect(meter.journal).toBe(9); expect(meter.directory).toBe(0); expect(meter.reads).toBe(0);
  await reopened.close();
});
it("only reuses a warm index for the exact unchanged inode/version/header, and sees another writer's tail", async () => {
  const { repo, raw, root } = await fixture(); await raw.appendMessage({ role: "user", content: "Fictional original." }); await raw.sync(); const metadata = raw.metadata; await raw.close();
  const scan = vi.spyOn(JournalReader.prototype, "scan");
  await expect(repo.open({ ...metadata, id: "wrong-handle" })).rejects.toThrow(); expect(scan).toHaveBeenCalledTimes(1);
  const first = await repo.open(metadata); await first.close(); scan.mockClear();
  const other = new JsonlSessionRepo({ sessionsRoot: root }); const writer = await other.open(metadata);
  await writer.appendMessage({ role: "user", content: "Fictional other-process tail." }); await writer.sync(); await writer.close(); scan.mockClear();
  const reopened = await repo.open(metadata); expect(scan).toHaveBeenCalledTimes(1);
  expect((await reopened.getEntries()).at(-1).message.content).toBe("Fictional other-process tail."); await reopened.close();
});
it("invalidates envelope and warm caches on rewind/retire and rejects same-inode edits while owned", async () => {
  const { repo, raw } = await fixture(); const a = await raw.appendMessage({ role: "user", content: "Fictional first." });
  await raw.appendMessage({ role: "user", content: "Fictional second." }); await raw.sync(); await raw.getEntries();
  expect(raw.io.cached(raw.entries.get(a).address)).toBeDefined(); await raw.moveTo(a); expect(raw.io.cached(raw.entries.get(a).address)).toBeUndefined();
  expect((await raw.getEntries()).map((entry) => entry.message.content)).toEqual(["Fictional first."]); await raw.sync();
  const original = await readFile(raw.metadata.path, "utf8"); await writeFile(raw.metadata.path, original.replace("Fictional first.", "Fictional third."));
  await expect(raw.getEntries()).rejects.toMatchObject({ name: "JournalStorageError" }); expect(raw.io.cached(raw.entries.get(a).address)).toBeUndefined();
  await raw.close().catch(() => {}); expect(repo.warm).toBeNull();
  const store = await repo.open(raw.metadata); await repo.retire(store.metadata); await store.close(); expect(repo.warm).toBeNull(); expect(await repo.listOwned()).toEqual([]);
});

it("reopens a clean closed journal without lock/directory fsync or a full file scan", async () => {
  const { repo, raw } = await fixture(); await raw.appendMessage({ role: "user", content: "Fictional durable prefix." }); await raw.sync(); const metadata = raw.metadata; await raw.close(); reset();
  const reopened = await repo.open(metadata);
  const counts = { journal: meter.journal, directory: meter.directory, lock: meter.lock, reads: meter.reads };
  console.log("warm-reopen-cost", JSON.stringify(counts));
  try { expect(counts).toEqual({ journal: 0, directory: 0, lock: 0, reads: 0 }); }
  finally { await reopened.close(); }
});
it("still syncs new journal/lock directory publication and retirement unlink", async () => {
  reset(); const { repo, raw } = await fixture();
  expect(meter.lock).toBe(2); expect(meter.journal).toBeGreaterThanOrEqual(2); expect(meter.directory).toBeGreaterThanOrEqual(5);
  await raw.sync(); const metadata = raw.metadata; await raw.close(); reset();
  await repo.retire(metadata); expect(meter.directory).toBeGreaterThanOrEqual(4); expect(await repo.listOwned()).toEqual([]);
});

it("serializes verified cache batches against legitimate queued appends instead of falsely poisoning their version", async () => {
  const { raw } = await fixture(); await raw.appendMessage({ role: "user", content: "Fictional prefix." }); await raw.sync();
  const verify = raw.io.verify; let entered, release, once = true;
  const waiting = new Promise((resolve) => { entered = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  raw.io.verify = async () => { if (once) { once = false; entered(); await gate; } return verify(); };
  const read = raw.getEntries(); await waiting; const seq = raw.seq; const append = raw.appendMessage({ role: "user", content: "Fictional concurrent tail." });
  await new Promise((resolve) => setImmediate(resolve)); expect(raw.seq).toBe(seq); release();
  expect((await read).map((entry) => entry.message.content)).toEqual(["Fictional prefix."]); await append;
  expect((await raw.getEntries()).at(-1).message.content).toBe("Fictional concurrent tail."); expect(raw.failure).toBeNull(); await raw.close();
});

it("caches the exact serialized envelope, not an in-memory object with dropped undefined/date properties", async () => {
  const { repo, raw, root } = await fixture();
  const message = { role: "user", content: [{ type: "text", text: "Fictional serialization proof.", absent: undefined }], opaque: { date: new Date("2000-01-01T00:00:00Z"), absent: undefined } };
  const expected = JSON.parse(JSON.stringify(message)); await raw.appendMessage(message); await raw.sync();
  expect((await raw.getEntries()).at(-1).message).toEqual(expected); const metadata = raw.metadata; await raw.close();
  const warm = await repo.open(metadata); expect((await warm.getEntries()).at(-1).message).toEqual(expected); await warm.close();
  const cold = await new JsonlSessionRepo({ sessionsRoot: root }).open(metadata); expect((await cold.getEntries()).at(-1).message).toEqual(expected); await cold.close();
});

it("still fsyncs unsynced closed-prefix evidence before admitting a warm reopened writer", async () => {
  const { repo, raw } = await fixture(); await raw.appendMessage({ role: "user", content: "Fictional unsealed file prefix." });
  expect(raw.durableSeq).toBeLessThan(raw.seq); const metadata = raw.metadata; await raw.close(); reset();
  const reopened = await repo.open(metadata); expect(meter.journal).toBe(1); expect(meter.directory).toBe(0); expect(reopened.durableSeq).toBe(reopened.seq);
  expect((await reopened.getEntries()).at(-1).message.content).toBe("Fictional unsealed file prefix."); await reopened.close();
});

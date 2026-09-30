import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, stat, symlink, writeFile, rm } from "node:fs/promises";

// Deterministic directory-swap window: enumerate a real directory, replace it
// before the reader opens the child. A final-component no-follow flag alone
// cannot detect this redirect.
const swapRead = vi.hoisted(() => ({ handler: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, readdir: async (...args) => {
    const listing = await fs.readdir(...args);
    if (swapRead.handler) await swapRead.handler(args[0]);
    return listing;
  } };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import { salvageDurableNativeSession } from "../../ai/providers/pi-native/session-salvage.js";

const roots = [];
afterEach(async () => { swapRead.handler = null; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const assistant = { role: "assistant", content: [{ type: "text", text: "Draft only" }, { type: "toolCall", id: "call-1", name: "Write", arguments: { path: "/private/never" } }, { type: "toolCall", id: "call-2", name: "Exec", arguments: {} }] };
const result = { role: "toolResult", toolCallId: "call-1", toolName: "Write", content: [{ type: "text", text: "done" }] };
const row = (seq, kind, rest) => ({ seq, kind, ...rest });
const entry = (seq, id, parentId, message) => row(seq, "entry", { id, parentId, type: "message", timestamp: 1, message });
const tip = (seq, id, key = "main") => row(seq, "value", { op: "set", namespace: "pi.branch.tip", key, value: id });
async function fixture(transactions, tail = "", id = "session-1") {
  const root = await mkdtemp(join(tmpdir(), "pi-salvage-")); roots.push(root);
  const dir = join(root, "2026-01-01"); await mkdir(dir);
  const path = join(dir, `2026-01-01_${id}.jsonl`);
  const content = `${[JSON.stringify({ kind: "header", v: 4, storageVersion: 1, id, cwd: "/fictional", createdAt: 1 }), ...transactions.map(JSON.stringify)].join("\n")}\n${tail}`;
  await writeFile(path, content);
  return { root, path, id };
}
async function unchanged(path, work) {
  const bytes = await readFile(path); const before = await stat(path);
  await work();
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
}
const placed = [entry(1, "a", null, assistant), entry(2, "r", "a", result), tip(3, "r")];
describe("read-only Pi v4 salvage", () => {
  it("requires placed matching results on main; staged, pending and orphan results are not completed", async () => {
    const { root, path, id } = await fixture([placed, row(4, "value", { op: "set", namespace: "pi.pending.entry", key: "pending", value: { type: "message", payload: { role: "toolResult", toolCallId: "call-2", toolName: "Exec" } } })]);
    await unchanged(path, async () => {
      const snapshot = await salvageDurableNativeSession(id, root);
      expect(snapshot.completed).toEqual([{ name: "Write", result: "done" }]);
      expect(snapshot.outcomeUnknown).toEqual([{ name: "Exec" }]);
      expect(snapshot.draftText).toBe("Draft only");
      expect(JSON.stringify(snapshot)).not.toContain("/private/never");
    });
  });
  it("reports staged-only assistant calls as unknown and flags unclassifiable pending state", async () => {
    const user = entry(1, "u", null, { role: "user", content: [{ type: "text", text: "Do work" }] });
    const staged = row(3, "value", { op: "set", namespace: "pi.pending.entry", key: "assistant-a",
      value: { type: "message", payload: assistant } });
    const stagedResult = row(4, "value", { op: "set", namespace: "pi.pending.entry", key: "result-r",
      value: { type: "message", payload: result } });
    const f = await fixture([[user, tip(2, "u")], staged, stagedResult]);
    await unchanged(f.path, async () => {
      const snapshot = await salvageDurableNativeSession(f.id, f.root);
      expect(snapshot.completed).toEqual([]);
      expect(snapshot.outcomeUnknown).toEqual([{ name: "Write" }, { name: "Exec" }]);
      expect(snapshot.additionalOutcomesUnknown).toBe(true);
      expect(snapshot.draftText).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain("/private/never");
    });
  });
  it("keeps unattached assistant calls unknown without counting explicit sibling branches", async () => {
    const user = entry(1, "u", null, { role: "user", content: [] });
    const f = await fixture([[user, tip(2, "u"), entry(3, "orphan", "u", assistant)]]);
    await unchanged(f.path, async () => {
      const snapshot = await salvageDurableNativeSession(f.id, f.root);
      expect(snapshot.outcomeUnknown).toEqual([{ name: "Write" }, { name: "Exec" }]);
      expect(snapshot.completed).toEqual([]);
    });
    const other = await fixture([[user, entry(2, "sibling", "u", assistant), tip(3, "u"), tip(4, "sibling", "other")]]);
    await unchanged(other.path, async () => expect((await salvageDurableNativeSession(other.id, other.root)).outcomeUnknown).toEqual([]));
  });
  it("ignores non-main branch results and torn final transactions without repairing the file", async () => {
    const { root, path, id } = await fixture([entry(1, "a", null, assistant), tip(2, "a"), entry(3, "r", "a", result), tip(4, "r", "other")], '{"seq":5');
    await unchanged(path, async () => {
      const snapshot = await salvageDurableNativeSession(id, root);
      expect(snapshot.completed).toEqual([]);
      expect(snapshot.outcomeUnknown).toHaveLength(2);
      expect(snapshot.additionalOutcomesUnknown).toBe(true);
    });
  });
  it("treats a mismatched result as unknown and rejects duplicates and malformed complete transactions", async () => {
    const mismatch = { ...result, toolName: "Read" };
    const f = await fixture([[entry(1, "a", null, assistant), entry(2, "r", "a", mismatch), tip(3, "r")]]);
    await unchanged(f.path, async () => expect((await salvageDurableNativeSession(f.id, f.root)).outcomeUnknown).toHaveLength(2));
    const duplicate = await fixture([[...placed, entry(4, "r", "r", result)]]);
    await unchanged(duplicate.path, async () => expect(salvageDurableNativeSession(duplicate.id, duplicate.root)).rejects.toThrow());
    const malformed = await fixture([placed, { seq: 4, kind: "entry", id: "bad", parentId: "missing", timestamp: 1 }]);
    await unchanged(malformed.path, async () => expect(salvageDurableNativeSession(malformed.id, malformed.root)).rejects.toThrow());
  });
  it("rejects missing, legacy, duplicate, oversized and symlink files without changing bytes", async () => {
    const missing = await fixture([placed]); await rm(missing.path);
    await expect(salvageDurableNativeSession(missing.id, missing.root)).rejects.toThrow();
    const legacy = await fixture([placed]); await writeFile(legacy.path, '{"type":"session","version":3}\n');
    await unchanged(legacy.path, async () => expect(salvageDurableNativeSession(legacy.id, legacy.root)).rejects.toThrow());
    const duplicate = await fixture([placed]); const second = join(duplicate.root, "second"); await mkdir(second);
    await writeFile(join(second, `another_${duplicate.id}.jsonl`), await readFile(duplicate.path));
    await unchanged(duplicate.path, async () => expect(salvageDurableNativeSession(duplicate.id, duplicate.root)).rejects.toThrow());
    const oversized = await fixture([placed]); await writeFile(oversized.path, `${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
    await unchanged(oversized.path, async () => expect(salvageDurableNativeSession(oversized.id, oversized.root)).rejects.toThrow());
    const linked = await fixture([placed]); await symlink(linked.path, join(linked.root, "2026-01-01", `link_${linked.id}.jsonl`));
    await unchanged(linked.path, async () => expect(salvageDurableNativeSession(linked.id, linked.root)).rejects.toThrow());
  });
  it("refuses a session directory switched to an outside symlink after enumeration", async () => {
    const original = await fixture([placed]);
    const external = await fixture([placed]);
    const parent = join(original.root, "2026-01-01");
    const parked = join(original.root, "parked");
    const originalBytes = await readFile(original.path);
    const originalMtime = (await stat(original.path)).mtimeMs;
    swapRead.handler = async (path) => {
      if (path !== original.root) return;
      swapRead.handler = null;
      await rename(parent, parked);
      await symlink(join(external.root, "2026-01-01"), parent, "dir");
    };
    await unchanged(external.path, async () => {
      await expect(salvageDurableNativeSession(original.id, original.root)).rejects.toThrow();
    });
    const moved = join(parked, `2026-01-01_${original.id}.jsonl`);
    expect(await readFile(moved)).toEqual(originalBytes);
    expect((await stat(moved)).mtimeMs).toBe(originalMtime);
  });
  it("does not present failed assistant text as a draft and does not pair orphan results preceding a call", async () => {
    const failed = { role: "assistant", stopReason: "error", content: [{ type: "text", text: "failed answer" }, { type: "toolCall", id: "call-1", name: "Write" }] };
    const f = await fixture([[entry(1, "r", null, result), entry(2, "a", "r", failed), tip(3, "a")]]);
    await unchanged(f.path, async () => {
      const snapshot = await salvageDurableNativeSession(f.id, f.root);
      expect(snapshot.completed).toEqual([]);
      expect(snapshot.outcomeUnknown).toHaveLength(1);
      expect(snapshot.draftText).toBeUndefined();
    });
  });
  it("bounds completed pairs and reports omissions instead of presenting staged results as completed", async () => {
    const many = { role: "assistant", content: Array.from({ length: 12 }, (_, i) => ({ type: "toolCall", id: `c-${i}`, name: "Exec" })) };
    const writes = [entry(1, "a", null, many)];
    for (let i = 0; i < 12; i++) writes.push(entry(i + 2, `r-${i}`, i === 0 ? "a" : `r-${i - 1}`,
      { role: "toolResult", toolCallId: `c-${i}`, toolName: "Exec", content: [{ type: "text", text: "x".repeat(400) }] }));
    writes.push(tip(14, "r-11"));
    const { root, path, id } = await fixture([writes]);
    await unchanged(path, async () => {
      const snapshot = await salvageDurableNativeSession(id, root);
      expect(snapshot.completed).toHaveLength(8);
      expect(snapshot.omittedCompleted).toBe(4);
      expect(snapshot.outcomeUnknown).toEqual([]);
    });
  });
  it("bounds repeated call counts while preserving unknown outcome flags", async () => {
    const many = { role: "assistant", content: Array.from({ length: 16 }, (_, i) => ({ type: "toolCall", id: `c-${i}`, name: "Exec" })) };
    const { root, path, id } = await fixture([[entry(1, "a", null, many), tip(2, "a")]]);
    await unchanged(path, async () => {
      const snapshot = await salvageDurableNativeSession(id, root);
      expect(snapshot.outcomeUnknown).toHaveLength(8);
      expect(snapshot.omittedUnknown).toBe(8);
    });
  });
});

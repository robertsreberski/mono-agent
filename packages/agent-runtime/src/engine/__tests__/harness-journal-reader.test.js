import { mkdtemp, rm, writeFile, appendFile, readFile, rename, mkdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { JournalReader } from "../journal-reader.js";
const roots = [];
async function fixture(text = '{"fictional":true}\n') {
  const root = await mkdtemp(join(tmpdir(), "harness-reader-")); roots.push(root);
  const path = join(root, "journal.jsonl"); await writeFile(path, text, { mode: 0o600 }); return { root, path };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("incrementally indexes records above 2 MiB and journals above 32 MiB", async () => {
  const { root, path } = await fixture("");
  const native = { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(3 * 1024 * 1024), thinkingSignature: "opaque" }], additive: { version: 99 } };
  for (let i = 0; i < 12; i++) await appendFile(path, `${JSON.stringify({ seq: i, message: native })}\n`);
  const reader = await JournalReader.open(path, root);
  try {
    const catalog = [];
    const evidence = await reader.scan((record, address) => { catalog.push({ seq: record.seq, ...address }); });
    expect(evidence.identity.size).toBeGreaterThan(32 * 1024 * 1024);
    expect(evidence.torn).toBe(false); expect(catalog).toHaveLength(12);
    expect(catalog[0].length).toBeGreaterThan(2 * 1024 * 1024);
    expect((await reader.read(catalog[11])).message).toEqual(native);
    expect(reader.records).toBeUndefined();
  } finally { await reader.close(); }
});

it("reports an incomplete final frame without repairing read-only evidence", async () => {
  const { root, path } = await fixture('{"fictional":true}\n{"incomplete":');
  const original = await readFile(path); const reader = await JournalReader.open(path, root);
  try {
    const records = []; const evidence = await reader.scan((record) => records.push(record));
    expect(records).toEqual([{ fictional: true }]); expect(evidence.torn).toBe(true);
    expect(evidence.completeBytes).toBe(Buffer.byteLength('{"fictional":true}\n'));
    expect(await readFile(path)).toEqual(original);
  } finally { await reader.close(); }
});

it.each(['{bad}\n', '\n', Buffer.from([0xff, 10])])("rejects corrupt complete records (%s)", async (text) => {
  const { root, path } = await fixture(text); const reader = await JournalReader.open(path, root);
  try { await expect(reader.scan(() => {})).rejects.toThrow(); } finally { await reader.close(); }
});

it("rejects indexed lookup when the frame boundary or file identity changes", async () => {
  const { root, path } = await fixture(); const reader = await JournalReader.open(path, root);
  try {
    let address; await reader.scan((_record, found) => { address = found; });
    await expect(reader.read({ offset: 0, length: address.length - 1 })).rejects.toThrow("read unavailable");
    await rename(path, `${path}.previous`); await writeFile(path, '{"replacement":true}\n', { mode: 0o600 });
    await expect(reader.read(address)).rejects.toThrow("read unavailable");
  } finally { await reader.close(); }
});

it("rejects mutation during a read-only scan", async () => {
  const { root, path } = await fixture(); const reader = await JournalReader.open(path, root);
  try { await expect(reader.scan(async () => { await appendFile(path, '{"later":true}\n'); })).rejects.toThrow("read unavailable"); }
  finally { await reader.close(); }
});

it("rejects insecure permissions, symlink components and replaced directories", async () => {
  const { root, path } = await fixture(); const reader = await JournalReader.open(path, root);
  try {
    await chmod(path, 0o644); await expect(reader.scan(() => {})).rejects.toThrow("read unavailable"); await chmod(path, 0o600);
    await symlink(path, join(root, "link.jsonl")); await expect(JournalReader.open(join(root, "link.jsonl"), root)).rejects.toThrow("read unavailable");
    const nested = join(root, "nested"); await mkdir(nested, { mode: 0o700 }); await writeFile(join(nested, "journal.jsonl"), '{}\n', { mode: 0o600 });
    await symlink(nested, join(root, "linked")); await expect(JournalReader.open(join(root, "linked", "journal.jsonl"), root)).rejects.toThrow("read unavailable");
    await rename(root, `${root}-previous`); roots.push(`${root}-previous`); await mkdir(root, { mode: 0o700 });
    await expect(reader.scan(() => {})).rejects.toThrow("read unavailable");
  } finally { await reader.close(); }
});

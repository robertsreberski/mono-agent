import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JsonlSessionRepo, MemorySessionRepo } from "../session-store.js";
import { listLegacySessions } from "../legacy-import.js";
import { managedJournalId } from "../managed-journal.js";
import { JournalReader } from "../journal-reader.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = /** @type {typeof import("node:fs/promises")} */ ((await original()) as typeof import("node:fs/promises"));
  return { ...fs, readdir: vi.fn(fs.readdir) };
});
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("creates and cold-opens an unguarded journal by deterministic id without native catalogue directory reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "deterministic-journal-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const session = await repo.create({ id: "fictional-handle" });
  expect(session.metadata.journalId).toBe(managedJournalId("fictional-handle"));
  await session.close();
  const cold = new JsonlSessionRepo({ sessionsRoot: root });
  const metadata = await cold.find("fictional-handle");
  const reopened = await cold.open(metadata);
  expect(reopened.metadata.id).toBe("fictional-handle");
  expect(await reopened.getOpenTurns()).toEqual([]);
  await reopened.close();
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === repo.directory)).toEqual([]);
  await expect(cold.create({ id: "fictional-handle" })).rejects.toThrow("already exists");
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === repo.directory)).toEqual([]);
});

it("uses the same deterministic journal identity for memory journals", async () => {
  const repo = new MemorySessionRepo();
  const session = await repo.create({ id: "fictional-memory-handle" });
  expect(session.metadata.journalId).toBe(managedJournalId("fictional-memory-handle"));
  await session.close();
});


it("imports legacy sources without walking the native catalogue", async () => {
  const root = await mkdtemp(join(tmpdir(), "deterministic-import-")); roots.push(root);
  const directory = join(root, "legacy"); await mkdir(directory);
  await copyFile(new URL("./fixtures/legacy-v3.jsonl", import.meta.url), join(directory, "fictional-source.jsonl"));
  const { sessions } = await listLegacySessions(root);
  expect(sessions).toHaveLength(1);
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const imported = await repo.importLegacy(sessions[0]!); await imported.close();
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === repo.directory)).toEqual([]);
});

it.each([false, true])("does not classify an exact-path ENOENT read race as owner damage (removed=%s)", async (removed) => {
  const root = await mkdtemp(join(tmpdir(), "deterministic-missing-race-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const session = await repo.create({ id: "fictional-missing-race" });
  const metadata = session.metadata; await session.close();
  const openSpy = vi.spyOn(JournalReader, "open").mockImplementationOnce(async () => {
    if (removed) await unlink(metadata.path);
    throw Object.assign(new Error("Transient missing journal"), { code: "ENOENT" });
  });
  try {
    const found = await repo.find(metadata.id);
    if (removed) expect(found).toBeUndefined();
    else expect(found).toMatchObject({ id: metadata.id, path: metadata.path });
  } finally { openSpy.mockRestore(); }
});

it.each(["", '{"format":', '{"format":"future"}\n'])("refuses a writer-owned creating stage as busy without parsing or reclaiming it (%s)", async (bytes) => {
  const root = await mkdtemp(join(tmpdir(), "deterministic-busy-stage-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const id = "fictional-busy-stage", journalId = managedJournalId(id);
  const locks = await repo.ensureDirectory();
  const writer = await locks.acquireWriter(journalId, { wait: false });
  const path = join(repo.directory, `${journalId}.jsonl.creating`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(repo.find(id)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally { writer.release(); }
  if (bytes.endsWith("\n")) {
    // Once stable, genuine owner damage still refuses and remains byte-stable.
    await expect(repo.find(id)).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_UNREADABLE", sessionId: id });
    expect(await readFile(path, "utf8")).toBe(bytes);
  } else {
    await expect(repo.find(id)).resolves.toBeUndefined();
  }
});

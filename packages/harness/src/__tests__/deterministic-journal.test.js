import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JsonlSessionRepo, MemorySessionRepo } from "../session-store.js";
import { listLegacySessions } from "../legacy-import.js";
import { managedJournalId } from "../managed-journal.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = /** @type {typeof import("node:fs/promises")} */ (await original());
  return { ...fs, readdir: vi.fn(fs.readdir) };
});
const roots = [];
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
  const imported = await repo.importLegacy(sessions[0]); await imported.close();
  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === repo.directory)).toEqual([]);
});

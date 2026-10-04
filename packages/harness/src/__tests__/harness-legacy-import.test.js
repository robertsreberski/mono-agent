import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, stat, rename, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlSessionRepo, SessionStore } from "../session-store.js";
const roots = [];
async function fixture(version = 4) {
  const root = await mkdtemp(join(tmpdir(), "harness-import-")); roots.push(root);
  await mkdir(join(root, "legacy")); const source = join(root, "legacy", "fixture_fixture-session.jsonl");
  await copyFile(new URL(`./fixtures/legacy-v${version}.jsonl`, import.meta.url), source);
  return { root, source, original: await readFile(source) };
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function killed(root, phase) {
  const child = fork(new URL("./fixtures/import-worker.mjs", import.meta.url), [root, phase], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const notice = await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`Import worker exited: ${code}`); })]);
    expect(notice[0]).toEqual({ phase });
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
async function assertImported(root, source, original) {
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const session = await repo.open((await repo.list())[0]);
  try {
    const entries = await session.getEntries();
    expect(entries.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    expect(entries).toHaveLength(2);
    expect((await readFile(`${source}.migrated`)).equals(original)).toBe(true);
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(root, "mono-v2", "journals")))).toEqual([`${session.metadata.journalId}.jsonl`]);
    return session.metadata;
  } finally { await session.close(); }
}
const phases = ["stage_written", "stage_synced", "stage_ready", "message_written", "context_synced", "published", "publication_synced", "archive_renamed", "archive_synced"];
describe("restartable legacy Pi import", () => {
  for (const version of [3, 4]) for (const phase of phases) {
    it(`resumes v${version} after SIGKILL at ${phase} with one destination and byte-stable source evidence`, async () => {
      const { root, source, original } = await fixture(version);
      await killed(root, phase);
      const journals = await readdir(join(root, "mono-v2", "journals"));
      const published = journals.filter((name) => name.endsWith(".jsonl"));
      expect(published).toHaveLength(["published", "publication_synced", "archive_renamed", "archive_synced"].includes(phase) ? 1 : 0);
      if (!["archive_renamed", "archive_synced"].includes(phase)) {
        expect((await readFile(source)).equals(original)).toBe(true);
        await expect(stat(`${source}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const metadata = await assertImported(root, source, original);
      await assertImported(root, source, original); // second reopen never duplicates context or archival
      expect(metadata.import.source.identity.sha256).toMatch(/^[a-f0-9]{64}$/);
    }, 10000);
  }
  it("keeps the valid destination after injected post-publication fsync failure", async () => {
    const { root, source, original } = await fixture(); let sync;
    const repo = new JsonlSessionRepo({ sessionsRoot: root, onImportPhase: async (phase) => {
      if (phase === "published") sync = vi.spyOn(SessionStore.prototype, "sync").mockRejectedValueOnce(new Error("Fictional post-rename fsync failure"));
    } });
    await expect(repo.open((await repo.list())[0])).rejects.toThrow("post-rename fsync failure"); sync.mockRestore();
    const journals = await readdir(join(root, "mono-v2", "journals")); expect(journals.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
    expect((await readFile(source)).equals(original)).toBe(true);
    await expect(stat(`${source}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    await assertImported(root, source, original);
  });
  it("keeps the valid destination after archival rename and before archive-directory sync", async () => {
    const { root, source, original } = await fixture();
    const repo = new JsonlSessionRepo({ sessionsRoot: root, onImportPhase: async (phase) => { if (phase === "archive_renamed") throw new Error("Fictional archive sync failure"); } });
    await expect(repo.open((await repo.list())[0])).rejects.toThrow("archive sync failure");
    expect((await readdir(join(root, "mono-v2", "journals"))).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
    await assertImported(root, source, original);
  });
  it("rejects duplicate source IDs without archiving or publishing either", async () => {
    const { root, source } = await fixture(); await mkdir(join(root, "sibling")); const other = join(root, "sibling", "other_fixture-session.jsonl"); await copyFile(source, other);
    const repo = new JsonlSessionRepo({ sessionsRoot: root });
    await expect(repo.open((await repo.list())[0])).rejects.toThrow("Invalid");
    expect(await repo.listOwned()).toEqual([]); expect(await stat(source)).toBeTruthy(); expect(await stat(other)).toBeTruthy();
  });
  it("rejects source inode replacement even with byte-identical replacement", async () => {
    const { root, source, original } = await fixture();
    const repo = new JsonlSessionRepo({ sessionsRoot: root, onImportPhase: async (phase) => {
      if (phase === "context_synced") { await rename(source, `${source}.previous`); await writeFile(source, original); }
    } });
    await expect(repo.open((await repo.list())[0])).rejects.toThrow("Invalid legacy");
    expect(await repo.listOwned()).toEqual([]); expect((await readFile(source)).equals(original)).toBe(true);
    const retry = new JsonlSessionRepo({ sessionsRoot: root });
    await expect(retry.open((await retry.list())[0])).rejects.toThrow("Invalid");
    await expect(stat(`${source}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects complete corrupt staging rather than discarding it as an interrupted import", async () => {
    const { root, source, original } = await fixture(); await killed(root, "context_synced");
    const [name] = await readdir(join(root, "mono-v2", "journals")); const path = join(root, "mono-v2", "journals", name);
    await appendFile(path, '{"schemaVersion":99}\n'); const corrupted = await readFile(path);
    const repo = new JsonlSessionRepo({ sessionsRoot: root });
    await expect(repo.open((await repo.list())[0])).rejects.toThrow("Invalid");
    expect((await readFile(path)).equals(corrupted)).toBe(true); expect((await readFile(source)).equals(original)).toBe(true);
  });
  it("rebuilds an incomplete owned staged final record from the unchanged source", async () => {
    const { root, source, original } = await fixture(); await killed(root, "message_written");
    const [name] = await readdir(join(root, "mono-v2", "journals")); await appendFile(join(root, "mono-v2", "journals", name), '{"schemaVersion":2');
    await assertImported(root, source, original);
  });
  it("reconciles a validated staged orphan alongside a published destination", async () => {
    const { root, source, original } = await fixture(); await killed(root, "published");
    const [name] = await readdir(join(root, "mono-v2", "journals")); const path = join(root, "mono-v2", "journals", name);
    await copyFile(path, `${path}.importing`); await assertImported(root, source, original);
  });
});

import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, stat, rename, writeFile, appendFile, utimes, cp } from "node:fs/promises";
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
const phases = ["stage_created", "stage_written", "stage_synced", "stage_ready", "message_written", "context_synced", "published", "publication_synced", "archive_renamed", "archive_synced"];
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

it.each(["delete", "touch", "replace", "restore-root"])("completed import is independent of optional archive (%s)", async (action) => {
  const { root, source } = await fixture(); const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const first = await repo.open((await repo.list())[0]); await first.close();
  if (action === "delete") await rm(`${source}.migrated`);
  if (action === "touch") await utimes(`${source}.migrated`, 1, 1);
  if (action === "replace") { const bytes = await readFile(`${source}.migrated`); await rm(`${source}.migrated`); await writeFile(`${source}.migrated`, bytes); }
  let target = root;
  if (action === "restore-root") { target = await mkdtemp(join(tmpdir(), "restored-import-")); roots.push(target); await cp(root, target, { recursive: true }); }
  const fresh = new JsonlSessionRepo({ sessionsRoot: target }); const session = await fresh.open((await fresh.list())[0]);
  expect(await session.getEntries()).toHaveLength(2); await session.close();
});

it.each([3, 4])("retirement removes matching v%s archive even after import root restoration", async (version) => {
  const { root, source } = await fixture(version); const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const session = await repo.open((await repo.list())[0]); await session.close();
  const restored = await mkdtemp(join(tmpdir(), "retired-import-")); roots.push(restored); await cp(root, restored, { recursive: true });
  const fresh = new JsonlSessionRepo({ sessionsRoot: restored }); await fresh.retireByHandle("fixture-session");
  expect(await readdir(join(restored, "legacy"))).toEqual([]); expect(await fresh.list()).toEqual([]);
  expect((await readFile(`${source}.migrated`)).length).toBeGreaterThan(0); // unrelated original root untouched
});

it("projects v3 physical parent ancestry and custom messages without abandoned compaction siblings", async () => {
  const { root, source } = await fixture(3); const timestamp = "2023-11-14T22:13:20.000Z";
  const header = JSON.parse((await readFile(source, "utf8")).split("\n")[0]);
  const entry = (id, parentId, type, payload) => ({ id, parentId, type, timestamp, ...payload });
  const user = (id, parentId, text) => entry(id, parentId, "message", { message: { role: "user", content: text, timestamp: 1700000000000 } });
  const records = [header, user("root", null, "Root fictional message."),
    entry("model", "root", "model_change", { provider: "faux", modelId: "fictional" }),
    entry("thinking", "model", "thinking_level_change", { thinkingLevel: "off" }),
    entry("label", "thinking", "label", { targetId: "root", label: "Fictional label" }),
    user("abandoned", "label", "Abandoned branch must not be imported."),
    entry("custom", "label", "custom_message", { customType: "fictional", content: "Fictional custom context.", details: {}, display: true }),
    user("kept", "custom", "Retained parent branch."),
    entry("cut", "kept", "compaction", { summary: "Fictional summary.", firstKeptEntryId: "label", tokensBefore: 100 })];
  await writeFile(source, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const repo = new JsonlSessionRepo({ sessionsRoot: root }); const session = await repo.open((await repo.list())[0]);
  const messages = (await session.getEntries()).map((e) => e.message);
  expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user"]);
  expect(messages[1].content).toBe("Fictional custom context."); expect(messages[2].content).toBe("Retained parent branch.");
  expect(JSON.stringify(messages)).not.toContain("Abandoned branch"); await session.close();
});

it("completes archival of earlier v2 imports with interrupted user scopes without executing them", async () => {
  const { root, source } = await fixture(); const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const first = await repo.open((await repo.list())[0]); const metadata = first.metadata; const tip = await first.getLeafId(); await first.close();
  const lines = (await readFile(metadata.path, "utf8")).trim().split("\n");
  const rows = lines.map((line) => JSON.parse(line)); rows.splice(-2); // simulate pre-completion-marker v2 writer
  const last = rows.at(-1); const turnId = "synthetic:earlier-interrupted";
  rows.push({ schemaVersion: 2, id: "older-start", parentId: last.id, seq: last.seq + 1, timestamp: 1, turnId, kind: "turn_start", payload: { identitySource: "synthetic", config: {}, baselineTipId: tip } });
  rows.push({ schemaVersion: 2, id: "older-operation", parentId: "older-start", seq: last.seq + 2, timestamp: 1, turnId, operationId: "earlier-op", kind: "operation_start", payload: { type: "prompt", cause: "prompt", config: {}, baselineTipId: tip, parentOperationId: null } });
  await writeFile(metadata.path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const reopened = await repo.open(metadata); expect(await reopened.getEntries()).toHaveLength(2);
  expect((await reopened.getTerminal("earlier-op")).status).toBe("interrupted"); expect(await reopened.getOpenTurns()).toEqual([]);
  expect(await reopened.getRepairEntries()).toMatchObject([{ cause: "crashed", operationIds: ["earlier-op"], calls: [] }]);
  await reopened.close(); await rm(`${source}.migrated`);
  const again = await repo.open(metadata); expect(await again.getEntries()).toHaveLength(2); await again.close();
});

it.each([["import", false], ["import", true], ["clean_break", false], ["clean_break", true]])("shares ordinary repair account selection for an older %s publication (lastClosed=%s)", async (mode, lastClosed) => {
  const { root, source } = await fixture();
  if (mode === "clean_break") await appendFile(source, JSON.stringify({ kind: "value", op: "set", seq: 6, namespace: "pi.op.state", key: "legacy-open", value: { status: "running" } }) + "\n");
  const repo = new JsonlSessionRepo({ sessionsRoot: root }); const raw = await repo.open((await repo.list())[0]); const metadata = raw.metadata;
  expect(metadata.import.mode).toBe(mode);
  const turnId = "synthetic:publication-upgrade", operationId = "publication-last";
  await raw.beginTurn(turnId); await raw.openOperation(operationId, {});
  const messageId = await raw.appendMessage({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "fictional-call", name: "Read", arguments: {} }] });
  for (const admission of ["observed", "admitted", "started"]) await raw.write("tool_call", { callId: "fictional-call", name: "Read", messageId, admission }, { operationId });
  if (lastClosed) await raw.closeOperation(operationId, "failed");
  else await raw.appendMessage({ role: "assistant", content: [], stopReason: "deferred" });
  await raw.sync(); await raw.close();
  // Earlier publication had no durable administrative completion marker.
  const rows = (await readFile(metadata.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const kept = rows.filter((row) => !row.turnId?.startsWith(mode === "import" ? "synthetic:legacy-archived:" : "synthetic:legacy-published:"));
  for (let index = 1; index < kept.length; index += 1) { kept[index].seq = index; kept[index].parentId = index === 1 ? null : kept[index - 1].id; }
  await writeFile(metadata.path, kept.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const reopened = await new JsonlSessionRepo({ sessionsRoot: root }).open(metadata);
  const cause = lastClosed ? "crashed" : "suspended_not_resumed";
  const repairs = await reopened.getRepairEntries(); expect(repairs).toHaveLength(1);
  expect(repairs[0]).toMatchObject({ cause, operationIds: [operationId], calls: [{ callId: "fictional-call", cause, admission: "started" }] });
  expect(await reopened.getOpenTurns()).toEqual([]); expect((await reopened.getTerminal(operationId)).status).toBe(lastClosed ? "failed" : "interrupted");
  await reopened.close(); const bytes = await readFile(metadata.path);
  const again = await new JsonlSessionRepo({ sessionsRoot: root }).open(metadata); expect(await again.getRepairEntries()).toEqual(repairs); await again.close();
  expect((await readFile(metadata.path)).equals(bytes)).toBe(true);
});

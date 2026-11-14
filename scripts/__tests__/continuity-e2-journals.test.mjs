// Bounded native scans and fail-closed discovery/read races, entirely fictional.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rename, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlSessionRepo } from "../../packages/turn/dist/engine/session-store.js";
import { readE2Journal, findE2ActiveCompaction, bindE2NativeCompaction, E2_JOURNAL_SCAN_BYTES } from "../lib/continuity-e2-journals.mjs";
import { e2NativeCompactionSnapshot } from "../lib/continuity-e2-compaction.mjs";
import { e2PhaseWork, readE2Checkpoint } from "../lib/continuity-e2-lineage.mjs";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
const cleanups = [], read = (...args) => guardedAuthorization("e2-validation").readArtifact(...args);
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-journal-boundary-")));
  const planned = { index: 0, kind: "proof", arm: "pressure", variant: "ceiling", phase: "whole" }, state = { schedule: [planned], slots: [{}] }, work = e2PhaseWork(root, planned);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const repo = new JsonlSessionRepo({ sessionsRoot: join(work, "sessions") }), sessions = [];
  cleanups.push(async () => { for (const session of sessions) await session.close(); await repo.close(); await rm(root, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) {
    const session = await repo.create({ id: `fictional-boundary-${i}`, cwd: work }); sessions.push(session);
    await session.beginTurn(`fictional-turn-${i}`); await session.openOperation(`fictional-compaction-${i}`, { model: { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } }, "compaction", "continuity:manual"); await session.sync();
  }
  const snapshot = reader => e2NativeCompactionSnapshot(root, state, planned, 0, reader);
  const baseline = await snapshot(read);
  const scan = (kind, reader) => kind === "active" ? findE2ActiveCompaction(work, digest("fictional-compaction-0"), reader)
    : e2NativeCompactionSnapshot(root, state, planned, 0, reader, kind === "refusal" ? baseline : undefined);
  return { root, work, sessions, scan, planned };
}
it("passes only the remaining allowance to the bounded native reader, including the exact boundary", async () => {
  const f = await fixture(), { journalId, path } = f.sessions[0].metadata, bytes = await readFile(path);
  const budget = { bytes: E2_JOURNAL_SCAN_BYTES - bytes.length };
  await expect(readE2Journal(f.work, journalId, read, budget)).resolves.toBeDefined();
  expect(budget.bytes).toBe(E2_JOURNAL_SCAN_BYTES);
  let reads = 0;
  await expect(readE2Journal(f.work, journalId, () => { reads++; }, budget)).rejects.toThrow(); expect(reads).toBe(0);
  const short = { bytes: E2_JOURNAL_SCAN_BYTES - bytes.length + 1 };
  await expect(readE2Journal(f.work, journalId, read, short)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it.each(["active", "start", "refusal"])("shares the aggregate allowance across the %s scan before reading the second large journal", async kind => {
  const f = await fixture(), limits = []; let completedReads = 0;
  // Logical 80 MiB byte accounting avoids allocating two huge fixtures. Parsing
  // uses genuine small journals; the bounded reader refuses the second read.
  const bounded = async (path, code, maximum) => {
    limits.push(maximum);
    if (80 * 1024 * 1024 > maximum) throw Object.assign(Error(code), { code });
    const bytes = await readFile(path); completedReads++;
    return { length: 80 * 1024 * 1024, toString: (...args) => bytes.toString(...args) };
  };
  await expect(f.scan(kind, bounded)).rejects.toThrow();
  expect(limits).toEqual([128 * 1024 * 1024, 48 * 1024 * 1024]); expect(completedReads).toBe(1);
});
it.each(["active", "start", "refusal"].flatMap(kind => ["appeared", "replaced", "symlink"].map(race => [kind, race])))("refuses a scoped %s journal %s between discovery and read", async (kind, race) => {
  const f = await fixture(); let changed = false;
  const raced = async (path, ...args) => {
    if (!changed) {
      changed = true; const bytes = await readFile(path);
      if (race === "appeared") await writeFile(join(f.work, "sessions/journals/fictional-new.jsonl"), bytes, { mode: 0o600 });
      else {
        await rename(path, path + ".saved");
        if (race === "symlink") await symlink(path + ".saved", path);
        else await writeFile(path, bytes, { mode: 0o600 });
      }
    }
    return read(path, ...args);
  };
  await expect(f.scan(kind, raced)).rejects.toThrow(); expect(changed).toBe(true);
});

const external = digest("fictional-external-compaction"), payload = digest("fictional-payload");
async function oneLive(f) { await f.sessions[1].closeOperation("fictional-compaction-1", "completed"); await f.sessions[1].endTurn("fictional-turn-1", "completed"); await f.sessions[1].sync(); }
it.each([0, 2])("refuses binding with %s live native compactions at hold time", async count => {
  const f = await fixture();
  if (!count) { await oneLive(f); await f.sessions[0].closeOperation("fictional-compaction-0", "completed"); await f.sessions[0].sync(); }
  await expect(bindE2NativeCompaction(f.work, external, payload, read)).rejects.toThrow();
});
it("fixes one native binding across held payloads and refuses a later native operation", async () => {
  const f = await fixture(); await oneLive(f);
  const held = await bindE2NativeCompaction(f.work, external, payload, read);
  expect(held.nativeOperationDigest).not.toBe(external);
  const next = await bindE2NativeCompaction(f.work, external, digest("fictional-second-payload"), read, held);
  expect(next.nativeOperationDigest).toBe(held.nativeOperationDigest); expect(next.prefixSha256).toBe(held.prefixSha256);
  await f.sessions[0].closeOperation("fictional-compaction-0", "completed");
  await f.sessions[0].openOperation("fictional-replacement-operation", {}, "compaction", "continuity:manual"); await f.sessions[0].sync();
  await expect(bindE2NativeCompaction(f.work, external, payload, read, held)).rejects.toThrow();
  await expect(bindE2NativeCompaction(f.work, external, next.payloadDigest, read, next)).rejects.toThrow();
});
it.each(["zero", "two", "replaced"])("refuses %s native authority at consumption after a valid hold", async kind => {
  const f = await fixture(); await oneLive(f);
  const held = await bindE2NativeCompaction(f.work, external, payload, read);
  if (kind === "two") {
    await f.sessions[1].beginTurn("fictional-competing-turn"); await f.sessions[1].openOperation("fictional-competing-compaction", {}, "compaction", "continuity:manual"); await f.sessions[1].sync();
  } else if (kind === "zero") {
    await f.sessions[0].closeOperation("fictional-compaction-0", "completed"); await f.sessions[0].sync();
  } else {
    const path = f.sessions[0].metadata.path, bytes = await readFile(path); await rename(path, path + ".saved"); await writeFile(path, bytes, { mode: 0o600 });
  }
  await expect(bindE2NativeCompaction(f.work, external, payload, read, held)).rejects.toThrow();
});
it("refuses a changed native identity or competing operation at checkpoint assembly", async () => {
  const f = await fixture(); await oneLive(f);
  const held = await bindE2NativeCompaction(f.work, external, payload, read), raw = f.sessions[0];
  const checkpointId = await raw.appendCompaction({ summary: "Fictional completed summary.", retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
  await raw.closeOperation("fictional-compaction-0", "completed"); await raw.endTurn("fictional-turn-0", "completed"); await raw.sync();
  const reference = { journalId: raw.metadata.journalId, checkpointId, checkpoint: 0 };
  await expect(readE2Checkpoint(f.root, f.planned, reference, read, [held])).resolves.toBeDefined();
  await f.sessions[1].beginTurn("fictional-competing-turn"); await f.sessions[1].openOperation("fictional-competing-compaction", {}, "compaction", "continuity:manual"); await f.sessions[1].sync();
  await expect(readE2Checkpoint(f.root, f.planned, reference, read, [held])).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  await f.sessions[1].closeOperation("fictional-competing-compaction", "completed"); await f.sessions[1].sync();
  const path = raw.metadata.path, bytes = await readFile(path); await rename(path, path + ".saved"); await writeFile(path, bytes, { mode: 0o600 });
  await expect(readE2Checkpoint(f.root, f.planned, reference, read, [held])).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});

async function completedFixture() {
  const f = await fixture(); await oneLive(f);
  const raw = f.sessions[0], held = await bindE2NativeCompaction(f.work, external, payload, read);
  const checkpointId = await raw.appendCompaction({ summary: "Fictional completed summary.", retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
  await raw.closeOperation("fictional-compaction-0", "completed"); await raw.sync();
  return { ...f, raw, held, reference: { journalId: raw.metadata.journalId, checkpointId, checkpoint: 0 } };
}
const finish = async f => { await f.raw.endTurn("fictional-turn-0", "completed"); await f.raw.sync(); };
const checkpoint = (f, reader) => readE2Checkpoint(f.root, f.planned, f.reference, reader, [f.held]);
it.each(["opened", "completed", "checkpoint"])("refuses a newly %s compaction in the checkpoint suffix without another reread", async kind => {
  const f = await completedFixture(); let reads = 0;
  const reader = async (path, ...args) => {
    const bytes = await read(path, ...args);
    if (path === f.raw.metadata.path && ++reads === 1) {
      await f.raw.openOperation("fictional-suffix-compaction", {}, "compaction", "continuity:manual");
      if (kind === "checkpoint") await f.raw.appendCompaction({ summary: "Fictional successor.", retainedTail: [], tokensBefore: 90, details: { readFiles: [], modifiedFiles: [] } });
      if (kind !== "opened") await f.raw.closeOperation("fictional-suffix-compaction", "completed");
      await f.raw.sync();
    }
    return bytes;
  };
  await expect(checkpoint(f, reader)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" }); expect(reads).toBe(2);
});
it.each(["prefix", "inode", "symlink", "truncated", "invalid-record", "during-proof", "membership", "two-appends"])("refuses checkpoint append ambiguity: %s", async kind => {
  const f = await completedFixture(); let reads = 0;
  const reader = async (path, ...args) => {
    const bytes = await read(path, ...args);
    if (path === f.raw.metadata.path) {
      reads++;
      if (reads === 1) {
        await finish(f);
        const full = await readFile(path);
        if (kind === "prefix") await writeFile(path, Buffer.from(full.toString().replace('{', '{ ')), { mode: 0o600 });
        if (["inode", "symlink"].includes(kind)) {
          await rename(path, path + ".saved");
          if (kind === "inode") await writeFile(path, full, { mode: 0o600 });
          else await symlink(path + ".saved", path);
        }
        if (kind === "truncated") await writeFile(path, full.subarray(0, -2), { mode: 0o600 });
        if (kind === "invalid-record") await writeFile(path, Buffer.concat([full, Buffer.from('{"kind":"fictional-invalid"}\n')]), { mode: 0o600 });
        if (kind === "membership") await writeFile(join(f.work, "sessions/journals/fictional-new.jsonl"), full, { mode: 0o600 });
        if (kind === "two-appends") { await f.sessions[1].beginTurn("fictional-second-append"); await f.sessions[1].sync(); }
      } else if (reads === 2 && kind === "during-proof") {
        await f.raw.beginTurn("fictional-later-turn"); await f.raw.sync();
      }
    }
    return bytes;
  };
  await expect(checkpoint(f, reader)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  expect(reads).toBe(["inode", "symlink", "membership", "two-appends"].includes(kind) ? 1 : 2);
});
it("charges the sole checkpoint reread to the same aggregate scan allowance", async () => {
  const f = await completedFixture(), limits = []; let initial = false;
  const reader = async (path, code, maximum) => {
    limits.push(maximum);
    const logicalSize = limits.length === 3 ? 80 * 1024 * 1024 : 40 * 1024 * 1024;
    if (logicalSize > maximum) throw Object.assign(Error(code), { code });
    const bytes = await readFile(path);
    if (path === f.raw.metadata.path && !initial) { initial = true; await finish(f); }
    return { length: logicalSize, toString: (...args) => bytes.toString(...args) };
  };
  await expect(checkpoint(f, reader)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  expect(limits).toEqual([128, 88, 48].map(m => m * 1024 * 1024));
});
it("keeps native hold and consume scans strict even for a valid lifecycle append", async () => {
  const f = await fixture(); await oneLive(f); let mutated = false;
  const reader = async (path, ...args) => {
    const bytes = await read(path, ...args);
    if (!mutated && path === f.sessions[0].metadata.path) { mutated = true; await f.sessions[0].appendMessage({ role: "user", content: "Fictional added input.", timestamp: 2 }); await f.sessions[0].sync(); }
    return bytes;
  };
  await expect(findE2ActiveCompaction(f.work, digest("fictional-compaction-0"), reader)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("proves a shipping lifecycle append after the actual tryCompact success event", async () => {
  const [{ createRunDriver, projectContext }, { tryCompact }, { fauxAssistantMessage }] = await Promise.all([
    import("@mono-agent/turn/engine"), import("../../packages/turn/dist/execution/pi/compaction/compaction-driver.js"),
    import("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/index.js"),
  ]);
  const f = await fixture(); await oneLive(f); const raw = f.sessions[0];
  await raw.closeOperation("fictional-compaction-0", "completed"); await raw.endTurn("fictional-turn-0", "completed");
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", contextWindow: 272000, maxTokens: 128000 };
  const driver = createRunDriver(raw, { model, systemPrompt: "Fictional local summary.", tools: [] });
  await driver.beginTurn("fictional-shipping-lifecycle", "synthetic");
  for (let i = 0; i < 2; i++) await raw.appendMessage({ role: "user", content: "Fictional ordinary progress. ".repeat(3000), timestamp: 2 });
  let eventId, held, succeeded = false;
  const h = { models: { completeSimple: async () => {
    held = await bindE2NativeCompaction(f.work, digest(eventId), payload, read);
    return fauxAssistantMessage("Fictional completed summary.");
  } }, compactionFailureKey: f.work, getModel: () => model, waitForIdle: () => driver.waitForIdle(), setCompactionSettings: settings => driver.setCompactionSettings(settings),
    subscribe: listener => driver.subscribe(listener), on: (_type, handler) => driver.hooks.on("before_compaction", handler), compact: () => driver.compact() };
  const result = await tryCompact(h, { trigger: "proactive", onEvent: event => { if (event.status === "running") eventId = event.operationId; if (event.status === "succeeded") succeeded = true; }, runtimeWarnings: [],
    session: { getEntries: () => raw.getEntries(), buildContext: async () => projectContext(await raw.getEntries()) },
    policy: { enabled: true, summaryMaxTokens: 3000, keepRecentTokens: 1000, compactionMinSavingsTokens: 0, effort: "none", failureCooldownMs: 900000 } });
  expect(result.applied).toBe(true); expect(succeeded).toBe(true); expect(held.nativeOperationDigest).not.toBe(digest(eventId));
  const entry = (await raw.getEntries()).filter(e => e.type === "compaction").at(-1), reference = { journalId: raw.metadata.journalId, checkpointId: entry.id, checkpoint: 0 };
  let reads = 0;
  const reader = async (path, ...args) => {
    const bytes = await read(path, ...args);
    if (path === raw.metadata.path && ++reads === 1) {
      expect(succeeded).toBe(true);
      await driver.endTurn("completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "compaction" }); await raw.sync();
    }
    return bytes;
  };
  await expect(readE2Checkpoint(f.root, f.planned, reference, reader, [held])).resolves.toMatchObject({ summary: "Fictional completed summary." });
  expect(reads).toBe(2);
});

it("proves a complete lifecycle append between discovery and the first checkpoint read", async () => {
  const f = await completedFixture(); let reads = 0;
  const reader = async (path, ...args) => {
    if (path === f.raw.metadata.path && ++reads === 1) await finish(f);
    return read(path, ...args);
  };
  await expect(checkpoint(f, reader)).resolves.toMatchObject({ summary: "Fictional completed summary." }); expect(reads).toBe(2);
});

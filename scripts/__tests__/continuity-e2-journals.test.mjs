// Bounded native scans and fail-closed discovery/read races, entirely fictional.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rename, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlSessionRepo } from "../../packages/turn/dist/engine/session-store.js";
import { readE2Journal, findE2ActiveCompaction, E2_JOURNAL_SCAN_BYTES } from "../lib/continuity-e2-journals.mjs";
import { e2NativeCompactionSnapshot } from "../lib/continuity-e2-compaction.mjs";
import { e2PhaseWork } from "../lib/continuity-e2-lineage.mjs";
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
    await session.beginTurn(`fictional-turn-${i}`); await session.openOperation(`fictional-compaction-${i}`, {}, "compaction", "continuity:manual"); await session.sync();
  }
  const snapshot = reader => e2NativeCompactionSnapshot(root, state, planned, 0, reader);
  const baseline = await snapshot(read);
  const scan = (kind, reader) => kind === "active" ? findE2ActiveCompaction(work, digest("fictional-compaction-0"), reader)
    : e2NativeCompactionSnapshot(root, state, planned, 0, reader, kind === "refusal" ? baseline : undefined);
  return { root, work, sessions, scan };
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

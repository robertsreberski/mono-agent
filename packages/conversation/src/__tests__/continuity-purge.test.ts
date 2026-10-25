import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acknowledgeContinuityPurge, claimContinuityPurge, pendingContinuityPurges, persistContinuityPurge } from "../tool-history/continuity-purge.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";

const roots: string[] = [], writers = new Set<ToolHistoryWriter>();
const id = "web:fiction", scope = { logicalConversationId: id, currentConversationId: id, currentRunId: "retrieval" };
const binding = { conversationId: id, logicalConversationId: id, runId: "fictional-run", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
async function root() { const value = await mkdtemp(join(tmpdir(), "continuity-purge-")); roots.push(value); return value; }
async function open(dir: string, enabled = true) {
  const writer = await ToolHistoryWriter.open({ root: dir, continuityEnabled: enabled, persistenceCeilingMs: 5000 }); writers.add(writer); return writer;
}
async function result(writer: ToolHistoryWriter, callId = "fictional-call") {
  return await writer.persist(binding, { phase: "result", toolCallId: callId, toolName: "Read", state: "success", content: [{ type: "text", text: "Fictional retained quotation." }] });
}
afterEach(async () => { for (const writer of writers) await writer.close(); writers.clear(); await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it("coalesces repeated intents and never acknowledges a newer deterministic intent with an older claim", async () => {
  const dir = await root(), purge = { scope: "logical" as const, conversationId: id };
  for (let index = 0; index < 8; index++) persistContinuityPurge(dir, purge);
  expect(pendingContinuityPurges(dir)).toHaveLength(1);
  const original = pendingContinuityPurges(dir)[0]!.path;
  const claimed = claimContinuityPurge(dir, original);
  // A newer reset may arrive while the worker holds its fixed claim.
  persistContinuityPurge(dir, purge);
  acknowledgeContinuityPurge(dir, claimed);
  expect(pendingContinuityPurges(dir).map(p => p.path)).toEqual([original]);
  await open(dir);
  expect(pendingContinuityPurges(dir)).toEqual([]);
});

it("collects only older secure interrupted temps under the canonical writer's ownership", async () => {
  const dir = await root();
  const old = join(dir, ".continuity-purge-" + "a".repeat(64) + ".json.tmp");
  const fresh = join(dir, ".continuity-purge-" + "b".repeat(64) + ".json.tmp");
  const linked = join(dir, ".continuity-purge-" + "c".repeat(64) + ".json.tmp");
  const target = join(dir, "unrelated.txt");
  await writeFile(old, "interrupted", { mode: 0o600 }); await utimes(old, 1, 1);
  await writeFile(fresh, "not stale", { mode: 0o600 }); await utimes(fresh, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
  await writeFile(target, "untouched", { mode: 0o600 }); await symlink(target, linked);
  // This private test root has no other canonical writer; production callers hold
  // the root transaction (including the whole-logical reset discovery transaction).
  persistContinuityPurge(dir, { scope: "physical", conversationId: id });
  expect(existsSync(old)).toBe(false); expect(existsSync(fresh)).toBe(true);
  expect(lstatSync(linked).isSymbolicLink()).toBe(true); expect(await readFile(target, "utf8")).toBe("untouched");
});

it("replaces a secure same-key interrupted temp even when its mtime is in the future", async () => {
  const dir = await root(), purge = { scope: "logical" as const, conversationId: id };
  persistContinuityPurge(dir, purge);
  const path = pendingContinuityPurges(dir)[0]!.path, temporary = `${path}.tmp`;
  const unrelated = join(dir, ".continuity-purge-" + "b".repeat(64) + ".json.tmp");
  const future = Date.now() / 1000 + 1000000;
  for (const temp of [temporary, unrelated]) {
    await writeFile(temp, "interrupted before wall-clock rollback", { mode: 0o600 });
    await utimes(temp, future, future);
  }
  expect(() => persistContinuityPurge(dir, purge)).not.toThrow();
  expect(existsSync(temporary)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  expect(pendingContinuityPurges(dir).map(purge => purge.path)).toEqual([path]);
});

it.each(["logical", "physical"] as const)("clears only the %s purge's continuity conflict incident keys", async purgeScope => {
  const dir = await root(), writer = await open(dir), reader = new ToolHistoryReader(dir);
  const generations: string[] = [];
  for (const conversationId of [id, "web:unrelated"]) {
    const run = { ...binding, conversationId, logicalConversationId: conversationId };
    await writer.persist(run, { phase: "result", toolCallId: "fictional-call", toolName: "Read", state: "success", content: [{ type: "text", text: "Fictional original quotation." }] });
    const generationId = reader.searchContinuity({ ...scope, logicalConversationId: conversationId, currentConversationId: conversationId }).items[0]!.generationId;
    generations.push(generationId);
    await expect(writer.prepareContinuity({ generationId, conversationId, logicalConversationId: conversationId, beforeDigest: null, afterDigest: "a".repeat(64), records: [] }))
      .rejects.toMatchObject({ code: "continuity_conflict" });
  }
  expect((await writer.stats()).idempotencyConflicts).toBe(2);
  await writer.close();
  persistContinuityPurge(dir, { scope: purgeScope, conversationId: id });
  const recovered = await open(dir);
  expect((await recovered.stats()).idempotencyConflicts).toBe(1);
  const database = new DatabaseSync(reader.databasePath, { readOnly: true });
  expect(database.prepare("SELECT key FROM writer_stats WHERE key LIKE 'idempotency_conflicts:continuity:%'").all())
    .toEqual([{ key: `idempotency_conflicts:continuity:${generations[1]}` }]);
  database.close();
});

it.each([false, true])("keeps purge intents and database bytes when quick_check fails (mismatched root=%s)", async mismatched => {
  const dir = await root(), writer = await open(dir), reader = new ToolHistoryReader(dir);
  await result(writer); await writer.close();
  const database = new DatabaseSync(reader.databasePath);
  // A real CHECK violation: the schema remains readable, but quick_check and
  // integrity_check both reject it before any continuity deletion is safe.
  database.exec("PRAGMA ignore_check_constraints=ON; UPDATE continuity_records SET finalized=7; PRAGMA ignore_check_constraints=OFF;");
  expect(Object.values(database.prepare("PRAGMA quick_check").get()!)[0]).not.toBe("ok");
  database.close();
  persistContinuityPurge(dir, { scope: "logical", conversationId: id });
  const before = await readFile(reader.databasePath), marker = pendingContinuityPurges(dir)[0]!.path;
  await expect(ToolHistoryWriter.open({ root: dir, continuityEnabled: true, ...(mismatched ? { artifactRoot: join(dir, "different-artifacts") } : {}) }))
    .rejects.toMatchObject({ code: "history_integrity_failed" });
  expect(pendingContinuityPurges(dir).map(purge => purge.path)).toEqual([marker]);
  expect(await readFile(reader.databasePath)).toEqual(before);
});

it.each([false, true])("contains an invalid marker to continuity with enabled=%s", async enabled => {
  const dir = await root(), seed = await open(dir);
  await result(seed); await seed.close();
  persistContinuityPurge(dir, { scope: "logical", conversationId: "web:unrelated" });
  const invalid = join(dir, ".continuity-purge-" + "f".repeat(64) + ".json");
  await writeFile(invalid, "{invalid", { mode: 0o600 });
  const writer = await open(dir, enabled), reader = new ToolHistoryReader(dir);
  expect(reader.continuityPurgeStatus()).toEqual({ pending: enabled ? 0 : 1, invalid: 1 });
  expect(reader.searchContinuity(scope)).toMatchObject({ available: false, items: [] });
  const stored = await result(writer, "later-call");
  expect(stored.persistence).toBe("persisted");
  expect(reader.get({ ...scope, recordId: stored.recordId! }).record).toBeDefined();
  expect(reader.search(scope).items.length).toBeGreaterThan(0);
  // No automatic finalized continuity capture while globally invalid.
  expect((await writer.stats()).continuity?.records).toBe(1);
  await expect(writer.recordContinuityGap({ generationId: "chg1_" + "a".repeat(32), conversationId: id, logicalConversationId: id, beforeDigest: null, afterDigest: null, reason: "sidecar_unavailable" }))
    .rejects.toMatchObject({ code: enabled ? "continuity_purge_unavailable" : "continuity_disabled" });
});

it("preserves an invalid prior claim instead of overwriting it with a newer base intent", async () => {
  const dir = await root();
  persistContinuityPurge(dir, { scope: "physical", conversationId: id });
  const path = pendingContinuityPurges(dir)[0]!.path;
  await writeFile(`${path}.applying`, "{invalid", { mode: 0o600 });
  const writer = await open(dir);
  expect(new ToolHistoryReader(dir).continuityPurgeStatus()).toEqual({ pending: 1, invalid: 1 });
  expect(await readFile(`${path}.applying`, "utf8")).toBe("{invalid");
  expect((await result(writer)).persistence).toBe("persisted");
});

it("services deferred intents on explicit enable of an existing disabled writer", async () => {
  const dir = await root(), seed = await open(dir); await result(seed); await seed.close();
  persistContinuityPurge(dir, { scope: "logical", conversationId: id });
  const writer = await open(dir, false);
  expect(pendingContinuityPurges(dir)).toHaveLength(1);
  await writer.enableContinuity();
  expect(pendingContinuityPurges(dir)).toEqual([]);
  expect((await writer.stats()).continuity?.records).toBe(0);
});

it("drains only SQLite continuity rows on a mismatched root without touching stored artifact paths", async () => {
  const dir = await root(), original = join(dir, "source", "history"), fork = join(dir, "fork", "history");
  const writer = await open(original); await result(writer);
  const reader = new ToolHistoryReader(original), oldRecord = reader.searchContinuity(scope).items[0]!.recordId;
  await writer.pinContinuity({ logicalConversationId: id, recordId: oldRecord, ownerKind: "handoff", ownerId: "fictional-reference" });
  await writer.close();
  const outside = join(dir, "outside.txt"), trap = join(dir, "artifact-symlink");
  await writeFile(outside, "artifact must remain untouched", { mode: 0o600 }); await symlink(outside, trap);
  const database = new DatabaseSync(reader.databasePath);
  database.prepare("INSERT INTO artifact_refs(artifact_id,conversation_id,run_id,tool_call_id,host_path,availability,created_at_ms) VALUES (?,?,?,?,?,'available',1)")
    .run("fictional-artifact", id, binding.runId, "fictional-call", trap);
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'continuity_%' AND name<>'sqlite_sequence' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const snapshot = (db: DatabaseSync) => tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  const before = snapshot(database); database.close();
  const artifactStat = lstatSync(outside), linkStat = lstatSync(trap);
  await mkdir(join(dir, "fork"), { mode: 0o700 }); await cp(original, fork, { recursive: true });
  persistContinuityPurge(fork, { scope: "logical", conversationId: id });
  // A preload trap throws if ANY fs operation reads/follows/deletes the stored
  // artifact path (or its target). Worker startup still must fail root binding.
  const preload = join(dir, "trap.mjs"), child = join(dir, "open.mjs");
  const aliases = [trap, outside, realpathSync(outside), join(realpathSync(dir), "artifact-symlink")];
  await writeFile(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';import{isMainThread}from'node:worker_threads';
const blocked=new Set(${JSON.stringify(aliases)});
for(const name of ['openSync','readFileSync','unlinkSync','rmSync','statSync','lstatSync','realpathSync','readlinkSync']){const original=fs[name];fs[name]=function(path,...args){if(blocked.has(String(path)))throw new Error('STORED_ARTIFACT_PATH_TOUCHED');return original.call(this,path,...args);};}syncBuiltinESMExports();if(!isMainThread){try{fs.lstatSync(${JSON.stringify(trap)});throw new Error('INACTIVE_TRAP');}catch(error){if(error.message!=='STORED_ARTIFACT_PATH_TOUCHED')throw error;}console.log('ARTIFACT_TRAP_ACTIVE');}`);
  const writerUrl = new URL("../../dist/tool-history/writer.js", import.meta.url).href;
  await writeFile(child, `import {ToolHistoryWriter} from ${JSON.stringify(writerUrl)};try{await ToolHistoryWriter.open({root:${JSON.stringify(fork)},continuityEnabled:true});process.exitCode=2;}catch(error){console.log(error.code);if(error.code!=='history_artifact_root_mismatch')process.exitCode=3;}`);
  const opened = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, child], { encoding: "utf8", timeout: 15000 });
  expect(opened.status, opened.stderr + opened.stdout).toBe(0); expect(opened.stdout).toContain("history_artifact_root_mismatch"); expect(opened.stdout).toContain("ARTIFACT_TRAP_ACTIVE");
  expect(pendingContinuityPurges(fork)).toEqual([]);
  const recovered = new ToolHistoryReader(fork);
  expect(recovered.getContinuity({ ...scope, recordId: oldRecord }).status).toBe("unavailable");
  const after = new DatabaseSync(recovered.databasePath);
  expect(snapshot(after)).toEqual(before);
  for (const table of ["continuity_generations", "continuity_records", "continuity_pins"]) expect(after.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  after.close();
  expect(lstatSync(outside)).toMatchObject({ ino: artifactStat.ino, size: artifactStat.size, mtimeMs: artifactStat.mtimeMs, atimeMs: artifactStat.atimeMs });
  expect(lstatSync(trap)).toMatchObject({ ino: linkStat.ino, mtimeMs: linkStat.mtimeMs });
  expect(await readFile(outside, "utf8")).toBe("artifact must remain untouched");
  for (const enabled of [false, true]) await expect(ToolHistoryWriter.open({ root: fork, continuityEnabled: enabled })).rejects.toMatchObject({ code: "history_artifact_root_mismatch" });
});

it("does no purge-marker I/O in disabled runtime mode, with a positive enabled probe", async () => {
  const dir = await root(), preload = join(dir, "probe.mjs"), child = join(dir, "probe-child.mjs"), probe = join(dir, "probe.log");
  const history = join(dir, "history");
  await mkdir(history, { mode: 0o700 });
  const canonical = realpathSync(history);
  await writeFile(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.readdirSync;fs.readdirSync=function(path,...args){if([${JSON.stringify(history)},${JSON.stringify(canonical)}].includes(String(path)))fs.appendFileSync(${JSON.stringify(probe)},'scan\\n');return original.call(this,path,...args);};syncBuiltinESMExports();`);
  const writerUrl = new URL("../../dist/tool-history/writer.js", import.meta.url).href;
  await writeFile(child, `import{ToolHistoryWriter}from ${JSON.stringify(writerUrl)};const writer=await ToolHistoryWriter.open({root:${JSON.stringify(history)},continuityEnabled:process.argv[2]==='true'});await writer.stats();await writer.close();`);
  const run = (enabled: boolean) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, child, String(enabled)], { encoding: "utf8", timeout: 15000 });
  const off = run(false); expect(off.status, off.stderr).toBe(0); expect(existsSync(probe)).toBe(false);
  const on = run(true); expect(on.status, on.stderr).toBe(0); expect(existsSync(probe)).toBe(true);
});

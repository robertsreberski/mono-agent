import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, rename, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createJsonlRunRecorder, readRecordedRun, pruneRunArtifacts, UpkeepAccountingExportError } from "@mono-agent/observability";
import { mutateUpkeep, type UpkeepReservation } from "../continuity/admission.js";
import { replayUpkeepAccounting, upkeepAccounting, createUpkeepAccountingExportQueue } from "../continuity/accounting-outbox.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function rootDir() { const root = await mkdtemp(join(tmpdir(), "upkeep-outbox-")); roots.push(root); return root; }
async function memory() {
  const root = await rootDir(), artifactDir = join(root, "runs"), db = new DatabaseSync(":memory:");
  const recorder = createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" }); await recorder.start!();
  const mutate = (request: Parameters<typeof mutateUpkeep>[2]) => mutateUpkeep(db, root, request);
  const scope = { logicalId: "logical", conversationId: "fictional" };
  const expected = mutate({ kind: "inspect", scope })!, fence = mutate({ kind: "claim", expected, ownerToken: "owner" })!;
  const r: UpkeepReservation = { ...fence, operationId: "operation", runId: "origin", recorderNamespace: artifactDir, model: "fictional:extractor", budget: "bootstrap", manifest: "a".repeat(64), parent: null };
  mutate({ kind: "reserve", reservation: r });
  return { root, artifactDir, db, recorder, mutate, r };
}
it("atomically queues dispatch/result evidence and never converts legacy combined input or estimates to billed usage", async () => {
  const f = await memory();
  try {
    f.db.exec("BEGIN"); f.mutate({ kind: "dispatch", reservation: f.r }); f.db.exec("ROLLBACK");
    expect(f.db.prepare("SELECT * FROM continuity_upkeep_accounting").all()).toEqual([]);
    f.mutate({ kind: "dispatch", reservation: f.r });
    const receipt = { operationId: "operation", model: f.r.model, api: "openai-responses", capEnforcement: "request" as const, status: "invalid" as const, reason: "aborted", providerInvoked: true, elapsedMs: 1, inputTokens: 99, outputTokens: null, costUsd: null, estimatedInputTokens: 100, estimatedInputCostUsd: 1, visibleEstimate: 2, outputOverrun: false };
    expect(upkeepAccounting(f.r, receipt)).toMatchObject({ inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null });
    expect(() => upkeepAccounting(f.r, { ...receipt, operationId: "other" })).toThrow();
    expect(() => f.mutate({ kind: "outcome", reservation: f.r, receipt: { ...receipt, costUsd: -1 } })).toThrow();
    f.mutate({ kind: "outcome", reservation: f.r, receipt });
    expect(await replayUpkeepAccounting(f.db)).toBe(0); expect(await replayUpkeepAccounting(f.db)).toBe(0);
    expect((await readRecordedRun({ artifactDir: f.artifactDir }, "origin"))?.upkeepAccounting).toEqual([upkeepAccounting(f.r, receipt)]);
  } finally { await f.recorder.finish({}); f.db.close(); }
});
it("keeps failed exports pending and visible, then recovers delayed exports without charging a new run", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    const exporter = vi.fn(async () => { throw Object.assign(new Error("synthetic I/O failure"), { code: "EACCES" }); });
    expect(await replayUpkeepAccounting(f.db, { exporter, now: () => 0 })).toBe(1);
    expect(f.db.prepare("SELECT exported,error FROM continuity_upkeep_accounting").get()).toEqual({ exported: null, error: "export_io" });
    expect(await replayUpkeepAccounting(f.db, { now: () => 1000 })).toBe(0);
    const next = createJsonlRunRecorder({ artifactDir: f.artifactDir, runId: "next", conversationId: "fictional" }); await next.start!(); await next.finish({});
    expect((await readRecordedRun({ artifactDir: f.artifactDir }, "next"))?.upkeepAccounting).toBeUndefined();
    expect((await readRecordedRun({ artifactDir: f.artifactDir }, "origin"))?.upkeepAccounting?.[0]).toMatchObject({ phase: "dispatch", invocation: "uncertain", costUsd: null });
    await f.recorder.finish({}); await pruneRunArtifacts({ artifactDir: f.artifactDir, maxCount: 0 });
    f.db.exec("UPDATE continuity_upkeep_accounting SET exported=NULL,next_attempt_ms=0");
    expect(await replayUpkeepAccounting(f.db)).toBe(0);
    expect(f.db.prepare("SELECT exported FROM continuity_upkeep_accounting").get()).toEqual({ exported: "pruned" });
    expect(await readdir(f.artifactDir)).toEqual([]);
  } finally { await f.recorder.finish({}); f.db.close(); }
});
it.each(["dispatch", "result", "pending"])("recovers %s after process death before receipt/checkpoint, including journal-only upgrades while disabled", async phase => {
  const root = await rootDir(), artifactDir = join(root, "runs");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/upkeep-accounting-crash-child.mjs", import.meta.url)), root, artifactDir, phase], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
  try {
    const ready = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(stderr); })]);
    expect(ready[0]).toEqual({ ready: true });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const reader = new ToolHistoryReader(root), db = new DatabaseSync(reader.databasePath);
    if (phase === "pending") {
      // Actual committed outbox survived a failed pre-publication export and SIGKILL.
      expect(db.prepare("SELECT attempts,exported,error FROM continuity_upkeep_accounting").get()).toEqual({ attempts: 1, exported: null, error: "origin_pending" });
      await rename(join(artifactDir, "origin.held-summary"), join(artifactDir, "origin.summary.json"));
      db.exec("UPDATE continuity_upkeep_accounting SET next_attempt_ms=0"); // elapsed backoff
    } else {
      // Simulate a pre-outbox journal-only upgrade, not an event-derived recovery.
      db.exec("DROP TABLE continuity_upkeep_accounting");
    }
    db.close();
    for (const name of await readdir(artifactDir)) if (name.includes(".upkeep.")) await rm(join(artifactDir, name));
    expect(reader.hasPendingUpkeepAccounting()).toBe(true);
    const writer = await ToolHistoryWriter.open({ root }); // continuity AND upkeep disabled
    await writer.close(); expect(reader.hasPendingUpkeepAccounting()).toBe(false);
    const detail = await readRecordedRun({ artifactDir }, "origin");
    expect(detail?.events).toEqual([]);
    expect(detail?.upkeepAccounting).toHaveLength(1);
    expect(detail?.upkeepAccounting?.[0]).toMatchObject(phase !== "result" ? { phase: "dispatch", costUsd: null, invocation: "uncertain" } : { phase: "result", model: "fictional:extractor", inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, outputTokens: 2, costUsd: 0.2 });
    const files = await readdir(artifactDir), again = await ToolHistoryWriter.open({ root }); await again.close();
    expect(await readdir(artifactDir)).toEqual(files);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; } }
}, 15000);
it("is a read-only no-op without journal rows", async () => {
  const root = await rootDir(), reader = new ToolHistoryReader(root);
  expect(reader.hasPendingUpkeepAccounting()).toBe(false); expect(await readdir(root)).toEqual([]);
  const db = new DatabaseSync(":memory:");
  try {
    expect(await replayUpkeepAccounting(db)).toBe(0); expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
    db.exec("CREATE TABLE continuity_upkeep_operations(state TEXT,outcome TEXT)");
    expect(await replayUpkeepAccounting(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([{ name: "continuity_upkeep_operations" }]);
  } finally { db.close(); }
});

it("isolates corrupt legacy journal evidence as accounting degradation", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    f.db.exec("DROP TABLE continuity_upkeep_accounting; UPDATE continuity_upkeep_operations SET outcome='invalid',state='terminal'");
    expect(await replayUpkeepAccounting(f.db)).toBe(1);
    expect(f.db.prepare("SELECT phase,exported,error FROM continuity_upkeep_accounting ORDER BY phase").all()).toEqual([
      { phase: "dispatch", exported: "exported", error: null }, { phase: "result", exported: "failed", error: "invalid_journal" },
    ]);
  } finally { await f.recorder.finish({}); f.db.close(); }
});

it("bounds transient attempts with backoff and targets only the newly queued phase", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    const exporter = vi.fn(async () => { throw new Error("synthetic I/O failure"); });
    await replayUpkeepAccounting(f.db, { operationId: "unrelated", phase: "dispatch", exporter, now: () => 0 });
    expect(exporter).not.toHaveBeenCalled();
    for (const now of [0, 0, 999, 1000, 1000, 2999, 3000, 10000]) await replayUpkeepAccounting(f.db, { exporter, now: () => now });
    expect(exporter).toHaveBeenCalledTimes(3);
    expect(f.db.prepare("SELECT attempts,exported,error FROM continuity_upkeep_accounting").get()).toEqual({ attempts: 3, exported: "failed", error: "export_io" });
  } finally { await f.recorder.finish({}); f.db.close(); }
});
it.each(["invalid_payload", "origin_invalid", "origin_conflict", "companion_invalid", "companion_conflict", "namespace_invalid"] as const)("never retries permanent %s and retains its code", async code => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    const exporter = vi.fn(async () => { throw new UpkeepAccountingExportError(code); });
    await replayUpkeepAccounting(f.db, { exporter, now: () => 0 }); await replayUpkeepAccounting(f.db, { exporter, now: () => 100000 });
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT attempts,exported,error FROM continuity_upkeep_accounting").get()).toEqual({ attempts: 1, exported: "failed", error: code });
  } finally { await f.recorder.finish({}); f.db.close(); }
});
it("does not let a slow serialized exporter delay either dispatch or outcome mutation", async () => {
  const f = await memory(); let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const exporter = vi.fn(async () => { await paused; return "exported" as const; });
  const queue = createUpkeepAccountingExportQueue(f.db, () => {}, { exporter });
  try {
    f.mutate({ kind: "dispatch", reservation: f.r }); queue.schedule({ operationId: f.r.operationId, phase: "dispatch" });
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledTimes(1));
    // Admission/RPC work does not await the export tail, even while I/O is parked.
    const receipt = { operationId: f.r.operationId, model: f.r.model, providerInvoked: true, status: "invalid", reason: "aborted", inputTokens: null, outputTokens: null, costUsd: null } as Parameters<typeof upkeepAccounting>[1];
    expect(f.mutate({ kind: "outcome", reservation: f.r, receipt: receipt! })).toBeNull();
    queue.schedule({ operationId: f.r.operationId, phase: "result" });
    expect(f.db.prepare("SELECT state FROM continuity_upkeep_operations").get()).toEqual({ state: "terminal" });
    expect(exporter).toHaveBeenCalledTimes(1);
  } finally { release(); await queue.flush(); await f.recorder.finish({}); f.db.close(); }
});
it("turns non-integer and unsafe legacy counters into unknown without losing the paid outcome", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    const receipt = { operationId: f.r.operationId, model: f.r.model, providerInvoked: true, status: "valid", reason: "completed", inputTokens: 1.5, cacheReadTokens: Number.MAX_SAFE_INTEGER + 1, cacheWriteTokens: -1, outputTokens: 2.5, costUsd: 0.1 } as Parameters<typeof upkeepAccounting>[1];
    f.mutate({ kind: "outcome", reservation: f.r, receipt: receipt! });
    expect(upkeepAccounting(f.r, receipt)).toMatchObject({ inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: 0.1 });
    expect(f.db.prepare("SELECT state FROM continuity_upkeep_operations").get()).toEqual({ state: "terminal" });
  } finally { await f.recorder.finish({}); f.db.close(); }
});

it("durably distinguishes an unwritten origin from one observed and later pruned", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    const path = join(f.artifactDir, "origin.summary.json"), summary = await readFile(path, "utf8");
    await rm(path);
    expect(await replayUpkeepAccounting(f.db, { now: () => 0 })).toBe(1);
    expect(f.db.prepare("SELECT exported,error,origin_seen FROM continuity_upkeep_accounting").get()).toEqual({ exported: null, error: "origin_pending", origin_seen: 0 });
    await writeFile(path, summary);
    expect(await replayUpkeepAccounting(f.db, { now: () => 1000 })).toBe(0);
    expect(f.db.prepare("SELECT exported,error,origin_seen FROM continuity_upkeep_accounting").get()).toEqual({ exported: "exported", error: null, origin_seen: 1 });
    await rm(path); f.db.exec("UPDATE continuity_upkeep_accounting SET exported=NULL,next_attempt_ms=0");
    expect(await replayUpkeepAccounting(f.db, { now: () => 2000 })).toBe(0);
    expect(f.db.prepare("SELECT exported,error FROM continuity_upkeep_accounting").get()).toEqual({ exported: "pruned", error: null });
  } finally { await f.recorder.finish({}); f.db.close(); }
});

it("upgrades legacy outbox retry metadata without reviving invalid_journal", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    f.db.exec("DROP TABLE continuity_upkeep_accounting; CREATE TABLE continuity_upkeep_accounting(operation_id TEXT,phase TEXT,payload TEXT,exported TEXT,error TEXT,PRIMARY KEY(operation_id,phase)); INSERT INTO continuity_upkeep_accounting VALUES ('legacy','result','{}',NULL,'invalid_journal')");
    const exporter = vi.fn();
    expect(await replayUpkeepAccounting(f.db, { exporter })).toBe(1);
    expect(await replayUpkeepAccounting(f.db, { exporter })).toBe(1);
    expect(exporter).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT exported,error,attempts,origin_seen FROM continuity_upkeep_accounting").get()).toEqual({ exported: "failed", error: "invalid_journal", attempts: 0, origin_seen: 0 });
  } finally { await f.recorder.finish({}); f.db.close(); }
});
it("bounds never-written origins without ever acknowledging them as pruned", async () => {
  const f = await memory();
  try {
    f.mutate({ kind: "dispatch", reservation: f.r });
    const exporter = vi.fn(async () => "pending" as const);
    for (const now of [0, 999, 1000, 2999, 3000, 10000]) await replayUpkeepAccounting(f.db, { exporter, now: () => now });
    expect(exporter).toHaveBeenCalledTimes(3);
    expect(f.db.prepare("SELECT exported,error,origin_seen FROM continuity_upkeep_accounting").get()).toEqual({ exported: "failed", error: "origin_pending", origin_seen: 0 });
  } finally { await f.recorder.finish({}); f.db.close(); }
});

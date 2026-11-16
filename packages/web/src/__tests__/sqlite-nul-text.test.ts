import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteTextQuery, webTextColumns } from "../sqlite-text.js";
import { WebStore } from "../store.js";
import { fakeProcessJob, temporaryRoot } from "./helpers.js";
import type { WebCronRunSummary } from "../contracts.js";

const text = "before\u0000after é 🐈\u0000tail";
const roots: string[] = [];
const stores: WebStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await temporaryRoot(); roots.push(root);
  let now = new Date("2027-01-02T09:59:00Z");
  const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => now }); stores.push(store);
  store.replaceAgents([{ sourceId: "agent-one", label: text, status: "online", health: text,
    supportsAttachments: false, models: [], efforts: [],
    runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
    updatedAt: now.toISOString() }]);
  const thread = store.createThread("agent-one");
  return { store, thread, advance: () => { now = new Date("2027-01-02T10:00:00Z"); } };
}
function cron(store: WebStore, fields: Partial<WebCronRunSummary> = {}) {
  store.syncCronOverview({ sourceId: "agent-one", generatedAt: "2027-01-02T09:59:00Z", actionsEnabled: true,
    jobs: [{ jobId: "digest", expression: "*/5 * * * *", timezone: "UTC", conversationId: "cron:digest",
      configured: true, declaredEnabled: true, effectiveEnabled: true, health: "healthy" }] });
  const run: WebCronRunSummary = { projection: "summary", jobId: "digest", runId: "run-one", sequence: 1,
    scheduledAt: "2027-01-02T09:00:00Z", orderedAt: "2027-01-02T09:00:00Z", completedAt: "2027-01-02T09:01:00Z",
    trigger: "scheduled", status: "succeeded", eventCount: 0, ...fields };
  store.reconcileCronRunsResult("agent-one", "digest", [run]);
  return run;
}

describe("SQLite free text on the supported Node floor", () => {
  it("decodes bytes while preserving null, empty text and absent rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(sqliteTextQuery(db, "SELECT CAST(? AS BLOB) AS text, CAST(? AS BLOB) AS empty, CAST(NULL AS BLOB) AS missing")
        .get(text, "")).toEqual({ text, empty: "", missing: null });
      expect(sqliteTextQuery(db, "SELECT 1 WHERE 0").get()).toBeUndefined();
    } finally { db.close(); }
  });

  it("keeps explicit prose projections aligned with the migrated table shapes", async () => {
    const { store } = await fixture(); const db = new DatabaseSync(store.paths.database);
    try {
      for (const table of ["process_job_cards", "projects", "live_inputs", "cron_reply_operations", "restart_operations", "turns", "agents"] as const) {
        const names = webTextColumns(table).split(", ").map(column => column.split(" AS ").at(-1));
        expect(names).toEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      }
    } finally { db.close(); }
  });
  it("retries and reuses a process-job response without losing its NUL suffix", async () => {
    const { store, thread } = await fixture();
    const processJob = fakeProcessJob({ conversationId: `web:${thread.id}`, state: "running" });
    const input = { sourceId: thread.sourceId, threadId: thread.id, deliveryKey: processJob.wake.deliveryKey, processJob, responseText: text };
    const first = store.upsertProcessJobCard(input);
    expect(store.upsertProcessJobCard(input).duplicate).toBe(true);
    expect(() => store.upsertProcessJobCard({ ...input, responseText: "before" })).toThrow(/cannot be replaced/u);
    store.upsertProcessJobCard({ sourceId: input.sourceId, threadId: input.threadId, deliveryKey: input.deliveryKey,
      processJob: fakeProcessJob({ conversationId: `web:${thread.id}`, state: "succeeded" }) });
    expect(store.getMessage(first.messageId)?.parts).toContainEqual(expect.objectContaining({ type: "process-job", responseText: text }));
  });

  it.each(["text", "error"] as const)("does not rewrite unchanged cron %s and preserves snapshots", async field => {
    const { store } = await fixture();
    const run = cron(store, field === "text" ? { text } : { status: "failed", error: text });
    const db = new DatabaseSync(store.paths.database);
    try {
      db.exec("CREATE TABLE nul_writes (n INTEGER); INSERT INTO nul_writes VALUES (0); CREATE TRIGGER nul_turn_write AFTER UPDATE ON turns BEGIN UPDATE nul_writes SET n=n+1; END");
      store.reconcileCronRunsResult("agent-one", "digest", [run]);
      expect(db.prepare("SELECT n FROM nul_writes").get()?.n).toBe(0);
      const snapshot = store.captureCronReplySnapshot("agent-one", "digest", run.runId, "summary");
      expect(field === "text" ? snapshot.text : snapshot.errorMessage).toBe(text);
    } finally { db.close(); }
  });

  it("preserves fuller cron text across a truncated summary poll after NUL", async () => {
    const { store } = await fixture();
    const run = cron(store, { text });
    store.reconcileCronRunsResult("agent-one", "digest", [{ ...run, text: "before\u0000after", fieldsTruncated: ["text"] }]);
    expect(store.captureCronReplySnapshot("agent-one", "digest", run.runId, "summary").text).toBe(text);
  });

  it("keeps cron reply failure diagnostics on retries", async () => {
    const { store } = await fixture(); const run = cron(store, { text });
    const candidate = store.captureCronReplySnapshot("agent-one", "digest", run.runId, "summary");
    store.reserveCronReplyOperation("operation-one", candidate);
    store.failCronReplyOperation("operation-one", text);
    expect(store.cronReplyOperation("operation-one")).toMatchObject({ kind: "failed", operation: { failureReason: text } });
  });

  it("returns complete agent labels and health through single and list reads", async () => {
    const { store } = await fixture();
    expect(store.getAgent("agent-one")).toMatchObject({ label: text, health: text });
    expect(store.listAgents()[0]).toMatchObject({ label: text, health: text });
  });

  it("retains thread titles and project names/context for the user and model", async () => {
    const { store, thread } = await fixture();
    const project = store.createProject({ sourceId: "agent-one", name: text, context: text });
    store.patchThread(thread.id, { title: text, projectId: project.id });
    expect(store.getThread(thread.id)).toMatchObject({ title: text, projectName: text });
    expect(store.listProjects("agent-one")[0]).toMatchObject({ name: text, context: text });
    expect(store.projectContextForThread(thread.id)).toMatchObject({ name: text, context: text });
    const turn = store.beginTurn({ threadId: thread.id, text: "request", attachmentIds: [] });
    expect(store.projectContextForThread(thread.id)).toMatchObject({ name: text, context: text });
    expect(turn.text).toBe("request");
    expect(store.listActiveThreads().threads.find(row => row.id === thread.id)).toMatchObject({ title: text, projectName: text });
  });

  it("keeps queued live input when promoting it into a turn", async () => {
    const { store, thread } = await fixture();
    const turn = store.beginTurn({ threadId: thread.id, text: "start", attachmentIds: [] });
    const reserved = store.reserveLiveInput(thread.id, text);
    expect(store.storedLiveInput(reserved.input.id)?.text).toBe(text);
    store.queueLiveInput(reserved.input.id);
    store.completeTurn(turn.turnId, "done");
    const promoted = store.promoteNextQueuedLiveInput(thread.id);
    expect(promoted).toBeDefined();
    expect(promoted!.text).toBe(text);
  });

  it("keeps restart diagnostic reasons when updating and listing operations", async () => {
    const { store } = await fixture();
    const { operation } = store.createRestartOperation({ sourceId: "agent-one", generation: "generation-one", requestedAt: "2027-01-02T09:59:00Z", deadline: "2027-01-02T10:01:00Z", approximateRunningTurns: 0 });
    store.updateRestartOperation(operation.id, { reason: text });
    expect(store.restartOperation(operation.id)?.reason).toBe(text);
    expect(store.pendingRestartOperations()[0]?.reason).toBe(text);
    expect(store.updateRestartOperation(operation.id, { stage: "restarting" }).reason).toBe(text);
  });

  it("keeps a scheduled wake's full message when claiming it", async () => {
    const { store, thread, advance } = await fixture();
    store.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00", message: text });
    advance(); store.reconcileWake(thread.id, true);
    expect(store.claimWake(thread.id, "agent-one", () => true, {})?.prompt).toContain(text);
  });
});

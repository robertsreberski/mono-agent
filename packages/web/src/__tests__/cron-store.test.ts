import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WebAgentSummary, WebCronRun, WebCronRunSummary } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

function agent(sourceId = "agent-one"): WebAgentSummary {
  return {
    sourceId,
    label: sourceId,
    status: "online",
    health: "running",
    supportsAttachments: true,
    models: ["provider/default"],
    defaultModel: "provider/default",
    efforts: ["low", "high"],
    modelOptions: { "provider/default": { effortLevels: ["low", "high"] } },
    runSettings: {
      config: { model: "provider/default" },
      override: null,
      effective: { model: "provider/default", modelSource: "config", effortSource: "config" },
    },
    updatedAt: "2026-08-14T10:00:00.000Z",
  };
}

function syncCronJob(store: WebStore, input: {
  readonly sourceId?: string;
  readonly jobId?: string;
  readonly configured?: boolean;
  readonly effectiveEnabled?: boolean;
} = {}) {
  const sourceId = input.sourceId ?? "agent-one";
  const jobId = input.jobId ?? "daily:brief";
  return store.syncCronOverview({
    sourceId,
    generatedAt: "2026-08-14T10:00:00.000Z",
    actionsEnabled: true,
    jobs: [{
      jobId,
      expression: "*/5 * * * *",
      timezone: "Europe/Amsterdam",
      conversationId: `cron:${jobId}`,
      configured: input.configured ?? true,
      declaredEnabled: true,
      effectiveEnabled: input.effectiveEnabled ?? true,
      nextRunAt: "2026-08-14T10:05:00.000Z",
      health: "healthy",
    }],
  });
}

function cronRun(
  input: Partial<WebCronRunSummary> & Pick<WebCronRunSummary, "runId" | "sequence">,
): WebCronRunSummary {
  return {
    projection: "summary",
    jobId: "daily:brief",
    scheduledAt: "2026-08-14T10:05:00.000Z",
    orderedAt: "2026-08-14T10:00:00.000Z",
    trigger: "scheduled",
    status: "succeeded",
    eventCount: 0,
    ...input,
  };
}

function downgradeNotificationDeliveriesToV4(database: DatabaseSync): void {
  database.exec(`
    CREATE TEMP TABLE delivery_copy AS
      SELECT source_id, delivery_key, thread_id, trigger_kind, payload_sha256, created_at, completed_at
      FROM notification_deliveries;
    DROP TABLE notification_deliveries;
    CREATE TABLE notification_deliveries (
      source_id TEXT NOT NULL REFERENCES agents(source_id),
      delivery_key TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'webhook')),
      payload_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (source_id, delivery_key)
    );
    INSERT INTO notification_deliveries
      SELECT source_id, delivery_key, thread_id, trigger_kind, payload_sha256, created_at, completed_at
      FROM delivery_copy;
    DROP TABLE delivery_copy;
    PRAGMA user_version = 4;
  `);
}

function insertLegacyRunningTurn(database: DatabaseSync, threadId: string, id: string, at: string): void {
  const assistantMessageId = `${id}-assistant`;
  database.prepare(`
    INSERT INTO turns (
      id, thread_id, status, text, model, effort, assistant_message_id,
      started_at, finished_at, error_code, error_message
    ) VALUES (?, ?, 'running', ?, NULL, NULL, ?, ?, NULL, NULL, NULL)
  `).run(id, threadId, `Legacy prompt ${id}`, assistantMessageId, at);
  database.prepare(`
    INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
    VALUES (?, ?, ?, 'assistant', '[]', ?, ?, 'running')
  `).run(assistantMessageId, threadId, id, at, at);
}

describe("WebStore agent broadcast suppression", () => {
  it("persists a heartbeat-only refresh without reporting it as worth broadcasting", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });

    expect(store.replaceAgents([agent()])).toBe(true);

    // Only `updatedAt` moved. `agents.changed` formerly carried the entire agent
    // list, and even as a compact invalidation it makes every browser refresh.
    // The store must still take the fresher timestamp; it just must not call it
    // newsworthy on each five-second discovery poll.
    const beat = { ...agent(), updatedAt: "2026-08-14T10:00:05.000Z" };
    expect(store.replaceAgents([beat])).toBe(false);
    expect(store.listAgents()[0]?.updatedAt).toBe("2026-08-14T10:00:05.000Z");

    // A real change still broadcasts, even when the heartbeat moves with it —
    // otherwise suppression would swallow the update it rode in on.
    const real = {
      ...agent(),
      updatedAt: "2026-08-14T10:00:10.000Z",
      models: ["provider/default", "provider/added"],
    };
    expect(store.replaceAgents([real])).toBe(true);
    expect(store.listAgents()[0]?.models).toEqual(["provider/default", "provider/added"]);

    // A vanished agent is newsworthy on its own, with no summary to compare.
    expect(store.replaceAgents([])).toBe(true);
  });
});

describe("WebStore first-class cron channels", () => {
  it("returns a cron-specific read-only error while preserving offline errors for ordinary threads", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const cronThreadId = syncCronJob(store).jobs[0]!.threadId;

    for (const operation of [
      () => store.beginTurn({ threadId: cronThreadId, text: "not allowed", attachmentIds: [] }),
      () => store.reserveLiveInput(cronThreadId, "also not allowed"),
    ]) {
      expect(operation).toThrowError(expect.objectContaining({
        code: "cron_channel_read_only",
        message: "Cron channels are read-only. Scheduled runs and history are managed by the agent.",
      }));
    }

    const ordinary = store.createThread("agent-one");
    store.replaceAgents([]);
    for (const operation of [
      () => store.beginTurn({ threadId: ordinary.id, text: "offline", attachmentIds: [] }),
      () => store.reserveLiveInput(ordinary.id, "offline"),
    ]) {
      expect(operation).toThrowError(expect.objectContaining({ code: "agent_offline" }));
    }
    store.close();
  });

  it("keeps an in-flight run out of conversation search until it settles", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const runId = "cron:daily%3Abrief:2026-08-14T10:00:00.000Z";

    // A cron message is inserted with real prose while its run is still going,
    // so indexing it at insert would freeze that first body: the channel would
    // keep matching narration it no longer contains.
    store.reconcileCronRuns("agent-one", "daily:brief", [
      cronRun({ runId, sequence: 1, status: "running", text: "alphaunique early narration" }),
    ]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "alphaunique" }).hits).toEqual([]);

    store.reconcileCronRuns("agent-one", "daily:brief", [
      cronRun({ runId, sequence: 1, status: "running", text: "betaunique later narration" }),
    ]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "alphaunique" }).hits).toEqual([]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "betaunique" }).hits).toEqual([]);

    store.reconcileCronRuns("agent-one", "daily:brief", [
      cronRun({ runId, sequence: 1, status: "succeeded", text: "gammaunique final narration" }),
    ]);
    const settled = store.searchThreads({ sourceId: "agent-one", query: "gammaunique" });
    expect(settled.hits).toMatchObject([{ thread: { id: threadId } }]);
    // Only the settled text is searchable; no superseded body was ever indexed.
    expect(store.searchThreads({ sourceId: "agent-one", query: "alphaunique" }).hits).toEqual([]);
    expect(store.searchThreads({ sourceId: "agent-one", query: "betaunique" }).hits).toEqual([]);
    store.close();
  });

  it("gives each cron and notification reconciliation write its own message version", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const runId = "cron:daily%3Abrief:2026-08-14T10:00:00.000Z";

    // The insert starts the count, which is exactly what a console that has
    // never seen a delta for this message holds.
    const [inserted] = store.reconcileCronRuns("agent-one", "daily:brief", [
      cronRun({ runId, sequence: 1, status: "running", text: "Early narration" }),
    ]);
    expect(inserted?.seq).toBe(0);

    const [updated] = store.reconcileCronRuns("agent-one", "daily:brief", [
      cronRun({ runId, sequence: 1, status: "succeeded", text: "Final narration" }),
    ]);
    expect(updated?.seq).toBe(1);

    // A reconciliation that changes nothing writes nothing, so the version a
    // console holds stays valid.
    const [unchanged] = store.reconcileCronRuns("agent-one", "daily:brief", [
      cronRun({ runId, sequence: 1, status: "succeeded", text: "Final narration" }),
    ]);
    expect(unchanged?.seq).toBe(1);

    // The delivery folds its text into the same run message.
    const reservation = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${runId}:success`,
      jobId: "daily:brief",
      runId,
      text: "The digest is ready",
    });
    store.completeNotification(reservation);
    const message = store.getThreadDetail(threadId)?.messages.at(-1);
    expect(message).toMatchObject({ seq: 2 });
    expect(message?.parts).toContainEqual({ type: "text", text: "The digest is ready" });
    store.close();
  });

  it("marks an omitted job snapshot removed while retaining its offline channel and run history", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const run = cronRun({
      runId: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z",
      sequence: 1,
      text: "Retained history",
    });
    store.reconcileCronRuns("agent-one", "daily:brief", [run]);

    store.syncCronOverview({
      sourceId: "agent-one",
      generatedAt: "2026-08-14T10:10:00.000Z",
      actionsEnabled: true,
      jobs: [],
    });
    expect(store.getThread(threadId)).toMatchObject({
      trigger: { kind: "cron", jobId: "daily:brief", configured: false },
    });
    expect(store.storedCronOverview("agent-one")?.jobs).toEqual([
      expect.objectContaining({ jobId: "daily:brief", configured: false, threadId }),
    ]);
    expect(store.storedCronRuns("agent-one", "daily:brief").runs).toEqual([run]);
    store.close();

    const reopened = await WebStore.open({ stateDir });
    reopened.replaceAgents([]);
    expect(reopened.storedCronOverview("agent-one")?.jobs).toEqual([
      expect.objectContaining({ jobId: "daily:brief", configured: false, threadId }),
    ]);
    expect(reopened.storedCronRuns("agent-one", "daily:brief").runs).toEqual([run]);
    reopened.close();
  });

  it("groups structured deliveries and leaves replay-resistant threadless tombstones after deletion", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const runIds = [
      "cron:daily%3Abrief:2026-08-14T10:00:00.000Z",
      "cron:daily%3Abrief:2026-08-14T10:05:00.000Z",
    ] as const;
    for (const [index, runId] of runIds.entries()) {
      const reservation = store.reserveNotification({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey: `${runId}:success`,
        jobId: "daily:brief",
        runId,
        text: `Digest ${String(index + 1)}`,
      });
      expect(reservation.threadId).toBe(threadId);
      expect(store.completeNotification(reservation)).toMatchObject({ thread: { id: threadId }, duplicate: false });
    }
    expect(store.listThreadsPage({ sourceId: "agent-one", archived: false }).threads
      .filter((thread) => thread.trigger?.kind === "cron")).toHaveLength(1);

    store.patchThread(threadId, { archived: true });
    await expect(store.deleteArchivedThread(threadId)).rejects.toMatchObject({ code: "cron_channel_configured" });
    syncCronJob(store, { configured: false, effectiveEnabled: false });
    await expect(store.deleteArchivedThread(threadId)).resolves.toEqual({ orphanedFiles: 0 });

    const inspected = new DatabaseSync(store.paths.database, { readOnly: true });
    expect(inspected.prepare(`
      SELECT COUNT(*) AS count FROM notification_deliveries
      WHERE thread_id IS NULL AND completed_at IS NOT NULL
    `).get()).toEqual({ count: 2 });
    inspected.close();
    const replay = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${runIds[0]}:success`,
      jobId: "daily:brief",
      runId: runIds[0],
      text: "Digest 1",
    });
    expect(replay).toMatchObject({ duplicate: true, tombstoned: true });
    expect(store.completeNotification(replay)).toEqual({ duplicate: true, tombstoned: true });
    expect(store.getThread(threadId)).toBeUndefined();
    expect(syncCronJob(store, { configured: false, effectiveEnabled: false }).jobs).toEqual([]);
    const lateRunId = "cron:daily%3Abrief:2026-08-14T10:15:00.000Z";
    const late = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${lateRunId}:success`,
      jobId: "daily:brief",
      runId: lateRunId,
      text: "Late digest",
    });
    expect(late).toMatchObject({ duplicate: true, tombstoned: true });
    expect(store.completeNotification(late)).toEqual({ duplicate: true, tombstoned: true });
    expect(store.getThread(threadId)).toBeUndefined();
    const reconfigured = syncCronJob(store);
    expect(reconfigured.jobs[0]).toMatchObject({ jobId: "daily:brief", configured: true, threadId });
    expect(store.getThread(threadId)).toBeDefined();
    store.close();
  });

  it("keeps repeated overview polls non-writing after a historical channel is tombstoned", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    let clockCalls = 0;
    const store = await WebStore.open({
      stateDir: join(base, "state"),
      clock: () => {
        clockCalls += 1;
        return new Date(Date.parse("2026-08-14T10:00:00.000Z") + clockCalls * 1_000);
      },
    });
    store.replaceAgents([agent()]);
    const overview = (configured: boolean, generatedAt: string) => ({
      sourceId: "agent-one",
      generatedAt,
      actionsEnabled: true,
      jobs: [{
        jobId: "daily:brief",
        expression: "*/5 * * * *",
        timezone: "Europe/Amsterdam",
        conversationId: "cron:daily:brief",
        configured,
        declaredEnabled: true,
        effectiveEnabled: configured,
        nextRunAt: "2026-08-14T10:05:00.000Z",
        health: configured ? "healthy" as const : "disabled" as const,
      }],
    });

    const initial = store.syncCronOverviewResult(overview(true, "2026-08-14T10:00:00.000Z"));
    expect(initial.changed).toBe(true);
    expect(store.syncCronOverviewResult(overview(true, "2026-08-14T10:00:01.000Z")).changed).toBe(false);
    const threadId = initial.overview.jobs[0]!.threadId;
    expect(store.syncCronOverviewResult(overview(false, "2026-08-14T10:01:00.000Z")).changed).toBe(true);
    store.patchThread(threadId, { archived: true });
    await store.deleteArchivedThread(threadId);

    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    const snapshot = () => ({
      overviews: database.prepare("SELECT * FROM cron_overviews ORDER BY source_id").all(),
      channels: database.prepare("SELECT * FROM cron_channels ORDER BY source_id, job_id").all(),
      jobSnapshots: database.prepare("SELECT * FROM cron_job_snapshots ORDER BY source_id, job_id").all(),
      deletions: database.prepare("SELECT * FROM cron_channel_deletions ORDER BY source_id, job_id").all(),
      threads: database.prepare("SELECT id, revision, updated_at FROM threads ORDER BY id").all(),
      revisions: database.prepare("SELECT * FROM revisions ORDER BY entity_kind, entity_id, revision").all(),
      pushEvents: database.prepare("SELECT * FROM push_events ORDER BY id").all(),
    });
    const beforePolls = snapshot();
    const clockCallsBeforePolls = clockCalls;

    const second = store.syncCronOverviewResult(overview(false, "2026-08-14T10:02:00.000Z"));
    const third = store.syncCronOverviewResult(overview(false, "2026-08-14T10:03:00.000Z"));
    expect(second).toMatchObject({ changed: false, overview: { jobs: [] } });
    expect(third).toMatchObject({ changed: false, overview: { jobs: [] } });
    expect(clockCalls).toBe(clockCallsBeforePolls);
    expect(snapshot()).toEqual(beforePolls);

    database.close();
    store.close();
  });

  it("keeps omitted historical channels byte-stable after one configured job disappears", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    let clockCalls = 0;
    const store = await WebStore.open({
      stateDir: join(base, "state"),
      clock: () => {
        clockCalls += 1;
        return new Date(Date.parse("2026-08-14T10:00:00.000Z") + clockCalls * 1_000);
      },
    });
    store.replaceAgents([agent()]);
    const job = (jobId: string) => ({
      jobId,
      expression: "*/5 * * * *",
      timezone: "Europe/Amsterdam",
      conversationId: `cron:${jobId}`,
      configured: true,
      declaredEnabled: true,
      effectiveEnabled: true,
      nextRunAt: "2026-08-14T10:05:00.000Z",
      health: "healthy" as const,
    });
    const retained = job("daily:brief");
    const removed = job("weekly:report");
    const overview = (generatedAt: string, jobs: readonly ReturnType<typeof job>[]) => ({
      sourceId: "agent-one",
      generatedAt,
      actionsEnabled: true,
      jobs,
    });

    expect(store.syncCronOverviewResult(overview(
      "2026-08-14T10:00:00.000Z",
      [retained, removed],
    )).changed).toBe(true);
    expect(store.syncCronOverviewResult(overview(
      "2026-08-14T10:01:00.000Z",
      [retained],
    )).changed).toBe(true);
    expect(store.storedCronOverview("agent-one")?.jobs).toEqual([
      expect.objectContaining({ jobId: "daily:brief", configured: true }),
      expect.objectContaining({ jobId: "weekly:report", configured: false }),
    ]);

    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    const cronState = () => JSON.stringify({
      overviews: database.prepare("SELECT * FROM cron_overviews ORDER BY source_id").all(),
      channels: database.prepare("SELECT * FROM cron_channels ORDER BY source_id, job_id").all(),
      deletions: database.prepare("SELECT * FROM cron_channel_deletions ORDER BY source_id, job_id").all(),
      snapshots: database.prepare("SELECT * FROM cron_job_snapshots ORDER BY source_id, job_id").all(),
      runMessages: database.prepare("SELECT * FROM cron_run_messages ORDER BY source_id, job_id, run_id").all(),
    });
    const beforePolls = cronState();
    const clockCallsBeforePolls = clockCalls;

    const second = store.syncCronOverviewResult(overview("2026-08-14T10:02:00.000Z", [retained]));
    const third = store.syncCronOverviewResult(overview("2026-08-14T10:03:00.000Z", [retained]));
    expect(second).toMatchObject({ changed: false, overview: { jobs: [{ jobId: "daily:brief" }] } });
    expect(third).toMatchObject({ changed: false, overview: { jobs: [{ jobId: "daily:brief" }] } });
    expect(clockCalls).toBe(clockCallsBeforePolls);
    expect(cronState()).toBe(beforePolls);

    database.close();
    store.close();
  });

  it("turns an in-flight delivery into a completed threadless tombstone when its historical channel is deleted", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const runId = "cron:daily%3Abrief:2026-08-14T10:00:00.000Z";
    const reservation = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${runId}:success`,
      jobId: "daily:brief",
      runId,
      text: "Digest in flight",
    });
    syncCronJob(store, { configured: false, effectiveEnabled: false });
    store.patchThread(threadId, { archived: true });
    await store.deleteArchivedThread(threadId);

    expect(store.completeNotification(reservation)).toEqual({ duplicate: true, tombstoned: true });
    const inspected = new DatabaseSync(store.paths.database, { readOnly: true });
    expect(inspected.prepare(`
      SELECT thread_id, message_id, completed_at IS NOT NULL AS completed
      FROM notification_deliveries WHERE source_id = 'agent-one' AND delivery_key = ?
    `).get(`${runId}:success`)).toEqual({ thread_id: null, message_id: null, completed: 1 });
    inspected.close();
    store.close();
  });

  it("folds structured notifications into one run message in either reconciliation order", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const runFirst = cronRun({
      runId: "cron:daily%3Abrief:2026-08-14T10:05:00.000Z",
      sequence: 1,
      status: "admitted",
    });
    store.reconcileCronRuns("agent-one", "daily:brief", [runFirst]);
    const runFirstDelivery = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${runFirst.runId}:success`,
      jobId: "daily:brief",
      runId: runFirst.runId,
      text: "First digest",
    });
    store.completeNotification(runFirstDelivery);
    store.reconcileCronRuns("agent-one", "daily:brief", [{
      ...runFirst,
      status: "succeeded",
      startedAt: "2026-08-14T10:00:01.000Z",
      completedAt: "2026-08-14T10:00:02.000Z",
      text: "First digest",
    }]);

    const deliveryFirst = cronRun({
      runId: "cron:daily%3Abrief:2026-08-14T10:10:00.000Z",
      orderedAt: "2026-08-14T10:01:00.000Z",
      scheduledAt: "2026-08-14T10:10:00.000Z",
      sequence: 2,
      status: "succeeded",
      startedAt: "2026-08-14T10:01:01.000Z",
      completedAt: "2026-08-14T10:01:02.000Z",
      text: "Second digest",
    });
    const deliveryFirstReservation = store.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${deliveryFirst.runId}:success`,
      jobId: "daily:brief",
      runId: deliveryFirst.runId,
      text: "Second digest",
    });
    store.completeNotification(deliveryFirstReservation);
    store.reconcileCronRuns("agent-one", "daily:brief", [deliveryFirst]);

    const messages = store.getThreadDetail(threadId)!.messages;
    expect(messages).toHaveLength(2);
    for (const [index, expected] of ["First digest", "Second digest"].entries()) {
      const message = messages[index]!;
      expect(message.parts.filter((part) => part.type === "text" && part.text === expected)).toHaveLength(1);
      expect(message.parts.filter((part) => part.type === "telemetry" && part.event === "cron_run")).toHaveLength(1);
    }
    const inspected = new DatabaseSync(store.paths.database, { readOnly: true });
    expect(inspected.prepare(`
      SELECT COUNT(*) AS count FROM notification_deliveries d
      JOIN cron_run_messages r ON r.message_id = d.message_id
      WHERE d.source_id = 'agent-one' AND d.job_id = 'daily:brief'
    `).get()).toEqual({ count: 2 });
    inspected.close();
    store.close();
  });

  it("adopts only anchored historical keys, preserves ISO colons, and resolves old paths and push targets", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const freshBase = await temporaryRoot();
    cleanup.push(freshBase);
    const fresh = await WebStore.open({ stateDir: join(freshBase, "state") });
    fresh.replaceAgents([agent()]);
    const freshThreadId = syncCronJob(fresh).jobs[0]!.threadId;
    const freshState = new DatabaseSync(fresh.paths.database, { readOnly: true });
    const freshConversationId = (freshState.prepare("SELECT conversation_id FROM threads WHERE id = ?")
      .get(freshThreadId) as { conversation_id: string }).conversation_id;
    freshState.close();
    fresh.close();
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    initial.replaceAgents([agent()]);
    initial.registerWebPushSubscription({
      endpoint: "https://push.example.test/cron-migration",
      p256dh: "p256dh",
      auth: "auth",
      siteOrigin: "https://console.example.test",
      keyFingerprint: "fingerprint",
    });
    const deliveries = [
      ["cron:daily%3Abrief:2026-08-14T10:00:00.000Z:success", "First"],
      ["cron:daily%3Abrief:2026-08-14T10:05:00.000Z:failure:provider_unavailable_exhausted", "Second"],
      ["cron:daily%3Abrief:2026-08-14T10:10:00.000Z:success:extra", "Legacy"],
      ["cron:daily%3Abrief:garbage:success", "Malformed time"],
    ] as const;
    const oldThreadIds: string[] = [];
    for (const [deliveryKey, text] of deliveries) {
      const reservation = initial.reserveNotification({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey,
        text,
      });
      oldThreadIds.push(reservation.threadId!);
      initial.completeNotification(reservation);
    }
    initial.selectThread(oldThreadIds[1]!);
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    const queuedMessage = legacy.prepare("SELECT id FROM messages WHERE thread_id = ? LIMIT 1")
      .get(oldThreadIds[1]!) as { id: string };
    legacy.prepare(`
      INSERT INTO live_inputs (
        id, thread_id, message_id, active_turn_id, text, model, effort,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, 'queued', ?, ?)
    `).run(
      "legacy-cron-live-input",
      oldThreadIds[1]!,
      queuedMessage.id,
      "Queued before migration",
      "2026-08-14T10:06:00.000Z",
      "2026-08-14T10:06:00.000Z",
    );
    downgradeNotificationDeliveriesToV4(legacy);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    const canonical = migrated.getThread(oldThreadIds[0]!)!;
    expect(migrated.getThread(oldThreadIds[1]!)?.id).toBe(canonical.id);
    expect(migrated.getThreadDetail(oldThreadIds[1]!)?.messages.map((message) => message.parts[0]))
      .toEqual([{ type: "text", text: "First" }, { type: "text", text: "Second" }]);
    expect(migrated.currentThreadId()).toBe(canonical.id);
    const migratedState = new DatabaseSync(databasePath, { readOnly: true });
    expect(migratedState.prepare("SELECT thread_id FROM live_inputs WHERE id = 'legacy-cron-live-input'").get())
      .toEqual({ thread_id: canonical.id });
    migratedState.close();
    expect(migrated.patchThread(oldThreadIds[1]!, { archived: true })).toMatchObject({
      id: canonical.id,
      archivedAt: expect.any(String),
    });
    expect(migrated.getThread(oldThreadIds[2]!)?.id).toBe(oldThreadIds[2]);
    expect(migrated.getThread(oldThreadIds[3]!)?.id).toBe(oldThreadIds[3]);

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("SELECT conversation_id FROM threads WHERE id = ?").get(canonical.id)).toEqual({
      conversation_id: freshConversationId,
    });
    const identities = inspected.prepare(`
      SELECT delivery_key, job_id, run_id, thread_id FROM notification_deliveries ORDER BY delivery_key
    `).all() as Array<{ delivery_key: string; job_id: string | null; run_id: string | null; thread_id: string }>;
    expect(identities.find((row) => row.delivery_key.endsWith(":success"))).toMatchObject({
      job_id: "daily:brief",
      run_id: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z",
      thread_id: canonical.id,
    });
    expect(identities.find((row) => row.delivery_key.includes(":failure:"))).toMatchObject({
      job_id: "daily:brief",
      run_id: "cron:daily%3Abrief:2026-08-14T10:05:00.000Z",
      thread_id: canonical.id,
    });
    expect(identities.find((row) => row.delivery_key.endsWith(":success:extra"))).toMatchObject({
      job_id: null,
      run_id: null,
      thread_id: oldThreadIds[2],
    });
    expect(identities.find((row) => row.delivery_key.includes(":garbage:"))).toMatchObject({
      job_id: null,
      run_id: null,
      thread_id: oldThreadIds[3],
    });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM push_events WHERE thread_id = ?")
      .get(canonical.id)).toEqual({ count: 2 });
    inspected.close();
    expect(migrated.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: deliveries[0][0],
      jobId: "daily:brief",
      runId: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z",
      text: "First",
    })).toMatchObject({ duplicate: true, threadId: canonical.id });
    const subsequentRunId = "cron:daily%3Abrief:2026-08-14T10:15:00.000Z";
    const subsequent = migrated.reserveNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${subsequentRunId}:success`,
      jobId: "daily:brief",
      runId: subsequentRunId,
      text: "After migration",
    });
    expect(subsequent).toMatchObject({ duplicate: false, threadId: canonical.id });
    expect(migrated.completeNotification(subsequent)).toMatchObject({ thread: { id: canonical.id } });
    migrated.close();

    // Retry the eligible named adoption step against its already-adopted shape.
    const retry = new DatabaseSync(databasePath);
    retry.exec("PRAGMA user_version = 4");
    retry.close();
    const reopened = await WebStore.open({ stateDir });
    expect(reopened.getThread(oldThreadIds[1]!)?.id).toBe(canonical.id);
    const reopenedState = new DatabaseSync(databasePath, { readOnly: true });
    expect(reopenedState.prepare("SELECT conversation_id FROM threads WHERE id = ?").get(canonical.id)).toEqual({
      conversation_id: freshConversationId,
    });
    reopenedState.close();
    reopened.close();
  });

  it("adopts anchored legacy keys with literal job-id colons without widening malformed matches", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    let clockMs = Date.parse("2026-08-14T09:00:00.000Z");
    const initial = await WebStore.open({
      stateDir,
      clock: () => new Date(clockMs += 1_000),
    });
    initial.replaceAgents([agent()]);
    const keys = [
      "cron:team:daily:2026-08-14T10:00:00.000Z:success",
      "cron:team:daily:2026-08-14T10:05:00.000Z:failure:provider_unavailable_exhausted",
      "prefix:cron:team:daily:2026-08-14T10:10:00.000Z:success",
      "cron:team:daily:2026-08-14T10:15:00.000Z:success:extra",
      "cron:team:daily:2026-08-14T10:20:00Z:success",
      "cron:team:daily:2026-08-14T10:25:00.000Z:failure:provider:error",
    ] as const;
    const oldThreadIds = keys.map((deliveryKey, index) => {
      const reservation = initial.reserveNotification({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey,
        text: `Legacy ${String(index + 1)}`,
      });
      initial.completeNotification(reservation);
      return reservation.threadId!;
    });
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    downgradeNotificationDeliveriesToV4(legacy);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    const canonical = migrated.getThread(oldThreadIds[0]!)!;
    expect(migrated.getThread(oldThreadIds[1]!)?.id).toBe(canonical.id);
    for (const oldThreadId of oldThreadIds.slice(2)) {
      expect(migrated.getThread(oldThreadId)?.id).toBe(oldThreadId);
    }

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    const identities = inspected.prepare(`
      SELECT delivery_key, job_id, run_id, thread_id
      FROM notification_deliveries ORDER BY created_at, delivery_key
    `).all() as Array<{
      delivery_key: string;
      job_id: string | null;
      run_id: string | null;
      thread_id: string;
    }>;
    inspected.close();
    expect(identities.slice(0, 2)).toEqual([
      {
        delivery_key: keys[0],
        job_id: "team:daily",
        run_id: "cron:team:daily:2026-08-14T10:00:00.000Z",
        thread_id: canonical.id,
      },
      {
        delivery_key: keys[1],
        job_id: "team:daily",
        run_id: "cron:team:daily:2026-08-14T10:05:00.000Z",
        thread_id: canonical.id,
      },
    ]);
    expect(identities.slice(2).map((row) => [row.delivery_key, row.job_id, row.run_id])).toEqual(
      keys.slice(2).map((deliveryKey) => [deliveryKey, null, null]),
    );
    migrated.close();
  });

  it("interrupts two active legacy turns before folding their cron threads and restarts repeatedly", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const initial = await WebStore.open({ stateDir });
    initial.replaceAgents([agent()]);
    const deliveryKeys = [
      "cron:daily%3Abrief:2026-08-14T10:00:00.000Z:success",
      "cron:daily%3Abrief:2026-08-14T10:05:00.000Z:failure:provider_unavailable_exhausted",
    ] as const;
    const oldThreadIds = deliveryKeys.map((deliveryKey, index) => {
      const reservation = initial.reserveNotification({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey,
        text: `Legacy delivery ${String(index + 1)}`,
      });
      initial.completeNotification(reservation);
      return reservation.threadId!;
    });
    const databasePath = initial.paths.database;
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    insertLegacyRunningTurn(legacy, oldThreadIds[0]!, "legacy-running-one", "2026-08-14T10:01:00.000Z");
    insertLegacyRunningTurn(legacy, oldThreadIds[1]!, "legacy-running-two", "2026-08-14T10:06:00.000Z");
    downgradeNotificationDeliveriesToV4(legacy);
    legacy.close();

    const migrated = await WebStore.open({ stateDir });
    const canonical = migrated.getThread(oldThreadIds[0]!)!;
    expect(migrated.getThread(oldThreadIds[1]!)?.id).toBe(canonical.id);
    const migratedState = new DatabaseSync(databasePath, { readOnly: true });
    expect(migratedState.prepare(`
      SELECT id, thread_id, status, error_code FROM turns
      WHERE id IN ('legacy-running-one', 'legacy-running-two') ORDER BY id
    `).all()).toEqual([
      { id: "legacy-running-one", thread_id: canonical.id, status: "interrupted", error_code: "interrupted" },
      { id: "legacy-running-two", thread_id: canonical.id, status: "interrupted", error_code: "interrupted" },
    ]);
    expect(migratedState.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE turn_id IN ('legacy-running-one', 'legacy-running-two')
        AND status = 'interrupted' AND parts_json LIKE '%web service restarted%'
    `).get()).toEqual({ count: 2 });
    migratedState.close();
    migrated.close();

    const reopened = await WebStore.open({ stateDir });
    expect(reopened.listActiveTurnIds()).toEqual([]);
    expect(reopened.getThread(oldThreadIds[1]!)?.id).toBe(canonical.id);
    reopened.close();
  });

  it("settles interrupted cron projections without pushing for runs the web service did not own", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    let clockMs = Date.parse("2026-08-14T10:00:00.000Z");
    const initial = await WebStore.open({ stateDir, clock: () => new Date(clockMs) });
    initial.replaceAgents([agent()]);
    initial.registerWebPushSubscription({
      endpoint: "https://push.example.test/restart-ownership",
      p256dh: "p256dh",
      auth: "auth",
      siteOrigin: "https://console.example.test",
      keyFingerprint: "fingerprint",
    });
    const cronThreadId = syncCronJob(initial).jobs[0]!.threadId;
    const runningCron = cronRun({
      runId: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z",
      sequence: 1,
      status: "running",
      startedAt: "2026-08-14T10:00:01.000Z",
    });
    initial.reconcileCronRuns("agent-one", "daily:brief", [runningCron]);
    const ordinaryThread = initial.createThread("agent-one");
    const ordinaryTurn = initial.beginTurn({
      threadId: ordinaryThread.id,
      text: "Web-owned unfinished turn",
      attachmentIds: [],
    });
    initial.close();

    clockMs += 60_000;
    const reopened = await WebStore.open({ stateDir, clock: () => new Date(clockMs) });
    expect(reopened.getThread(cronThreadId)?.runState).toMatchObject({
      status: "interrupted",
      error: { code: "interrupted" },
    });
    expect(reopened.getThread(ordinaryThread.id)?.runState).toMatchObject({
      status: "interrupted",
      error: { code: "interrupted" },
    });
    const inspected = new DatabaseSync(reopened.paths.database, { readOnly: true });
    expect(inspected.prepare(`
      SELECT kind, thread_id FROM push_events
      WHERE kind = 'run.interrupted' ORDER BY thread_id
    `).all()).toEqual([{ kind: "run.interrupted", thread_id: ordinaryThread.id }]);
    expect(inspected.prepare("SELECT status FROM turns WHERE id = ?").get(ordinaryTurn.turnId))
      .toEqual({ status: "interrupted" });
    inspected.close();
    reopened.close();
  });

  it("keeps keyset pages bounded per source and archive bucket", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    let clockMs = Date.parse("2026-08-14T00:00:00.000Z");
    const store = await WebStore.open({ stateDir: join(base, "state"), clock: () => new Date(clockMs) });
    store.replaceAgents([agent("alpha"), agent("beta")]);
    const advance = () => { clockMs += 1_000; };
    advance();
    const beta = store.createThread("beta");
    for (let index = 0; index < 205; index += 1) {
      advance();
      store.createThread("alpha");
    }
    for (let index = 0; index < 205; index += 1) {
      advance();
      const thread = store.createThread("alpha");
      advance();
      store.patchThread(thread.id, { archived: true });
    }
    // 205 rows in each bucket, and no page can reach past the cap.
    expect(store.listThreadsPage({ sourceId: "alpha", archived: false, limit: 200 }).threads).toHaveLength(200);
    expect(store.listThreadsPage({ sourceId: "alpha", archived: true, limit: 200 }).threads).toHaveLength(200);
    expect(() => store.listThreadsPage({ sourceId: "alpha", archived: false, limit: 201 }))
      .toThrowError(expect.objectContaining({ code: "invalid_page" }));

    const first = store.listThreadsPage({ sourceId: "alpha", archived: false, limit: 2 });
    advance();
    const landed = store.createThread("alpha");
    expect(first.nextCursor).toBeDefined();
    const second = store.listThreadsPage({ sourceId: "alpha", archived: false, limit: 2, before: first.nextCursor! });
    const firstIds = first.threads.map((thread) => thread.id);
    expect(second.threads.map((thread) => thread.id)).not.toContain(landed.id);
    expect(second.threads.every((thread) => !firstIds.includes(thread.id))).toBe(true);
    expect(store.listThreadsPage({ sourceId: "beta", archived: false }).threads.map((thread) => thread.id)).toEqual([beta.id]);
    expect(store.listThreadsPage({ sourceId: "alpha", archived: true, limit: 3 }).threads).toHaveLength(3);
    store.close();
  });

  it("uses one total run order and rejects mutation of orderedAt or sequence", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const runs: WebCronRun[] = [
      cronRun({ runId: "cron:daily%3Abrief:one", sequence: 1, status: "queued", queueDepth: 1 }),
      cronRun({
        runId: "cron:daily%3Abrief:two",
        sequence: 2,
        status: "skipped_overlap",
        blockedByRunId: "cron:daily%3Abrief:manual:m1",
        blockedByTrigger: "manual",
      }),
      cronRun({ runId: "cron:daily%3Abrief:three", sequence: 3, status: "dropped" }),
    ];
    store.reconcileCronRuns("agent-one", "daily:brief", [runs[2]!, runs[0]!, runs[1]!]);
    expect(store.storedCronRuns("agent-one", "daily:brief").runs.map((run) => run.sequence)).toEqual([3, 2, 1]);
    const feed = store.getThreadDetail(threadId)!.messages;
    expect(feed.map((message) => {
      const telemetry = message.parts.find((part) => part.type === "telemetry" && part.event === "cron_run");
      return telemetry?.type === "telemetry"
        && typeof telemetry.data === "object"
        && telemetry.data !== null
        && "sequence" in telemetry.data
        ? telemetry.data.sequence
        : undefined;
    })).toEqual([1, 2, 3]);
    expect(() => store.reconcileCronRuns("agent-one", "daily:brief", [{
      ...runs[1]!,
      orderedAt: "2026-08-14T10:01:00.000Z",
    }])).toThrowError(expect.objectContaining({ code: "invalid_cron_response" }));
    store.close();
  });

  it("updates one run message in place without retaining stale state copy or telemetry", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const admitted = cronRun({
      runId: "cron:daily%3Abrief:transition",
      sequence: 7,
      status: "admitted",
    });
    store.reconcileCronRuns("agent-one", "daily:brief", [admitted]);
    store.reconcileCronRuns("agent-one", "daily:brief", [{
      ...admitted,
      status: "running",
      startedAt: "2026-08-14T10:00:01.000Z",
    }]);
    store.reconcileCronRuns("agent-one", "daily:brief", [{
      ...admitted,
      status: "succeeded",
      startedAt: "2026-08-14T10:00:01.000Z",
      completedAt: "2026-08-14T10:00:02.000Z",
    }]);

    const messages = store.getThreadDetail(threadId)!.messages;
    expect(messages).toEqual([]);
    const raw = new DatabaseSync(join(base, "state", "state.sqlite"));
    expect(raw.prepare("SELECT cron_suppressed, status FROM messages").get()).toMatchObject({ cron_suppressed: 1, status: "complete" });
    raw.close();
    store.close();
  });

  it("makes unchanged run reconciliation non-writing and converges one real change exactly once", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    let clockMs = Date.parse("2026-08-14T10:00:00.000Z");
    const store = await WebStore.open({
      stateDir: join(base, "state"),
      clock: () => new Date(clockMs += 1_000),
    });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const admitted = cronRun({
      runId: "cron:daily%3Abrief:idempotent",
      sequence: 12,
      status: "admitted",
    });
    expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [admitted]).changed).toBe(true);

    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    const snapshot = () => ({
      thread: database.prepare("SELECT revision, updated_at FROM threads WHERE id = ?").get(threadId),
      revisions: database.prepare("SELECT COUNT(*) AS count FROM revisions WHERE entity_kind = 'thread' AND entity_id = ?")
        .get(threadId),
      turns: database.prepare("SELECT COUNT(*) AS count FROM turns WHERE thread_id = ?").get(threadId),
      messages: database.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(threadId),
      mappings: database.prepare("SELECT COUNT(*) AS count FROM cron_run_messages WHERE thread_id = ?").get(threadId),
    });
    const beforeIdle = snapshot();
    for (let tick = 0; tick < 100; tick += 1) {
      expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [admitted]).changed).toBe(false);
    }
    expect(snapshot()).toEqual(beforeIdle);

    const completed = {
      ...admitted,
      status: "succeeded" as const,
      startedAt: "2026-08-14T10:00:01.000Z",
      completedAt: "2026-08-14T10:00:02.000Z",
      text: "Converged once",
    };
    expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [completed]).changed).toBe(true);
    const afterChange = snapshot();
    expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [completed]).changed).toBe(false);
    expect(snapshot()).toEqual(afterChange);
    database.close();
    store.close();
  });

  it("persists bounded detail activity and its truncation state across compact polls and reopen", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const store = await WebStore.open({ stateDir });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    const summary = cronRun({
      runId: "cron:daily%3Abrief:detail",
      sequence: 13,
      eventCount: 30,
      text: "Bounded summary",
      fieldsTruncated: ["text"],
    });
    store.reconcileCronRuns("agent-one", "daily:brief", [summary]);
    const detail: WebCronRun = {
      ...summary,
      projection: "detail",
      text: "Full selected run text",
      events: [{ type: "runtime_warning", message: "One retained activity item" }],
      eventsIncluded: 1,
      eventsTruncated: true,
    };
    expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [detail]).changed).toBe(true);
    const afterDetail = store.getThread(threadId)!.revision;
    expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [summary]).changed).toBe(false);
    expect(store.getThread(threadId)!.revision).toBe(afterDetail);

    const assertPersisted = (messageParts: readonly unknown[]) => {
      expect(messageParts).toContainEqual(expect.objectContaining({
        type: "telemetry",
        event: "cron_run",
        data: expect.objectContaining({
          activityLoaded: true,
          activityEventCount: 30,
          loadedEventCount: 1,
          eventsTruncated: true,
        }),
      }));
      expect(messageParts).toContainEqual(expect.objectContaining({
        type: "telemetry",
        event: "runtime_warning",
      }));
      expect(messageParts).toContainEqual({ type: "text", text: "Full selected run text" });
    };
    assertPersisted(store.getThreadDetail(threadId)!.messages[0]!.parts);
    expect(store.storedCronRuns("agent-one", "daily:brief").runs[0]).toEqual(summary);
    store.close();

    const reopened = await WebStore.open({ stateDir });
    assertPersisted(reopened.getThreadDetail(threadId)!.messages[0]!.parts);
    reopened.close();
  });

  it("retains only the newest bounded thread revision history", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    for (let revision = 0; revision < 1_005; revision += 1) {
      store.patchThread(thread.id, { title: `Revision ${String(revision)}` });
    }
    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM revisions WHERE entity_kind = 'thread' AND entity_id = ?
    `).get(thread.id)).toEqual({ count: 1_000 });
    database.close();
    store.close();
  });

  it("projects the canonical no-report sentinel as a silent completion", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const store = await WebStore.open({ stateDir: join(base, "state") });
    store.replaceAgents([agent()]);
    const threadId = syncCronJob(store).jobs[0]!.threadId;
    store.reconcileCronRuns("agent-one", "daily:brief", [cronRun({
      runId: "cron:daily%3Abrief:silent",
      sequence: 8,
      status: "succeeded",
      text: "  NOTHING_TO_REPORT  ",
    })]);

    expect(store.getThreadDetail(threadId)!.messages).toEqual([]);
    expect(store.storedCronRuns("agent-one", "daily:brief").runs).toHaveLength(1);
    store.close();
  });

  it("keeps backward message paging stable when a newer turn lands", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    let clockMs = Date.parse("2026-08-14T10:00:00.000Z");
    const store = await WebStore.open({ stateDir: join(base, "state"), clock: () => new Date(clockMs) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("agent-one");
    for (let index = 1; index <= 3; index += 1) {
      clockMs += 1_000;
      const turn = store.beginTurn({ threadId: thread.id, text: `Prompt ${String(index)}`, attachmentIds: [] });
      store.completeTurn(turn.turnId, `Answer ${String(index)}`);
    }
    const first = store.listMessagesPage(thread.id, { limit: 2 });
    clockMs += 1_000;
    const landed = store.beginTurn({ threadId: thread.id, text: "Prompt 4", attachmentIds: [] });
    store.completeTurn(landed.turnId, "Answer 4");
    expect(first.nextCursor).toBeDefined();
    const second = store.listMessagesPage(thread.id, { limit: 2, before: first.nextCursor! });
    expect(new Set([...first.messages, ...second.messages].map((message) => message.id)).size).toBe(4);
    expect(second.messages.map((message) => message.id)).not.toContain(landed.userMessageId);
    expect(second.messages.map((message) => message.id)).not.toContain(landed.assistantMessageId);
    store.close();
  });
});

describe("silent cron projections", () => {
  async function fixture() {
    const root = await temporaryRoot(); cleanup.push(root);
    const store = await WebStore.open({ stateDir: join(root, "state") });
    store.replaceAgents([agent()]);
    const thread = syncCronJob(store).jobs[0]!.threadId;
    return { store, thread };
  }

  it.each([
    [undefined, "succeeded", true], [" \n", "succeeded", true],
    [" nothing_to_report ", "succeeded", true], ["Checked everything\nNOTHING_TO_REPORT", "succeeded", true],
    ["NOTHING_TO_REPORT\nReal answer", "succeeded", false], ["Mention NOTHING_TO_REPORT here", "succeeded", false],
    ["NOTHING_TO_REPORT", "failed", false], ["NOTHING_TO_REPORT", "cancelled", false],
  ] as const)("classifies %j with status %s", async (text, status, silent) => {
    const { store, thread } = await fixture();
    try {
      const before = store.getThread(thread)!;
      const run = cronRun({ runId: "matrix", sequence: 1, status, ...(text === undefined ? {} : { text }) });
      const result = store.reconcileCronRunsResult("agent-one", "daily:brief", [run]);
      expect(result.messages).toHaveLength(silent ? 0 : 1);
      expect(result.writtenMessageIds).toHaveLength(silent ? 0 : 1);
      expect(result.changed).toBe(!silent);
      expect(store.getThread(thread)!.revision).toBe(before.revision + (silent ? 0 : 1));
      const repeated = store.reconcileCronRunsResult("agent-one", "daily:brief", [run]);
      expect(repeated.changed).toBe(false);
      expect(repeated.writtenMessageIds).toEqual([]);
    } finally { store.close(); }
  });

  it("hides a running row from every public read and preserves history and stable revisions", async () => {
    const { store, thread } = await fixture();
    try {
      const run = cronRun({ runId: "transition", sequence: 1, status: "running" });
      const message = store.reconcileCronRuns("agent-one", "daily:brief", [run])[0]!;
      const silent = { ...run, status: "succeeded" as const, text: "NOTHING_TO_REPORT" };
      const before = store.getThread(thread)!;
      expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [silent])).toMatchObject({ changed: true, messages: [], writtenMessageIds: [] });
      expect(store.getThread(thread)).toMatchObject({ messageCount: 0, revision: before.revision + 1 });
      expect(store.getThread(thread)!.lastMessagePreview).toBeUndefined();
      expect(store.getMessage(message.id)).toBeUndefined();
      expect(store.listMessagesPage(thread, { limit: 1 })).toEqual({ messages: [] });
      expect(store.searchThreads({ sourceId: "agent-one", query: "silently" }).hits).toEqual([]);
      expect(store.storedCronRuns("agent-one", "daily:brief")).toMatchObject({ runs: [expect.objectContaining({ runId: run.runId })], messages: [] });
      expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [{ ...silent, eventCount: 2 }]).changed).toBe(false);
      expect(store.getThread(thread)!.revision).toBe(before.revision + 1);
    } finally { store.close(); }
  });

  it.each([
    [true, "Delivered answer"], [false, "Delivered answer"],
    [true, "Completed silently (no message was reported)."], [false, "Completed silently (no message was reported)."],
  ] as const)("completed notification wins with delivery-first=%s and text=%s", async (deliveryFirst, deliveryText) => {
    const { store, thread } = await fixture();
    try {
      const run = cronRun({ runId: "notification", sequence: 1, text: "NOTHING_TO_REPORT" });
      const reservation = store.reserveNotification({ sourceId: "agent-one", triggerKind: "cron", jobId: "daily:brief", runId: run.runId, deliveryKey: "notification-key", text: deliveryText });
      if (deliveryFirst) store.completeNotification(reservation);
      const result = store.reconcileCronRunsResult("agent-one", "daily:brief", [run]);
      expect(result.messages).toHaveLength(deliveryFirst ? 1 : 0);
      if (!deliveryFirst) store.completeNotification(reservation);
      const visible = store.getThreadDetail(thread)!.messages;
      expect(visible).toHaveLength(1);
      expect(visible[0]!.parts.filter((part) => part.type === "text")).toEqual([{ type: "text", text: deliveryText }]);
      expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [run]).messages).toHaveLength(1);
      const revision = store.getThread(thread)!.revision;
      expect(store.completeNotification(reservation).duplicate).toBe(true);
      expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [run]).changed).toBe(false);
      expect(store.getThread(thread)!.revision).toBe(revision);
    } finally { store.close(); }
  });

  it("keeps ambiguous prefixes visible and remembers authoritative suppression across truncated summaries", async () => {
    const { store, thread } = await fixture();
    try {
      const run = cronRun({ runId: "truncated", sequence: 1, text: "NOTHING_TO_REPORT", fieldsTruncated: ["text"] });
      expect(store.reconcileCronRuns("agent-one", "daily:brief", [run])).toHaveLength(1);
      const detail = { ...run, fieldsTruncated: [], projection: "detail" as const, events: [], eventsIncluded: 0 };
      expect(store.reconcileCronRuns("agent-one", "daily:brief", [detail])).toEqual([]);
      expect(store.reconcileCronRunsResult("agent-one", "daily:brief", [{ ...run, text: "Checked a long list" }]).changed).toBe(false);
      expect(store.getThreadDetail(thread)!.messages).toEqual([]);
    } finally { store.close(); }
  });

  it("preserves rich replies when a contradictory silent summary and detail arrive", async () => {
    const { store, thread } = await fixture();
    try {
      const run = cronRun({ runId: "rich", sequence: 1, status: "running" });
      const message = store.reconcileCronRuns("agent-one", "daily:brief", [run])[0]!;
      const rich = { type: "mcp_app", id: "11111111-1111-4111-8111-111111111111",
        invocationId: "11111111-1111-4111-8111-111111111111", connectionId: "connection", serverName: "widgets",
        toolName: "chart", resourceUri: "ui://widgets/chart", mediaType: "text/html;profile=mcp-app", protocolVersion: "2026-01-26" };
      const db = new DatabaseSync(store.paths.database);
      db.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(JSON.stringify([...message.parts, rich]), message.id);
      db.close();
      const silent = { ...run, status: "succeeded" as const, text: "NOTHING_TO_REPORT" };
      expect(store.reconcileCronRuns("agent-one", "daily:brief", [silent])).toHaveLength(1);
      expect(store.reconcileCronRuns("agent-one", "daily:brief", [{ ...silent, projection: "detail", events: [], eventsIncluded: 0 }])).toHaveLength(1);
      expect(store.getThreadDetail(thread)!.messages[0]!.parts).toContainEqual(rich);
    } finally { store.close(); }
  });

  it("filters before page limits and retains 500 visible runs independently of silent runs", async () => {
    const { store, thread } = await fixture();
    try {
      const runs = Array.from({ length: 1100 }, (_, sequence) => cronRun({ runId: `retained-${sequence}`, sequence,
        text: sequence < 500 ? `Visible ${sequence}` : "NOTHING_TO_REPORT" }));
      const result = store.reconcileCronRunsResult("agent-one", "daily:brief", runs);
      expect(result.messages).toHaveLength(500);
      expect(result.writtenMessageIds).toHaveLength(500);
      expect(store.getThread(thread)).toMatchObject({ messageCount: 500, lastMessagePreview: "Visible 499" });
      let before: string | undefined; const ids: string[] = [];
      do {
        const page = store.listMessagesPage(thread, { limit: 37, ...(before === undefined ? {} : { before }) });
        ids.push(...page.messages.map((message) => message.id)); before = page.nextCursor;
      } while (before !== undefined);
      expect(new Set(ids).size).toBe(500);
      const database = new DatabaseSync(store.paths.database, { readOnly: true });
      try { expect(database.prepare("SELECT cron_suppressed, COUNT(*) AS count FROM messages GROUP BY cron_suppressed ORDER BY cron_suppressed").all()).toEqual([{ cron_suppressed: 0, count: 500 }, { cron_suppressed: 1, count: 500 }]); }
      finally { database.close(); }
    } finally { store.close(); }
  });
});

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { WebAgentSummary } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
const agent = (): WebAgentSummary => ({
  sourceId: "fictional-agent", label: "Fictional", status: "online", health: "running", supportsAttachments: false,
  models: ["test/model"], defaultModel: "test/model", efforts: ["low"],
  runSettings: { config: { model: "test/model" }, override: null,
    effective: { model: "test/model", modelSource: "config", effortSource: "config" } },
  updatedAt: "2026-01-01T00:00:00Z",
});
const definition = { kind: "once" as const, timezone: "UTC", localAt: "2027-01-02T10:00", message: "Check the draft." };

describe("wake schedule ledger", () => {
  it("keeps the wake message as the latest sidebar preview through an empty answer", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent()]);
      for (const message of ["Check the draft.", undefined]) {
        const thread = store.createThread("fictional-agent");
        store.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00",
          ...(message === undefined ? {} : { message }) });
        now = Date.parse("2027-01-02T10:00:00Z");
        store.reconcileWake(thread.id, true);
        const claimed = store.claimWake(thread.id, thread.sourceId, () => true, {});
        expect(claimed).not.toBeNull();
        const preview = message ?? "Scheduled wake-up";
        expect(store.getThread(thread.id)?.lastMessagePreview).toBe(preview);
        store.completeTurn(claimed!.started.turnId, "");
        expect(store.getThread(thread.id)?.lastMessagePreview).toBe(preview);
        now = Date.parse("2027-01-02T09:59:00Z");
      }
    } finally { store.close(); }
  });
  it("claims a busy occurrence once, survives reopening before and after admission, and preserves the transcript marker", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    let now = Date.parse("2027-01-02T09:59:00Z");
    let store = await WebStore.open({ stateDir, clock: () => new Date(now) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("fictional-agent");
    const schedule = store.createWakeSchedule(thread.id, definition);
    expect(schedule.nextFireAt).toBe("2027-01-02T10:00:00.000Z");
    const foreground = store.beginTurn({ threadId: thread.id, text: "Existing work", attachmentIds: [] });
    now += 61 * 60_000;
    expect(store.reconcileWake(thread.id, true)).toBe(true);
    expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
    store.close();
    store = await WebStore.open({ stateDir, clock: () => new Date(now) });
    store.completeTurn(foreground.turnId, "Finished");
    const claimed = store.claimWake(thread.id, thread.sourceId, () => true, { model: "test/model", effort: "low" });
    expect(claimed?.prompt).toContain("<scheduled-user-message>\nCheck the draft.");
    expect(store.getMessage(claimed!.started.assistantMessageId)?.parts).toEqual([expect.objectContaining({ type: "scheduled-wake", message: "Check the draft." })]);
    expect(store.wakeSchedule(thread.id)?.state).toBe("completed");
    store.close();
    store = await WebStore.open({ stateDir, clock: () => new Date(now) });
    expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
    expect(store.getMessage(claimed!.started.assistantMessageId)?.parts[0]?.type).toBe("scheduled-wake");
    store.close();
  });

  it("drains already queued user input before a pending wake and never claims during a turn", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent()]);
      const thread = store.createThread("fictional-agent");
      store.createWakeSchedule(thread.id, definition);
      const first = store.beginTurn({ threadId: thread.id, text: "Existing work", attachmentIds: [] });
      const queued = store.reserveLiveInput(thread.id, "Queued before the wake");
      store.queueLiveInput(queued.input.id);
      now += 60_000;
      expect(store.reconcileWake(thread.id, true)).toBe(true);
      store.completeTurn(first.turnId, "Finished");
      expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
      const promoted = store.promoteNextQueuedLiveInput(thread.id)!;
      expect(promoted.text).toBe("Queued before the wake");
      expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
      store.completeTurn(promoted.turnId, "Finished queued work");
      const wake = store.claimWake(thread.id, thread.sourceId, () => true, {});
      expect(wake?.started.turnId).toBeTruthy();
      expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
    } finally { store.close(); }
  });

  it("never replays an admitted occurrence after reopen", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    let now = Date.parse("2027-01-02T10:01:00Z");
    let store = await WebStore.open({ stateDir, clock: () => new Date(now) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("fictional-agent");
    store.createWakeSchedule(thread.id, { ...definition, localAt: "2027-01-02T10:02" });
    now += 60_000;
    store.reconcileWake(thread.id, true);
    const claimed = store.claimWake(thread.id, thread.sourceId, () => true, {});
    expect(claimed).not.toBeNull();
    store.markWakeAdmitted(claimed!.started.turnId);
    store.close();
    store = await WebStore.open({ stateDir, clock: () => new Date("2027-01-02T10:03:00Z") });
    expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
    expect(store.wakeSchedule(thread.id)?.lastOutcome).toBe("uncertain");
    store.close();
  });

  it("pauses atomically on archive, rejects stale revisions and cancels unclaimed pending intent", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    let now = Date.parse("2027-01-02T09:59:00Z");
    const store = await WebStore.open({ stateDir, clock: () => new Date(now) });
    store.replaceAgents([agent()]);
    const thread = store.createThread("fictional-agent");
    const created = store.createWakeSchedule(thread.id, definition);
    expect(() => store.createWakeSchedule(thread.id, definition)).toThrow(/already has a schedule/u);
    now += 2 * 60_000;
    store.reconcileWake(thread.id, true);
    store.patchThread(thread.id, { archived: true });
    expect(store.wakeSchedule(thread.id)?.state).toBe("paused");
    expect(() => store.changeWakeSchedule(thread.id, created.revision, { state: "active" })).toThrow(/Schedule changed/u);
    const raw = new DatabaseSync(store.paths.database);
    expect(raw.prepare("SELECT state FROM wake_occurrences WHERE thread_id = ? AND state = 'pending'").get(thread.id)).toBeUndefined();
    store.patchThread(thread.id, { archived: false });
    expect(store.wakeSchedule(thread.id)?.state).toBe("paused");
    expect(() => store.changeWakeSchedule(thread.id, store.wakeSchedule(thread.id)!.revision, { state: "active" }))
      .toThrow(/Edit this expired one-off/u);
    const future = store.changeWakeSchedule(thread.id, store.wakeSchedule(thread.id)!.revision,
      { definition: { ...definition, localAt: "2027-01-03T10:00" } });
    expect(future?.state).toBe("active");
    store.close(); raw.close();
  });

  it("keeps a busy intent past grace while offline, but skips an unqueued offline one-off after grace", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent()]);
      const busy = store.createThread("fictional-agent");
      const offline = store.createThread("fictional-agent");
      store.createWakeSchedule(busy.id, definition);
      store.createWakeSchedule(offline.id, definition);
      const foreground = store.beginTurn({ threadId: busy.id, text: "Continue", attachmentIds: [] });
      now += 2 * 60_000;
      expect(store.reconcileWake(busy.id, true)).toBe(true);
      expect(store.reconcileWake(offline.id, false)).toBe(false);
      now += 120 * 60_000;
      store.completeTurn(foreground.turnId, "Done");
      expect(store.reconcileWake(offline.id, false)).toBe(false);
      expect(store.wakeSchedule(offline.id)?.state).toBe("completed");
      expect(store.wakeSchedule(offline.id)?.lastOutcome).toBe("skipped");
      expect(store.claimWake(busy.id, busy.sourceId, () => true, {})).not.toBeNull();
      expect(store.claimWake(offline.id, offline.sourceId, () => true, {})).toBeNull();
    } finally { store.close(); }
  });

  it("admits previously unqueued occurrences through minute 60 but skips at minute 61", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent()]);
      const threads = [59, 60, 61].map(() => store.createThread("fictional-agent"));
      threads.forEach((thread) => store.createWakeSchedule(thread.id, definition));
      for (const [index, lateMinutes] of [59, 60, 61].entries()) {
        now = Date.parse("2027-01-02T10:00:00Z") + lateMinutes * 60_000;
        const thread = threads[index]!;
        expect(store.reconcileWake(thread.id, true)).toBe(lateMinutes <= 60);
        expect(store.claimWake(thread.id, thread.sourceId, () => true, {}) !== null).toBe(lateMinutes <= 60);
        if (lateMinutes === 61) {
          expect(store.wakeSchedule(thread.id)?.state).toBe("completed");
          expect(store.wakeSchedule(thread.id)?.lastOutcome).toBe("skipped");
        }
      }
    } finally { store.close(); }
  });

  it("coalesces months of missed weekly slots into one recent occurrence", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-04T08:00:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent()]);
      const thread = store.createThread("fictional-agent");
      store.createWakeSchedule(thread.id, { kind: "weekly", timezone: "UTC", days: [1], times: ["09:00"] });
      now = Date.parse("2027-04-05T09:59:00Z");
      expect(store.reconcileWake(thread.id, true)).toBe(true);
      const raw = new DatabaseSync(store.paths.database);
      const pending = raw.prepare("SELECT scheduled_at FROM wake_occurrences WHERE thread_id = ? AND state = 'pending'")
        .all(thread.id) as Array<{ scheduled_at: string }>;
      expect(pending).toHaveLength(1);
      expect(pending[0]?.scheduled_at).toBe("2027-04-05T09:00:00.000Z");
      expect(store.wakeSchedule(thread.id)?.nextFireAt).toBe("2027-04-12T09:00:00.000Z");
      raw.close();
    } finally { store.close(); }
  });

  it("uses wall time for a due date beyond Node timer range and never repeats after a backward jump", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-01T00:00:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent()]);
      const thread = store.createThread("fictional-agent");
      store.createWakeSchedule(thread.id, { ...definition, localAt: "2027-03-30T10:00" });
      expect(store.wakeDueThreadIds()).not.toContain(thread.id);
      now = Date.parse("2027-03-30T10:00:00Z");
      expect(store.wakeDueThreadIds()).toContain(thread.id);
      store.reconcileWake(thread.id, true);
      expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).not.toBeNull();
      now = Date.parse("2027-01-02T00:00:00Z");
      expect(store.wakeDueThreadIds()).not.toContain(thread.id);
      expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
    } finally { store.close(); }
  });

  it("rejects a schedule whose retained source differs from its thread on every operation", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
    try {
      store.replaceAgents([agent(), { ...agent(), sourceId: "other-agent" }]);
      const thread = store.createThread("fictional-agent");
      store.createWakeSchedule(thread.id, definition);
      const raw = new DatabaseSync(store.paths.database);
      raw.prepare("UPDATE wake_schedules SET source_id = 'other-agent' WHERE thread_id = ?").run(thread.id);
      now += 60_000;
      expect(store.wakeSchedule(thread.id)).toBeNull();
      expect(() => store.changeWakeSchedule(thread.id, 1, { state: "paused" })).toThrow(/No schedule exists/u);
      expect(store.reconcileWake(thread.id, true)).toBe(false);
      expect(store.claimWake(thread.id, thread.sourceId, () => true, {})).toBeNull();
      raw.close();
    } finally { store.close(); }
  });

  it("cascades deletion and rejects a damaged current-version ledger index", async () => {
    const root = await temporaryRoot(); roots.push(root);
    const stateDir = join(root, "state");
    const store = await WebStore.open({ stateDir, clock: () => new Date("2027-01-02T09:59:00Z") });
    store.replaceAgents([agent()]);
    const thread = store.createThread("fictional-agent");
    store.createWakeSchedule(thread.id, definition);
    store.patchThread(thread.id, { archived: true });
    await store.deleteArchivedThread(thread.id);
    const database = new DatabaseSync(store.paths.database);
    expect(database.prepare("SELECT 1 FROM wake_schedules WHERE thread_id = ?").get(thread.id)).toBeUndefined();
    database.exec("DROP INDEX wake_occurrences_pending");
    store.close(); database.close();
    // Bootstrap recreates missing indexes; a mismatched existing definition is
    // the current-version shape corruption that must fail open.
    const damaged = new DatabaseSync(join(stateDir, "state.sqlite"));
    damaged.exec("CREATE INDEX wake_occurrences_pending ON wake_occurrences(state, thread_id)");
    damaged.close();
    await expect(WebStore.open({ stateDir })).rejects.toThrow(/storage|migration|shape|corrupt/iu);
  });
});

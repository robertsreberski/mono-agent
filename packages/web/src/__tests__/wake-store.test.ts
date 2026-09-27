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

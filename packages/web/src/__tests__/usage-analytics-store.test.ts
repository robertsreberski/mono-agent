import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebStore } from "../store.js";
import type { WebAgentSummary } from "../contracts.js";
import * as costs from "../message-cost.js";

const roots: string[] = [];
const stores: WebStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const query = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", bucket: "day" as const, timeZone: "UTC" };
const agent = (id: string): WebAgentSummary => ({ sourceId: id, label: "Fictional agent", status: "offline", supportsAttachments: false, updatedAt: query.from,
  runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } } });
async function fixture() {
  const cache = new URL("../../node_modules/.cache/", import.meta.url).pathname;
  await mkdir(cache, { recursive: true }); const root = await mkdtemp(join(cache, "usage-analytics-")); roots.push(root);
  const stateDir = join(root, "state");
  const store = await WebStore.open({ stateDir, clock: () => new Date("2026-10-25T12:00:00Z") }); stores.push(store);
  store.replaceAgents([agent("fictional"), agent("another")]);
  const first = store.createThread("fictional"), archived = store.createThread("fictional"), other = store.createThread("another");
  const db = new DatabaseSync(join(stateDir, "state.sqlite"));
  const project = store.createProject({ sourceId: "fictional", name: "Fictional seed catalog" });
  db.prepare("UPDATE threads SET project_id=? WHERE id IN (?,?)").run(project.id, first.id, archived.id);
  db.prepare("UPDATE threads SET archived_at=? WHERE id=?").run(query.from, archived.id);
  let id = 0;
  function append(thread: string, price: number, at = "2026-10-25T12:00:00.000Z", role = "assistant") {
    const message = `fictional-message-${id++}`;
    const parts = [{ type: "telemetry", event: "usage_update", data: { model: "fictional:swift", cumulativeUsd: price, tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 } } }];
    db.prepare("INSERT INTO messages(id,thread_id,role,parts_json,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?)").run(message, thread, role, JSON.stringify(parts), at, at, "complete");
    return message;
  }
  return { store, db, root: stateDir, first, archived, other, project, append };
}

describe("indexed usage analytics store", () => {
  it("includes archived/source-bound background rows, respects half-open bounds and agrees with project month", async () => {
    const f = await fixture();
    try {
      f.append(f.first.id, 1); f.append(f.archived.id, 2); f.append(f.other.id, 50);
      f.append(f.first.id, 100, query.to); // exclusive upper bound
      f.append(f.first.id, 70, "2026-09-30T23:59:59.999Z");
      // A silent cron-style assistant row is still accounting, not transcript visibility.
      const silent = f.append(f.first.id, 0.5); f.db.prepare("UPDATE messages SET cron_suppressed=1 WHERE id=?").run(silent);
      const analytics = await f.store.usageAnalytics("fictional", query);
      expect(analytics.total.costUsd).toBe(3.5); expect(analytics.coverage.messages).toBe(3);
      expect(analytics.topConversations).toHaveLength(2);
      const comparable = analytics.topProjects[0]!.projectSummaryUsage;
      expect(comparable.costUsd).toBe(f.store.getProject(f.project.id)!.monthUsd);
      expect(comparable.costUsd).toBe(1.5); expect(analytics.topProjects[0]?.usage.costUsd).toBe(3.5);
      f.db.prepare("DELETE FROM messages WHERE thread_id=?").run(f.archived.id);
      expect((await f.store.usageAnalytics("fictional", query)).total.costUsd).toBe(1.5);
    } finally { f.db.close(); }
  });
  it("shares memo parsing with thread usage and invalidates on message seq change/reinsertion", async () => {
    const f = await fixture(), spy = vi.spyOn(costs, "messageUsageRollup");
    try {
      const id = f.append(f.first.id, 1);
      await f.store.threadUsage(f.first.id); expect(spy).toHaveBeenCalledTimes(1);
      expect((await f.store.usageAnalytics("fictional", query)).total.costUsd).toBe(1); expect(spy).toHaveBeenCalledTimes(1);
      f.db.prepare("UPDATE messages SET parts_json=?,seq=seq+1 WHERE id=?").run(JSON.stringify([{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: 3 } }]), id);
      expect((await f.store.usageAnalytics("fictional", query)).total.costUsd).toBe(3); expect(spy).toHaveBeenCalledTimes(2);
      // Keep another row above the deleted rowid, just like retained cron history.
      f.append(f.first.id, 0);
      f.db.prepare("DELETE FROM messages WHERE id=?").run(id);
      f.db.prepare("INSERT INTO messages(id,thread_id,role,parts_json,created_at,updated_at,status) VALUES(?,?,'assistant',?,?,?,'complete')")
        .run(id, f.first.id, JSON.stringify([{ type: "telemetry", event: "usage_update", data: { cumulativeUsd: 5 } }]), "2026-10-25T12:00:00.000Z", "2026-10-25T12:00:00.000Z");
      expect((await f.store.usageAnalytics("fictional", query)).total.costUsd).toBe(5);
      expect((f.store as unknown as { usageMemo: Map<string, unknown> }).usageMemo.size).toBeLessThanOrEqual(20_000);
    } finally { f.db.close(); }
  });
  it("uses the source/thread date index and migrates its required postcondition", async () => {
    const f = await fixture();
    try {
      const plan = f.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE thread_id=? AND created_at>=? AND created_at<? ORDER BY created_at,id LIMIT 100001").all(f.first.id, query.from, query.to);
      expect(JSON.stringify(plan)).toContain("messages_usage_range");
      const scoped = f.db.prepare(`EXPLAIN QUERY PLAN WITH candidate AS MATERIALIZED (
        SELECT m.id FROM threads t JOIN messages m ON m.thread_id=t.id WHERE t.source_id=? AND m.created_at>=? AND m.created_at<?
        ORDER BY m.created_at,m.id LIMIT 100001
      ) SELECT m.id FROM candidate c JOIN messages m ON m.id=c.id`).all("fictional", query.from, query.to);
      expect(JSON.stringify(scoped)).toContain("COVERING INDEX messages_usage_range");
      f.store.close(); f.db.exec("DROP INDEX messages_usage_range; PRAGMA user_version=43");
      const reopened = await WebStore.open({ stateDir: f.root }); stores.push(reopened);
      expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='messages_usage_range'").get()).toBeTruthy();
      expect((f.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(44);
    } finally { f.db.close(); }
  });
  it("rejects invalid zones/ranges and aborted queries", async () => {
    const f = await fixture();
    try {
      await expect(f.store.usageAnalytics("fictional", { ...query, timeZone: "fictional/no-zone" })).rejects.toMatchObject({ code: "invalid_usage_range" });
      const controller = new AbortController(); controller.abort();
      await expect(f.store.usageAnalytics("fictional", query, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally { f.db.close(); }
  });
  it("refuses over-budget rows/bytes instead of presenting incomplete top rankings", async () => {
    const f = await fixture();
    try {
      const large = "x".repeat(1024 * 1024);
      const insert = f.db.prepare("INSERT INTO messages(id,thread_id,role,parts_json,created_at,updated_at,status) VALUES(?,?,'assistant',?, ?,?,'running')");
      f.db.exec("BEGIN");
      for (let i = 0; i < 65; i++) insert.run(`large-${i}`, f.first.id, JSON.stringify([{ type: "text", text: large }]), "2026-10-25T12:00:00.000Z", "2026-10-25T12:00:00.000Z");
      f.db.exec("COMMIT");
      await expect(f.store.usageAnalytics("fictional", query)).rejects.toMatchObject({ code: "usage_range_too_large", status: 413 });
      f.db.exec("DELETE FROM messages");
      f.db.prepare(`INSERT INTO messages(id,thread_id,role,parts_json,created_at,updated_at,status)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100001)
        SELECT 'row-'||i,?,'assistant','[]','2026-10-25T12:00:00.000Z','2026-10-25T12:00:00.000Z','running' FROM n`).run(f.first.id);
      await expect(f.store.usageAnalytics("fictional", query)).rejects.toMatchObject({ code: "usage_range_too_large" });
    } finally { f.db.close(); }
  }, 20_000);
});

it("keeps NUL-bearing conversation and project labels in usage analytics", async () => {
  const f = await fixture(), text = "before\u0000after é 🐈\u0000tail";
  try {
    f.store.patchThread(f.first.id, { title: text });
    f.store.patchProject(f.project.id, { name: text });
    f.append(f.first.id, 1);
    const analytics = await f.store.usageAnalytics("fictional", query);
    expect(analytics.topConversations[0]?.title).toBe(text);
    expect(JSON.stringify(analytics.topProjects)).toContain(JSON.stringify(text).slice(1, -1));
  } finally { f.db.close(); }
});

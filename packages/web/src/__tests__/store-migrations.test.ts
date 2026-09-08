import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runWebStorageMigrations,
  validateWebStorageMigrationRegistry,
  WEB_STORAGE_MIGRATIONS,
  WEB_STORAGE_SCHEMA_VERSION,
  type WebStorageMigration,
} from "../store-migrations.js";
import { WebStore } from "../store.js";
import { prepareWebStatePaths } from "../state-paths.js";
import * as migrationsModule from "../store-migrations.js";
import { fakeMonitor, temporaryRoot } from "./helpers.js";
import { seedLegacyStorage, seedLegacySilentCron } from "./fixtures/storage-layouts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seeded(version: number, sequenced17 = false): Promise<string> {
  const root = await temporaryRoot("web-migration-");
  roots.push(root);
  const stateDir = join(root, "state");
  await prepareWebStatePaths({ stateDir });
  const database = new DatabaseSync(join(stateDir, "state.sqlite"));
  try {
    database.exec("BEGIN IMMEDIATE");
    seedLegacyStorage(database, Math.min(version, 18), sequenced17);
    if (version === 19) {
      database.exec(`
        ALTER TABLE messages ADD COLUMN cron_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (cron_suppressed IN (0,1));
        PRAGMA user_version = 19;
      `);
    }
    database.exec("COMMIT");
  } finally { database.close(); }
  return stateDir;
}

function schema(database: DatabaseSync): unknown {
  const tables = ["agents", "threads", "turns", "messages", "live_inputs", "web_submissions", "cron_reply_operations", "attachments", "notification_deliveries", "monitor_wake_deliveries", "agent_run_overrides"];
  return tables.map((table) => ({
    table,
    // ALTER appends columns, so physical column ordinal is not a shape claim.
    columns: (database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
      .map(({ cid: _cid, ...column }) => column).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${table})`).all(),
  }));
}

const historical = [...Array.from({ length: 21 }, (_, version) => ({ version, sequenced17: false })),
  { version: 17, sequenced17: true }];

describe("web storage migration history", () => {
  it.each(historical)("preserves real layout $version (sequenced17=$sequenced17) and reopens", async ({ version, sequenced17 }) => {
    const stateDir = await seeded(version, sequenced17);
    const freshDir = await seeded(0);
    const fresh = await WebStore.open({ stateDir: freshDir });
    fresh.close();
    const reference = new DatabaseSync(join(freshDir, "state.sqlite"), { readOnly: true });
    let expectedShape: unknown;
    try { expectedShape = schema(reference); } finally { reference.close(); }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await WebStore.open({ stateDir });
      try {
        if (version > 0) expect(store.getMessage("fixture-message")).toMatchObject({
          parts: [{ type: "text", text: "Retained answer" }],
          seq: version >= 18 || sequenced17 ? 7 : 0,
        });
      } finally { store.close(); }
      const database = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: WEB_STORAGE_SCHEMA_VERSION });
        expect(schema(database)).toEqual(expectedShape);
        expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        if (version > 0) {
          expect(database.prepare("SELECT id, message_id FROM attachments").get())
            .toMatchObject({ id: "fixture-attachment", message_id: "fixture-message" });
          expect(database.prepare("SELECT text FROM turns WHERE id = 'fixture-turn'").get()).toMatchObject({ text: "Retained answer" });
          expect(database.prepare("SELECT body FROM message_search WHERE message_search MATCH 'Retained'").get()).toMatchObject({ body: "Retained answer" });
        }
        if (version >= 2) expect(database.prepare("SELECT payload_sha256 FROM notification_deliveries").get()).toMatchObject({ payload_sha256: "a".repeat(64) });
        if (version >= 11) expect(database.prepare("SELECT run_model, run_effort FROM threads").get()).toMatchObject({ run_model: "provider/retained", run_effort: "high" });
        if (version >= 13) expect(database.prepare("SELECT payload_sha256, state, disposition FROM monitor_wake_deliveries").get()).toMatchObject({ payload_sha256: "b".repeat(64), state: "completed", disposition: "steered" });
        if (version >= 17) expect(database.prepare("SELECT model, effort FROM agent_run_overrides").get()).toMatchObject({ model: "provider/retained", effort: "high" });
        if (version > 0) expect(database.prepare(`
          SELECT requested_model, requested_effort, effective_effort, routing_json
          FROM turns WHERE id = 'fixture-turn'
        `).get()).toEqual({
          requested_model: null,
          requested_effort: null,
          effective_effort: null,
          routing_json: '{"transitions":[],"retries":[]}',
        });
      } finally { database.close(); }
    }
  });

  it.each([1, 4, 13, 15, 17])("can apply the real eligible steps twice inside the upgrade from %i", async (version) => {
    const stateDir = await seeded(version);
    const originalRun = runWebStorageMigrations;
    vi.spyOn(migrationsModule, "runWebStorageMigrations").mockImplementation((context) => {
      originalRun(context);
      originalRun(context);
    });
    const store = await WebStore.open({ stateDir });
    try { expect(store.getMessage("fixture-message")?.parts).toEqual([{ type: "text", text: "Retained answer" }]); }
    finally { store.close(); }
  });

  it("retains an existing Monitor projection during legacy FK repair and a repeated eligible open", async () => {
    const stateDir = await seeded(13);
    const projection = JSON.stringify(fakeMonitor({ monitorId: "fixture-monitor", conversationId: "web:fixture-thread" }));
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("ALTER TABLE monitor_wake_deliveries ADD COLUMN projection_json TEXT");
    database.prepare("UPDATE monitor_wake_deliveries SET projection_json = ?").run(projection);
    database.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await WebStore.open({ stateDir });
      store.close();
      const inspected = new DatabaseSync(join(stateDir, "state.sqlite"));
      try {
        expect(inspected.prepare("SELECT projection_json FROM monitor_wake_deliveries").get()).toMatchObject({ projection_json: projection });
        if (attempt === 0) inspected.exec("PRAGMA user_version = 13");
      } finally { inspected.close(); }
    }
  });

  it("rejects an invalid registry before bootstrap creates tables", async () => {
    const stateDir = await seeded(0);
    const validate = validateWebStorageMigrationRegistry;
    vi.spyOn(migrationsModule, "validateWebStorageMigrationRegistry").mockImplementation(() => validate([]));
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt", message: "Invalid web storage migration registry." });
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    try { expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]); }
    finally { database.close(); }
  });

  it.each([
    "CREATE INDEX messages_by_thread ON messages(created_at)",
    "DROP TABLE agent_run_overrides; CREATE TABLE agent_run_overrides (source_id TEXT PRIMARY KEY, model TEXT, effort TEXT, updated_at TEXT NOT NULL)",
  ])("rejects current-version index/FK drift: %s", async (sql) => {
    const stateDir = await seeded(18);
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec(sql);
    database.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt", message: "Web storage migration postconditions failed." });
  });

  it("rolls back earlier steps and bootstrap when a later step fails without leaking its error", async () => {
    const stateDir = await seeded(15);
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("ALTER TABLE messages ADD COLUMN seq")) throw new Error("private stored content");
      return exec.call(this, sql);
    });
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({
      code: "storage_corrupt", message: "Web storage migration 18 (message-sequence-repair) failed.",
    });
    vi.restoreAllMocks();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    try {
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 15 });
      expect(database.prepare("PRAGMA table_info(agents)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "discovered" })]));
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_run_overrides'").get()).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toMatchObject({ count: 1 });
    } finally { database.close(); }
    const store = await WebStore.open({ stateDir });
    store.close();
  });

  it.each([WEB_STORAGE_SCHEMA_VERSION + 1, -1])("rejects unsupported/invalid version %i before bootstrap", async (version) => {
    const stateDir = await seeded(0);
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec(`PRAGMA user_version = ${version}`);
    database.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({
      code: version === WEB_STORAGE_SCHEMA_VERSION + 1 ? "unsupported_storage_schema" : "storage_corrupt",
    });
    const inspected = new DatabaseSync(join(stateDir, "state.sqlite"));
    try {
      expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: version });
    } finally { inspected.close(); }
  });

  it("rejects a current stamp lacking seq instead of pretending it ran the repair", async () => {
    const stateDir = await seeded(17);
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("PRAGMA user_version = 21");
    database.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt", message: "Web storage migration postconditions failed." });
  });

  it("rejects a schema-21 stamp lacking route-attribution columns", async () => {
    const stateDir = await seeded(19);
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("PRAGMA user_version = 21");
    database.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({
      code: "storage_corrupt",
      message: "Web storage migration postconditions failed.",
    });
  });

  it("migrates schema 21 by adding a nullable live-input dispatch marker", async () => {
    const stateDir = await seeded(0);
    const initial = await WebStore.open({ stateDir });
    initial.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("ALTER TABLE live_inputs DROP COLUMN dispatch_started_at; PRAGMA user_version = 21");
    database.close();

    const migrated = await WebStore.open({ stateDir });
    migrated.close();
    const inspected = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
    try {
      expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: WEB_STORAGE_SCHEMA_VERSION });
      expect(inspected.prepare("PRAGMA table_info(live_inputs)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "dispatch_started_at", type: "TEXT", notnull: 0 }),
      ]));
    } finally { inspected.close(); }
  });

  it("migrates schema 22 by provisioning the guarded submission ledger and reopens", async () => {
    const stateDir = await seeded(0);
    const initial = await WebStore.open({ stateDir });
    initial.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("DROP TABLE web_submissions; PRAGMA user_version = 22");
    database.close();

    const migrated = await WebStore.open({ stateDir });
    migrated.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = await WebStore.open({ stateDir });
      reopened.close();
      const inspected = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
      try {
        expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: WEB_STORAGE_SCHEMA_VERSION });
        expect(inspected.prepare("PRAGMA table_info(web_submissions)").all()).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "thread_id", type: "TEXT", notnull: 1 }),
          expect.objectContaining({ name: "submission_id", type: "TEXT", notnull: 1 }),
          expect.objectContaining({ name: "payload_sha256", type: "TEXT", notnull: 1 }),
        ]));
      } finally { inspected.close(); }
    }
  });

  const readIndexes = {
    messages_by_turn: ["turn_id"],
    turns_by_thread_started: ["thread_id", "started_at"],
  } as const;
  function indexColumns(database: DatabaseSync, index: string): string[] {
    return (database.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((column) => column.name);
  }

  it.each([
    "DROP INDEX messages_by_turn; CREATE INDEX messages_by_turn ON messages(thread_id)",
    "DROP INDEX turns_by_thread_started; CREATE INDEX turns_by_thread_started ON turns(started_at, thread_id)",
  ])("rejects a schema-24 stamp whose read index drifted: %s", async (sql) => {
    const stateDir = await seeded(0);
    const initial = await WebStore.open({ stateDir });
    initial.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec(sql);
    database.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({
      code: "storage_corrupt", message: "Web storage migration postconditions failed.",
    });
  });

  it("migrates schema 23 by adding the thread read indexes and reopens idempotently", async () => {
    const stateDir = await seeded(0);
    const initial = await WebStore.open({ stateDir });
    initial.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("DROP INDEX messages_by_turn; DROP INDEX turns_by_thread_started; PRAGMA user_version = 23");
    database.close();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const store = await WebStore.open({ stateDir });
      try { expect(store.getThread("fixture-thread")).toBeUndefined(); } finally { store.close(); }
      const inspected = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
      try {
        expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: WEB_STORAGE_SCHEMA_VERSION });
        for (const [index, columns] of Object.entries(readIndexes)) expect(indexColumns(inspected, index)).toEqual(columns);
        expect(inspected.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
      } finally { inspected.close(); }
    }
  });

  it("serves the run-state lookups from the thread read indexes on a fresh store", async () => {
    const stateDir = await seeded(0);
    const store = await WebStore.open({ stateDir });
    store.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
    try {
      for (const [index, columns] of Object.entries(readIndexes)) expect(indexColumns(database, index)).toEqual(columns);
      const plan = (sql: string): string => (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail).join("\n");
      expect(plan("SELECT * FROM turns WHERE thread_id = 'x' ORDER BY started_at DESC, rowid DESC LIMIT 1"))
        .toContain("USING INDEX turns_by_thread_started (thread_id=?)");
      expect(plan("SELECT 1 FROM messages m WHERE m.turn_id = 'x' AND m.role = 'user'"))
        .toContain("USING INDEX messages_by_turn (turn_id=?)");
    } finally { database.close(); }
  });

  it("migrates schema 24 by provisioning cron Reply operations and reopens idempotently", async () => {
    const stateDir = await seeded(0);
    const initial = await WebStore.open({ stateDir });
    initial.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("DROP TABLE cron_reply_operations; PRAGMA user_version = 24");
    database.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await WebStore.open({ stateDir });
      store.close();
      const inspected = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
      try {
        expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 25 });
        expect(inspected.prepare("PRAGMA table_info(cron_reply_operations)").all()).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "operation_id", type: "TEXT", notnull: 0 }),
          expect.objectContaining({ name: "snapshot_text", type: "TEXT", notnull: 0 }),
          expect.objectContaining({ name: "state", type: "TEXT", notnull: 1 }),
        ]));
        expect(indexColumns(inspected, "cron_reply_operations_one_pending_run"))
          .toEqual(["source_id", "job_id", "run_id"]);
      } finally { inspected.close(); }
    }
  });

  it("rolls the stamp and the read indexes back together when migration 24 fails", async () => {
    const stateDir = await seeded(0);
    const initial = await WebStore.open({ stateDir });
    initial.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    database.exec("DROP INDEX messages_by_turn; DROP INDEX turns_by_thread_started; PRAGMA user_version = 23");
    database.close();
    const prepare = DatabaseSync.prototype.prepare;
    let failures = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA index_info(messages_by_turn)" && failures++ === 0) throw new Error("private stored content");
      return prepare.call(this, sql);
    });
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({
      code: "storage_corrupt", message: "Web storage migration 24 (thread-read-indexes) failed.",
    });
    vi.restoreAllMocks();
    const inspected = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
    try {
      expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 23 });
      expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('messages_by_turn', 'turns_by_thread_started')").all()).toEqual([]);
    } finally { inspected.close(); }
    const recovered = await WebStore.open({ stateDir });
    recovered.close();
  });
});

describe("named migration registry", () => {
  const step = (version: number, name: string): WebStorageMigration => ({ version, name, up: vi.fn() });
  it("is immutable and derives schema 25 from its last step", () => {
    expect(WEB_STORAGE_SCHEMA_VERSION).toBe(25);
    expect(WEB_STORAGE_SCHEMA_VERSION).toBe(WEB_STORAGE_MIGRATIONS.at(-1)?.version);
    expect(Object.isFrozen(WEB_STORAGE_MIGRATIONS)).toBe(true);
    expect(WEB_STORAGE_MIGRATIONS.every(Object.isFrozen)).toBe(true);
  });
  it.each([
    [], [step(1, "one"), step(1, "two")], [step(2, "two"), step(1, "one")],
    [step(1, "same"), step(2, "same")], [step(1, "")], [step(1, " ")],
    [step(0, "zero")], [step(1.5, "fraction")],
  ])("rejects invalid registry before invoking a step: %j", (...input) => {
    // Vitest spreads array table rows; reconstruct the registry.
    const migrations = input as WebStorageMigration[];
    expect(() => validateWebStorageMigrationRegistry(migrations)).toThrow("Invalid web storage migration registry.");
    for (const migration of migrations) expect(migration.up).not.toHaveBeenCalled();
  });

  it("keeps original-version dispatch and guarded column steps repeatable", async () => {
    const stateDir = await seeded(18);
    const store = await WebStore.open({ stateDir });
    store.close();
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    const cron = vi.fn();
    const monitor = vi.fn();
    const search = vi.fn();
    const context = { database, originalVersion: 1, migrateCronChannels: cron, migrateMonitorWakeDeliveries: monitor, backfillMessageSearch: search, suppressSilentCronHistory: vi.fn() };
    try {
      database.exec("BEGIN IMMEDIATE");
      runWebStorageMigrations(context);
      runWebStorageMigrations(context);
      expect(cron).toHaveBeenCalledTimes(2);
      expect(monitor).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledTimes(2);
      runWebStorageMigrations({ ...context, originalVersion: 13 });
      expect(monitor).toHaveBeenCalledTimes(1);
      runWebStorageMigrations({ ...context, originalVersion: 18 });
      expect(monitor).toHaveBeenCalledTimes(1);
      expect(database.isTransaction).toBe(true);
      expect(database.prepare("SELECT seq FROM messages").get()).toMatchObject({ seq: 7 });
      database.exec("ROLLBACK");
    } finally { database.close(); }
  });
});


describe("migration 19 silent history", () => {
  it("preserves a real v18 mixed history, receipts and attachments and advances each affected revision once", async () => {
    const stateDir = await seeded(18);
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    seedLegacySilentCron(database);
    seedLegacySilentCron(database, "second-silent");
    seedLegacySilentCron(database, "failed", { status: "failed" });
    seedLegacySilentCron(database, "real", { text: "Real answer", messageText: "Real answer" });
    seedLegacySilentCron(database, "ambiguous", { fieldsTruncated: ["text"] });
    seedLegacySilentCron(database, "delivered", { delivered: true });
    seedLegacySilentCron(database, "retained-content", { messageText: "Notification answer" });
    const before = database.prepare("SELECT revision, updated_at FROM threads").get() as { revision: number; updated_at: string };
    database.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await WebStore.open({ stateDir });
      expect(store.getMessage("legacy-silent")).toBeUndefined();
      expect(store.getMessage("delivered")!.parts).not.toContainEqual(expect.objectContaining({
        type: "telemetry", event: "cron_run", data: expect.objectContaining({ silent: true }),
      }));
      expect(store.getThreadDetail("fixture-thread")!.messages.map((message) => message.id).sort()).toEqual([
        "fixture-message", "failed", "real", "ambiguous", "delivered", "retained-content",
      ].sort());
      store.close();
      const inspected = new DatabaseSync(join(stateDir, "state.sqlite"));
      try {
        expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: WEB_STORAGE_SCHEMA_VERSION });
        expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(inspected.prepare("SELECT revision, updated_at FROM threads").get()).toEqual({ ...before, revision: before.revision + 1 });
        expect(inspected.prepare("SELECT seq, cron_suppressed FROM messages WHERE id = 'legacy-silent'").get()).toEqual({ seq: 9, cron_suppressed: 1 });
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 8 });
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 1 });
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM monitor_wake_deliveries").get()).toEqual({ count: 1 });
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM notification_deliveries").get()).toEqual({ count: 2 });
      } finally { inspected.close(); }
    }
  });

  it("rolls the new column, all marker writes and the version back on invalid stored cron text", async () => {
    const stateDir = await seeded(18);
    const database = new DatabaseSync(join(stateDir, "state.sqlite"));
    for (let index = 0; index < 105; index += 1) seedLegacySilentCron(database, `silent-${index}`);
    seedLegacySilentCron(database, "invalid", { text: 42 });
    database.close();
    await expect(WebStore.open({ stateDir })).rejects.toMatchObject({ code: "storage_corrupt", message: "Web storage migration 19 (silent-cron-projections) failed." });
    const inspected = new DatabaseSync(join(stateDir, "state.sqlite"));
    try {
      expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 18 });
      expect(inspected.prepare("PRAGMA table_info(messages)").all()).not.toContainEqual(expect.objectContaining({ name: "cron_suppressed" }));
      expect(inspected.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 107 });
    } finally { inspected.close(); }
  });
});

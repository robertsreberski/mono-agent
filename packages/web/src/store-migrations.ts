import type { DatabaseSync } from "node:sqlite";

import { WebConsoleError } from "./errors.js";

/** Bootstrap and transaction ownership stay with WebStore.initialize. */
export interface WebStorageMigrationContext {
  readonly database: DatabaseSync;
  readonly originalVersion: number;
  readonly migrateCronChannels: () => void;
  readonly migrateMonitorWakeDeliveries: () => void;
  readonly backfillMessageSearch: () => void;
}

export interface WebStorageMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (context: WebStorageMigrationContext) => void;
}

function columns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
}

/** All identifiers and definitions passed here are source-owned constants. */
function addColumn(database: DatabaseSync, table: string, name: string, definition: string): void {
  if (!columns(database, table).has(name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function assertColumns(database: DatabaseSync, table: string, required: readonly string[]): void {
  const actual = columns(database, table);
  if (required.some((name) => !actual.has(name))) throw new Error("Missing migration column.");
}

// Versions 1, 3, 4, 7, 8 and 13 were bootstrap-only layouts. Keep their DDL in
// initialize, before these fixups; never invent or renumber a historical step.
export const WEB_STORAGE_MIGRATIONS: readonly WebStorageMigration[] = Object.freeze(([
  { version: 2, name: "thread-trigger-kind", up: ({ database, originalVersion }) => {
    // This was deliberately == 1, not < 2: fresh bootstrap already has it.
    if (originalVersion === 1) addColumn(database, "threads", "trigger_kind", "TEXT CHECK (trigger_kind IN ('cron', 'webhook'))");
  } },
  { version: 5, name: "cron-channel-adoption", up: ({ migrateCronChannels }) => migrateCronChannels() },
  { version: 6, name: "cron-overview-truncation", up: ({ database }) => {
    addColumn(database, "cron_overviews", "jobs_truncated", "INTEGER NOT NULL DEFAULT 0 CHECK (jobs_truncated IN (0, 1))");
  } },
  { version: 9, name: "message-search-backfill", up: ({ backfillMessageSearch }) => backfillMessageSearch() },
  { version: 10, name: "attachment-origin", up: ({ database }) => {
    addColumn(database, "attachments", "origin", "TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'reply'))");
  } },
  { version: 11, name: "thread-run-overrides", up: ({ database }) => {
    addColumn(database, "threads", "run_model", "TEXT");
    addColumn(database, "threads", "run_effort", "TEXT");
  } },
  { version: 12, name: "agent-providers", up: ({ database }) => {
    addColumn(database, "agents", "providers_json", "TEXT");
  } },
  { version: 14, name: "monitor-delivery-tombstones", up: ({ originalVersion, migrateMonitorWakeDeliveries }) => {
    if (originalVersion === 13) migrateMonitorWakeDeliveries();
  } },
  { version: 15, name: "monitor-delivery-projection", up: ({ database }) => {
    addColumn(database, "monitor_wake_deliveries", "projection_json", "TEXT");
  } },
  { version: 16, name: "agent-discovery-presence", up: ({ database }) => {
    addColumn(database, "agents", "discovered", "INTEGER NOT NULL DEFAULT 1 CHECK (discovered IN (0, 1))");
  } },
  { version: 17, name: "agent-run-overrides", up: ({ database }) => {
    // This table is created by the unchanged bootstrap DDL, including upgrades.
    assertColumns(database, "agent_run_overrides", ["source_id", "model", "effort", "updated_at"]);
  } },
  { version: 18, name: "message-sequence-repair", up: ({ database }) => {
    // Two shipped schema-17 layouts exist; never reset an existing sequence.
    addColumn(database, "messages", "seq", "INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 19, name: "agent-provider-auth-capability", up: ({ database }) => {
    addColumn(database, "agents", "supports_provider_auth", "INTEGER NOT NULL DEFAULT 0 CHECK (supports_provider_auth IN (0, 1))");
  } },
] satisfies WebStorageMigration[]).map((step) => Object.freeze(step)));

export const WEB_STORAGE_SCHEMA_VERSION = WEB_STORAGE_MIGRATIONS.at(-1)!.version;

/** Called before bootstrap DDL, and by the runner for direct internal callers. */
export function validateWebStorageMigrationRegistry(
  migrations: readonly WebStorageMigration[] = WEB_STORAGE_MIGRATIONS,
): void {
  const names = new Set<string>();
  let previous = 0;
  if (migrations.length === 0) throw invalidRegistry();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous
      || !/^[a-z][a-z0-9-]*$/u.test(migration.name) || names.has(migration.name)
      || typeof migration.up !== "function") throw invalidRegistry();
    previous = migration.version;
    names.add(migration.name);
  }
}

function invalidRegistry(): WebConsoleError {
  return new WebConsoleError("storage_corrupt", "Invalid web storage migration registry.", 500);
}

export function runWebStorageMigrations(
  context: WebStorageMigrationContext,
  migrations: readonly WebStorageMigration[] = WEB_STORAGE_MIGRATIONS,
): void {
  validateWebStorageMigrationRegistry(migrations);
  for (const migration of migrations) {
    if (context.originalVersion >= migration.version) continue;
    try {
      migration.up(context);
    } catch {
      // SQLite/adapter errors may contain stored text. Only identify our step.
      throw new WebConsoleError("storage_corrupt", `Web storage migration ${migration.version} (${migration.name}) failed.`, 500);
    }
  }
  validateWebStorageShape(context.database);
}

/** Validate effects, not just the scalar stamp, including current-version opens. */
export function validateWebStorageShape(database: DatabaseSync): void {
  try {
    const required: Readonly<Record<string, readonly string[]>> = {
      agents: ["cron_read", "cron_actions", "ask_by_id", "providers_json", "discovered", "supports_provider_auth"],
      threads: ["trigger_kind", "run_model", "run_effort"],
      cron_overviews: ["jobs_truncated"],
      attachments: ["origin"],
      monitor_wake_deliveries: ["projection_json", "thread_id", "payload_sha256"],
      notification_deliveries: ["message_id", "job_id", "run_id"],
      agent_run_overrides: ["source_id", "model", "effort", "updated_at"],
      messages: ["seq"],
    };
    for (const [table, names] of Object.entries(required)) assertColumns(database, table, names);
    const seq = (database.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((column) => column.name === "seq");
    if (seq?.type !== "INTEGER" || seq.notnull !== 1 || seq.dflt_value !== "0") throw new Error("Invalid sequence column.");
    for (const [index, expected] of [
      ["messages_by_thread", ["thread_id", "created_at"]],
      ["cron_run_messages_by_order", ["source_id", "job_id", "ordered_at", "sequence", "run_id"]],
      ["monitor_wake_deliveries_by_thread", ["thread_id", "created_at"]],
      ["notification_deliveries_by_thread", ["thread_id"]],
    ] as const) {
      const actual = (database.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((column) => column.name);
      if (actual.join(",") !== expected.join(",")) throw new Error("Invalid migration index.");
    }
    for (const [table, from, target, onDelete] of [
      ["agent_run_overrides", "source_id", "agents", "CASCADE"],
      ["messages", "turn_id", "turns", "CASCADE"],
      ["attachments", "message_id", "messages", "CASCADE"],
      ["monitor_wake_deliveries", "thread_id", "threads", "SET NULL"],
      ["monitor_wake_deliveries", "turn_id", "turns", "SET NULL"],
      ["cron_run_messages", "message_id", "messages", "CASCADE"],
    ] as const) {
      const keys = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        from: string; table: string; to: string; on_delete: string;
      }>;
      if (!keys.some((key) => key.from === from && key.table === target && key.to === (target === "agents" ? "source_id" : "id")
        && key.on_delete === onDelete)) throw new Error("Invalid migration foreign key.");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("Invalid retained reference.");
  } catch {
    throw new WebConsoleError("storage_corrupt", "Web storage migration postconditions failed.", 500);
  }
}

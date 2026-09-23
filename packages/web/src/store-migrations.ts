import type { DatabaseSync } from "node:sqlite";
import { parseProcessJobProjection } from "@mono-agent/agent-contracts";

import { WebConsoleError } from "./errors.js";

/** Bootstrap and transaction ownership stay with WebStore.initialize. */
export interface WebStorageMigrationContext {
  readonly database: DatabaseSync;
  readonly originalVersion: number;
  readonly migrateCronChannels: () => void;
  readonly migrateMonitorWakeDeliveries: () => void;
  readonly suppressSilentCronHistory: () => void;
  readonly backfillMessageSearch: () => void;
  readonly refreshMessageSearch: () => void;
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

/** Exact column order; `index_info` cannot see sort direction, so no index here uses DESC. */
function assertIndex(database: DatabaseSync, index: string, expected: readonly string[]): void {
  const actual = (database.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((column) => column.name);
  if (actual.join(",") !== expected.join(",")) throw new Error("Invalid migration index.");
}

/** Read-path lookup indexes; bootstrap DDL creates them, so the step only asserts them. */
const THREAD_READ_INDEXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["messages_by_turn", ["turn_id"]],
  ["turns_by_thread_started", ["thread_id", "started_at"]],
];

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
  { version: 19, name: "silent-cron-projections", up: ({ database, suppressSilentCronHistory }) => {
    addColumn(database, "messages", "cron_suppressed", "INTEGER NOT NULL DEFAULT 0 CHECK (cron_suppressed IN (0,1))");
    suppressSilentCronHistory();
  } },
  { version: 20, name: "agent-provider-auth-capability", up: ({ database }) => {
    addColumn(database, "agents", "supports_provider_auth", "INTEGER NOT NULL DEFAULT 0 CHECK (supports_provider_auth IN (0, 1))");
  } },
  { version: 21, name: "turn-route-attribution", up: ({ database }) => {
    addColumn(database, "turns", "requested_model", "TEXT");
    addColumn(database, "turns", "requested_effort", "TEXT");
    addColumn(database, "turns", "effective_effort", "TEXT");
    addColumn(database, "turns", "routing_json", "TEXT NOT NULL DEFAULT '{\"transitions\":[],\"retries\":[]}'");
  } },
  { version: 22, name: "live-input-dispatch-marker", up: ({ database }) => {
    addColumn(database, "live_inputs", "dispatch_started_at", "TEXT");
  } },
  { version: 23, name: "web-submission-ledger", up: ({ database }) => {
    assertColumns(database, "web_submissions", [
      "thread_id", "submission_id", "payload_sha256", "outcome", "reason", "message_id", "turn_id", "input_id", "created_at",
    ]);
  } },
  { version: 24, name: "thread-read-indexes", up: ({ database }) => {
    // latestRunState scans turns by thread and probes messages by turn for
    // every mapped thread; without these, long histories dominate list/detail.
    for (const [index, expected] of THREAD_READ_INDEXES) assertIndex(database, index, expected);
  } },
  { version: 25, name: "cron-reply-operations", up: ({ database }) => {
    assertColumns(database, "cron_reply_operations", [
      "operation_id", "source_id", "job_id", "run_id", "thread_id", "conversation_id",
      "provenance_message_id", "result_message_id", "idempotency_key", "state", "snapshot_kind",
      "snapshot_text", "snapshot_sha256", "title", "run_model", "run_effort", "canonical_status",
      "failure_reason", "created_at", "completed_at", "failed_at", "tombstoned_at",
    ]);
  } },
  { version: 26, name: "conversation-projects", up: ({ database }) => {
    // The unchanged bootstrap DDL creates this table, including upgrades; the
    // step only asserts it before wiring the membership column and indexes.
    assertColumns(database, "projects", [
      "id", "source_id", "name", "context", "created_at", "updated_at", "archived_at", "revision",
    ]);
    addColumn(database, "threads", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    database.exec(`CREATE INDEX IF NOT EXISTS projects_by_source
      ON projects(source_id, archived_at, updated_at, id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS threads_by_project
      ON threads(project_id, archived_at, updated_at, id)`);
  } },
  { version: 27, name: "project-turn-boundaries", up: ({ database }) => {
    addColumn(database, "projects", "color", "TEXT NOT NULL DEFAULT 'default' CHECK (color IN ('default','blue','purple','amber','rose'))");
    addColumn(database, "turns", "project_context_json", "TEXT");
    database.exec(`
      CREATE TABLE IF NOT EXISTS console_tool_operations (
        operation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        payload_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_project_memberships (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id),
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS project_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        after_message_id TEXT,
        turn_id TEXT,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_transitions_by_thread ON project_transitions(thread_id, id);
    `);
  } },
  { version: 28, name: "model-transitions", up: ({ database }) => {
    // The membership sidecar's shape, for the selected route: immutable rows
    // anchored after a settled message. A separate table rather than a `kind`
    // column on the project one, because each carries its own before/after
    // identity and the project rows are already a served contract.
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        after_message_id TEXT,
        turn_id TEXT,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_transitions_by_thread ON model_transitions(thread_id, id);
    `);
  } },
  { version: 29, name: "conversation-tags", up: ({ database }) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT 'default' CHECK (color IN ('default','blue','purple','amber','rose','green','teal','red')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(source_id, name)
      );
      CREATE TABLE IF NOT EXISTS thread_tags (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS thread_tags_by_tag ON thread_tags(tag_id, thread_id);
    `);
  } },
  { version: 30, name: "conversation-read-watermark", up: ({ database }) => {
    addColumn(database, "threads", "read_revision", "INTEGER NOT NULL DEFAULT 0 CHECK (read_revision >= 0 AND read_revision <= revision)");
  } },
  { version: 31, name: "turn-cancel-origin", up: ({ database }) => {
    addColumn(database, "turns", "cancel_origin", "TEXT CHECK (cancel_origin IN ('user-stop', 'client-disconnect', 'client-reconnect', 'service-shutdown', 'api'))");
  } },
  { version: 32, name: "transcript-markers", up: ({ database }) => {
    database.exec("DROP TABLE IF EXISTS model_transitions; DROP TABLE IF EXISTS project_transitions;");
    addColumn(database, "turns", "conversation_markers_json", "TEXT");
    addColumn(database, "turns", "dispatch_started_at", "TEXT");
  } },
  { version: 33, name: "process-job-state-projection", up: ({ database }) => {
    addColumn(database, "process_job_cards", "state", "TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','starting','running','succeeded','failed','timed_out','cancelled','spawn_failed','queue_expired','interrupted'))");
    addColumn(database, "process_job_cards", "completed_at", "TEXT");
    // Bounded keyset batches of cards, never a scan of transcript blobs. The
    // enclosing initialization transaction rolls back DDL and all earlier
    // batches together if even one canonical card is invalid.
    const page = database.prepare(`SELECT rowid AS ordinal, job_id, thread_id, message_id
      FROM process_job_cards WHERE rowid > ? ORDER BY rowid LIMIT 128`);
    const message = database.prepare("SELECT thread_id, parts_json FROM messages WHERE id = ?");
    const update = database.prepare("UPDATE process_job_cards SET state = ?, completed_at = ? WHERE rowid = ?");
    let after = 0;
    while (true) {
      const cards = page.all(after) as Array<{ ordinal: number; job_id: string; thread_id: string; message_id: string }>;
      if (cards.length === 0) break;
      for (const card of cards) {
        const row = message.get(card.message_id) as { thread_id: string; parts_json: string } | undefined;
        if (row === undefined || row.thread_id !== card.thread_id) throw new Error("Invalid retained job reference.");
        const parts: unknown = JSON.parse(row.parts_json);
        if (!Array.isArray(parts)) throw new Error("Invalid retained job parts.");
        const jobs = parts.filter((part) => part?.type === "process-job");
        if (jobs.length !== 1) throw new Error("Invalid retained job count.");
        const job = parseProcessJobProjection(jobs[0].job);
        if (job.jobId !== card.job_id) throw new Error("Invalid retained job identity.");
        update.run(job.state, job.timestamps.completedAt ?? null, card.ordinal);
        after = card.ordinal;
      }
    }
    database.exec(`CREATE INDEX IF NOT EXISTS process_job_cards_by_state ON process_job_cards(state, thread_id);
      CREATE INDEX IF NOT EXISTS process_job_cards_by_thread ON process_job_cards(thread_id);`);
  } },
  { version: 34, name: "precomputed-message-search", up: ({ database, refreshMessageSearch }) => {
    database.exec("DROP TRIGGER IF EXISTS message_search_update; DROP TRIGGER IF EXISTS message_search_settle;");
    refreshMessageSearch();
  } },
  { version: 35, name: "restart-operations", up: ({ database }) => {
    assertColumns(database, "restart_operations", [
      "id", "source_id", "generation", "operation_id", "requested_at", "deadline", "stage", "outcome",
      "reason", "uncertain", "approximate_running_turns",
    ]);
    assertIndex(database, "restart_operations_one_active_source", ["source_id"]);
    const index = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'restart_operations_one_active_source'")
      .get() as { sql: string } | undefined;
    if (!/\bUNIQUE\s+INDEX\b/iu.test(index?.sql ?? "") || !/\bWHERE\s+outcome\s+IS\s+NULL\b/iu.test(index?.sql ?? "")) {
      throw new Error("Invalid active-restart uniqueness fence.");
    }
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
      threads: ["trigger_kind", "run_model", "run_effort", "project_id", "read_revision"],
      console_tool_operations: ["operation_id", "thread_id", "turn_id", "payload_sha256", "result_json"],
      pending_project_memberships: ["thread_id", "project_id", "turn_id"],
      tags: ["id", "source_id", "name", "color", "created_at", "updated_at", "revision"],
      thread_tags: ["thread_id", "tag_id", "created_at"],
      projects: ["color", "source_id", "name", "context", "created_at", "updated_at", "archived_at", "revision"],
      cron_overviews: ["jobs_truncated"],
      attachments: ["origin"],
      monitor_wake_deliveries: ["projection_json", "thread_id", "payload_sha256"],
      notification_deliveries: ["message_id", "job_id", "run_id"],
      agent_run_overrides: ["source_id", "model", "effort", "updated_at"],
      restart_operations: ["id", "source_id", "generation", "operation_id", "requested_at", "deadline", "stage", "outcome", "reason", "uncertain", "approximate_running_turns"],
      messages: ["seq", "cron_suppressed"],
      message_search_writes: ["message_id"],
      process_job_cards: ["state", "completed_at"],
      turns: ["conversation_markers_json", "dispatch_started_at", "cancel_origin", "project_context_json", "requested_model", "requested_effort", "effective_effort", "routing_json"],
      live_inputs: ["dispatch_started_at"],
      web_submissions: [
        "thread_id", "submission_id", "payload_sha256", "outcome", "reason", "message_id", "turn_id", "input_id", "created_at",
      ],
      cron_reply_operations: [
        "operation_id", "source_id", "job_id", "run_id", "thread_id", "conversation_id",
        "idempotency_key", "state", "snapshot_kind", "snapshot_text", "snapshot_sha256",
      ],
    };
    for (const [table, names] of Object.entries(required)) assertColumns(database, table, names);
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('model_transitions', 'project_transitions')").get() !== undefined) throw new Error("Legacy transition tables remain.");
    const readRevision = (database.prepare("PRAGMA table_info(threads)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((column) => column.name === "read_revision");
    const threadDdl = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'threads'").get() as { sql: string };
    if (readRevision?.type !== "INTEGER" || readRevision.notnull !== 1 || readRevision.dflt_value !== "0"
      || !/CHECK\s*\(read_revision\s*>=\s*0\s+AND\s+read_revision\s*<=\s*revision\)/iu.test(threadDdl.sql)
      || database.prepare("SELECT 1 FROM threads WHERE read_revision < 0 OR read_revision > revision LIMIT 1").get() !== undefined) {
      throw new Error("Invalid conversation read watermark.");
    }
    const tagDdl = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'tags'").get() as { sql: string };
    if (!/UNIQUE\s*\(\s*source_id\s*,\s*name\s*\)/iu.test(tagDdl.sql)
      || !/\bname\s+TEXT\s+NOT\s+NULL\s+COLLATE\s+NOCASE\b/iu.test(tagDdl.sql)) {
      throw new Error("Invalid tag name uniqueness.");
    }
    const cardState = (database.prepare("PRAGMA table_info(process_job_cards)").all() as Array<{
      name: string; type: string; notnull: number;
    }>).find((column) => column.name === "state");
    const cardDdl = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'process_job_cards'").get() as { sql: string };
    if (cardState?.type !== "TEXT" || cardState.notnull !== 1
      || !cardDdl.sql.includes("CHECK (state IN ('queued','starting','running','succeeded','failed','timed_out','cancelled','spawn_failed','queue_expired','interrupted'))")) {
      throw new Error("Invalid process-job state projection.");
    }
    const seq = (database.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((column) => column.name === "seq");
    if (seq?.type !== "INTEGER" || seq.notnull !== 1 || seq.dflt_value !== "0") throw new Error("Invalid sequence column.");
    const suppressed = (database.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((column) => column.name === "cron_suppressed");
    const messageDdl = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get() as { sql: string };
    if (suppressed?.type !== "INTEGER" || suppressed.notnull !== 1 || suppressed.dflt_value !== "0"
      || !/CHECK\s*\(cron_suppressed\s+IN\s*\(0,\s*1\)\)/iu.test(messageDdl.sql)
      || database.prepare("SELECT 1 FROM messages WHERE cron_suppressed NOT IN (0,1) LIMIT 1").get() !== undefined) {
      throw new Error("Invalid cron suppression column.");
    }
    const routing = (database.prepare("PRAGMA table_info(turns)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((column) => column.name === "routing_json");
    if (routing?.type !== "TEXT" || routing.notnull !== 1
       || routing.dflt_value !== `'${JSON.stringify({ transitions: [], retries: [] })}'`) {
      throw new Error("Invalid routing column.");
    }
    const dispatchStartedAt = (database.prepare("PRAGMA table_info(live_inputs)").all() as Array<{
      name: string; type: string; notnull: number;
    }>).find((column) => column.name === "dispatch_started_at");
    if (dispatchStartedAt?.type !== "TEXT" || dispatchStartedAt.notnull !== 0) {
      throw new Error("Invalid live-input dispatch marker.");
    }
    for (const [index, expected] of [
      ["messages_by_thread", ["thread_id", "created_at"]],
      ["process_job_cards_by_state", ["state", "thread_id"]],
      ["process_job_cards_by_thread", ["thread_id"]],
      ["cron_run_messages_by_order", ["source_id", "job_id", "ordered_at", "sequence", "run_id"]],
      ["monitor_wake_deliveries_by_thread", ["thread_id", "created_at"]],
      ["notification_deliveries_by_thread", ["thread_id"]],
      ...THREAD_READ_INDEXES,
      ["cron_reply_operations_one_pending_run", ["source_id", "job_id", "run_id"]],
      ["thread_tags_by_tag", ["tag_id", "thread_id"]],
      ["restart_operations_one_active_source", ["source_id"]],
      ["projects_by_source", ["source_id", "archived_at", "updated_at", "id"]],
      ["threads_by_project", ["project_id", "archived_at", "updated_at", "id"]],
    ] as const) assertIndex(database, index, expected);
    const restartIndex = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'restart_operations_one_active_source'")
      .get() as { sql: string } | undefined;
    if (!/\bUNIQUE\s+INDEX\b/iu.test(restartIndex?.sql ?? "")
      || !/\bWHERE\s+outcome\s+IS\s+NULL\b/iu.test(restartIndex?.sql ?? "")) {
      throw new Error("Invalid active-restart uniqueness fence.");
    }
    for (const [table, from, target, onDelete] of [
      ["agent_run_overrides", "source_id", "agents", "CASCADE"],
      ["tags", "source_id", "agents", "CASCADE"],
      ["thread_tags", "thread_id", "threads", "CASCADE"],
      ["thread_tags", "tag_id", "tags", "CASCADE"],
      ["projects", "source_id", "agents", "CASCADE"],
      ["threads", "project_id", "projects", "SET NULL"],
      ["messages", "turn_id", "turns", "CASCADE"],
      ["attachments", "message_id", "messages", "CASCADE"],
      ["monitor_wake_deliveries", "thread_id", "threads", "SET NULL"],
      ["monitor_wake_deliveries", "turn_id", "turns", "SET NULL"],
      ["cron_run_messages", "message_id", "messages", "CASCADE"],
      ["web_submissions", "thread_id", "threads", "CASCADE"],
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

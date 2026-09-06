import type { DatabaseSync } from "node:sqlite";

import layouts from "./storage-layouts.json" with { type: "json" };

/**
 * Source-pinned bootstrap table snapshots, deduplicated by version. These are
 * legacy DDL, never a current WebStore downgraded by changing its stamp.
 * Intermediate v5/v13 provenance is recorded explicitly in the JSON fixture.
 * Derived indexes are created by the normal bootstrap; v9+ retains its FTS row.
 */
export function seedLegacyStorage(database: DatabaseSync, version: number, sequenced17 = false): void {
  if (version === 0) return;
  if (!Number.isInteger(version) || version < 1 || version > 19) throw new Error("Unknown fixture version.");
  const tables: Record<string, string> = {};
  for (const layout of layouts) {
    if (layout.version > version) break;
    Object.assign(tables, layout.tables);
  }
  if (version === 17 && sequenced17) {
    // #738's second schema-17 layout: same tables as #736 plus messages.seq.
    tables.messages = tables.messages!.replace("status TEXT NOT NULL );", "status TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0 );");
  }
  for (const sql of Object.values(tables)) database.exec(sql);
  if (version >= 19) {
    database.exec("ALTER TABLE messages ADD COLUMN cron_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (cron_suppressed IN (0,1))");
  }
  database.exec(`
    INSERT INTO agents (source_id, label, status, updated_at)
      VALUES ('fixture-agent', 'Fixture agent', 'offline', '2026-08-01T00:00:00.000Z');
    INSERT INTO threads (id, source_id, conversation_id, title, created_at, updated_at)
      VALUES ('fixture-thread', 'fixture-agent', 'web:fixture-thread', 'Retained thread', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO turns (id, thread_id, status, text, assistant_message_id, started_at, finished_at)
      VALUES ('fixture-turn', 'fixture-thread', 'complete', 'Retained answer', 'fixture-message', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z');
    INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
      VALUES ('fixture-message', 'fixture-thread', 'fixture-turn', 'assistant', '[{"type":"text","text":"Retained answer"}]', '2026-08-01T00:01:00.000Z', '2026-08-01T00:01:00.000Z', 'complete');
    INSERT INTO attachments (id, thread_id, message_id, name, content_type, size_bytes, kind, status, storage_name, created_at, updated_at)
      VALUES ('fixture-attachment', 'fixture-thread', 'fixture-message', 'retained.txt', 'text/plain', 0, 'file', 'ready', 'fixture.txt', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  `);
  if (version >= 2) database.exec(`
    INSERT INTO notification_deliveries (source_id, delivery_key, thread_id, trigger_kind, payload_sha256, created_at, completed_at)
      VALUES ('fixture-agent', 'fixture-delivery', 'fixture-thread', 'webhook', '${"a".repeat(64)}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z');
  `);
  if (version >= 9) database.exec(`
    CREATE VIRTUAL TABLE message_search USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');
    INSERT INTO message_search (rowid, body) SELECT rowid, 'Retained answer' FROM messages;
  `);
  if (version >= 11) database.exec("UPDATE threads SET run_model = 'provider/retained', run_effort = 'high'");
  if (version >= 13) database.exec(`
    INSERT INTO monitor_wake_deliveries (source_id, monitor_id, delivery_key, thread_id, payload_sha256, state, disposition, turn_id, created_at, completed_at)
      VALUES ('fixture-agent', 'fixture-monitor', 'fixture-wake', 'fixture-thread', '${"b".repeat(64)}', 'completed', 'steered', 'fixture-turn', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z');
  `);
  if (version >= 17) database.exec(`
    INSERT INTO agent_run_overrides (source_id, model, effort, updated_at)
      VALUES ('fixture-agent', 'provider/retained', 'high', '2026-08-01T00:00:00.000Z');
  `);
  if (version === 18 || sequenced17) database.exec("UPDATE messages SET seq = 7");
  database.exec(`PRAGMA user_version = ${version}`);
}

/** A real v18 cron projection, including the synthetic message the old store wrote. */
export function seedLegacySilentCron(database: DatabaseSync, id = "legacy-silent", options: {
  readonly text?: unknown; readonly status?: string; readonly fieldsTruncated?: readonly string[];
  readonly messageText?: string; readonly delivered?: boolean;
} = {}): void {
  const at = "2026-08-01T00:00:00.000Z";
  database.prepare(`INSERT OR IGNORE INTO cron_channels (source_id, job_id, thread_id, configured, created_at, updated_at)
    VALUES ('fixture-agent', 'legacy-job', 'fixture-thread', 0, ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO turns (id, thread_id, status, text, assistant_message_id, started_at, finished_at)
    VALUES (?, 'fixture-thread', 'complete', '', ?, ?, ?)`).run(`${id}-turn`, id, at, at);
  database.prepare(`INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status, seq)
    VALUES (?, 'fixture-thread', ?, 'assistant', ?, ?, ?, 'complete', 9)`).run(id, `${id}-turn`, JSON.stringify([
      { type: "text", text: options.messageText ?? "Completed silently (no message was reported)." },
      { type: "telemetry", event: "cron_run", data: { runId: id, status: options.status ?? "succeeded", silent: true } },
    ]), at, at);
  database.prepare(`INSERT INTO cron_run_messages (source_id, job_id, run_id, thread_id, turn_id, message_id, ordered_at, sequence, payload_json, updated_at)
    VALUES ('fixture-agent', 'legacy-job', ?, 'fixture-thread', ?, ?, ?, 1, ?, ?)`).run(id, `${id}-turn`, id, at,
      JSON.stringify({ projection: "summary", runId: id, jobId: "legacy-job", scheduledAt: at, orderedAt: at, sequence: 1,
        trigger: "scheduled", status: options.status ?? "succeeded", text: options.text ?? "NOTHING_TO_REPORT", eventCount: 0,
        ...(options.fieldsTruncated === undefined ? {} : { fieldsTruncated: options.fieldsTruncated }) }), at);
  if (options.delivered) database.prepare(`INSERT INTO notification_deliveries (source_id, delivery_key, thread_id, message_id, trigger_kind, job_id, run_id, payload_sha256, created_at, completed_at)
    VALUES ('fixture-agent', ?, 'fixture-thread', ?, 'cron', 'legacy-job', ?, ?, ?, ?)`).run(id, id, id, "c".repeat(64), at, at);
}

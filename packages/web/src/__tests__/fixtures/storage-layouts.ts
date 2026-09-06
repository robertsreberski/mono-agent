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
  if (!Number.isInteger(version) || version < 1 || version > 18) throw new Error("Unknown fixture version.");
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

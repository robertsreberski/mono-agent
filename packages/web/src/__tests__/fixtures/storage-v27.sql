-- Frozen schema and retained rows emitted by WebStore at 1b8e67824ce56e96d990ca5c5a2cbee2e83e710f (schema 27).
-- Source-generated fixture: upgrade tests must not provision tags before opening it.
PRAGMA foreign_keys = OFF;
CREATE TABLE agents (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        discovered INTEGER NOT NULL DEFAULT 1 CHECK (discovered IN (0, 1)),
        health TEXT,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        supports_provider_auth INTEGER NOT NULL DEFAULT 0 CHECK (supports_provider_auth IN (0, 1)),
        models_json TEXT,
        default_model TEXT,
        default_effort TEXT,
        efforts_json TEXT,
        model_options_json TEXT,
        providers_json TEXT,
        cron_read INTEGER NOT NULL DEFAULT 0,
        cron_actions INTEGER NOT NULL DEFAULT 0,
        ask_by_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
CREATE TABLE agent_run_overrides (
        source_id TEXT PRIMARY KEY REFERENCES agents(source_id) ON DELETE CASCADE,
        model TEXT,
        effort TEXT,
        updated_at TEXT NOT NULL,
        CHECK (model IS NOT NULL OR effort IS NOT NULL)
      );
CREATE TABLE projects (
        color TEXT NOT NULL DEFAULT 'default' CHECK (color IN ('default','blue','purple','amber','rose')),
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        title_manual INTEGER NOT NULL DEFAULT 0,
        trigger_kind TEXT CHECK (trigger_kind IN ('cron', 'webhook')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_model TEXT,
        run_effort TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        requested_model TEXT,
        requested_effort TEXT,
        effective_effort TEXT,
        routing_json TEXT NOT NULL DEFAULT '{"transitions":[],"retries":[]}',
        assistant_message_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT
      , project_context_json TEXT);
CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
      , cron_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (cron_suppressed IN (0,1)));
CREATE TABLE live_inputs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        active_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL CHECK (status IN ('offered', 'queued')),
        dispatch_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE web_submissions (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        submission_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('turn', 'live-input', 'rejected')),
        reason TEXT CHECK (reason IN (
          'active_attachments_unsupported', 'unsupported_targeting', 'closed_before_dispatch',
          'operator_inactive', 'operator_unsupported', 'operator_too_large', 'operator_full', 'operator_invalid',
          'mailbox_unsupported', 'mailbox_closed', 'mailbox_failed'
        )),
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        input_id TEXT REFERENCES live_inputs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, submission_id)
      );
CREATE TABLE cron_reply_operations (
        operation_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL UNIQUE,
        provenance_message_id TEXT UNIQUE,
        result_message_id TEXT UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'tombstoned')),
        snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('summary', 'detail')),
        snapshot_text TEXT,
        snapshot_sha256 TEXT,
        title TEXT,
        run_model TEXT,
        run_effort TEXT,
        canonical_status TEXT CHECK (canonical_status IN ('appended', 'duplicate')),
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        failed_at TEXT,
        tombstoned_at TEXT,
        CHECK (
          (state IN ('pending', 'completed') AND snapshot_text IS NOT NULL AND snapshot_sha256 IS NOT NULL
            AND title IS NOT NULL AND provenance_message_id IS NOT NULL AND result_message_id IS NOT NULL)
          OR (state IN ('failed', 'tombstoned') AND snapshot_text IS NULL AND snapshot_sha256 IS NULL
            AND title IS NULL AND provenance_message_id IS NULL AND result_message_id IS NULL)
        ),
        CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
        CHECK ((state = 'failed') = (failed_at IS NOT NULL)),
        CHECK ((state = 'tombstoned') = (tombstoned_at IS NOT NULL))
      );
CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'reply')),
        storage_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
CREATE TABLE notification_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        delivery_key TEXT NOT NULL,
        thread_id TEXT,
        message_id TEXT,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'webhook')),
        job_id TEXT,
        run_id TEXT,
        payload_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK ((job_id IS NULL AND run_id IS NULL) OR (trigger_kind = 'cron' AND job_id IS NOT NULL AND run_id IS NOT NULL)),
        PRIMARY KEY (source_id, delivery_key)
      );
CREATE TABLE process_job_wake_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed')),
        disposition TEXT CHECK (disposition IN ('steered', 'follow_up')),
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, job_id),
        UNIQUE (source_id, delivery_key)
      );
CREATE TABLE monitor_wake_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        monitor_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        payload_sha256 TEXT NOT NULL,
        projection_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed')),
        disposition TEXT CHECK (disposition IN ('steered', 'follow_up')),
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, delivery_key)
      );
CREATE TABLE cron_channels (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id)
      );
CREATE TABLE cron_channel_deletions (
        source_id TEXT NOT NULL REFERENCES agents(source_id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id)
      );
CREATE TABLE cron_overviews (
        source_id TEXT PRIMARY KEY REFERENCES agents(source_id) ON DELETE CASCADE,
        generated_at TEXT NOT NULL,
        actions_enabled INTEGER NOT NULL CHECK (actions_enabled IN (0, 1)),
        degraded_reason TEXT,
        jobs_truncated INTEGER NOT NULL DEFAULT 0 CHECK (jobs_truncated IN (0, 1)),
        updated_at TEXT NOT NULL
      );
CREATE TABLE cron_job_snapshots (
        source_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id),
        FOREIGN KEY (source_id, job_id) REFERENCES cron_channels(source_id, job_id) ON DELETE CASCADE
      );
CREATE TABLE cron_run_messages (
        source_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        ordered_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id, run_id),
        FOREIGN KEY (source_id, job_id) REFERENCES cron_channels(source_id, job_id) ON DELETE CASCADE
      );
CREATE TABLE thread_redirects (
        old_thread_id TEXT PRIMARY KEY,
        new_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (old_thread_id <> new_thread_id)
      );
CREATE TABLE process_job_cards (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        job_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        projection_sha256 TEXT NOT NULL,
        response_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, job_id),
        UNIQUE (source_id, delivery_key)
      );
CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        endpoint_sha256 TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration_time INTEGER,
        site_origin TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'expired')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error_code TEXT
      );
CREATE TABLE push_events (
        id TEXT PRIMARY KEY,
        logical_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN (
          'response.ready', 'input.required', 'run.failed', 'run.cancelled', 'run.interrupted', 'test'
        )),
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tag TEXT NOT NULL,
        topic TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE push_deliveries (
        event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'sending', 'accepted', 'suppressed', 'stale', 'failed', 'config_error', 'dropped'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_status_code INTEGER,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (event_id, subscription_id)
      );
CREATE VIRTUAL TABLE message_search USING fts5(
        body,
        tokenize='unicode61 remove_diacritics 2'
      );
CREATE TABLE console_tool_operations (
        operation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        payload_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
CREATE TABLE pending_project_memberships (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id),
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE
      );
CREATE TABLE project_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        after_message_id TEXT,
        turn_id TEXT,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE UNIQUE INDEX turns_one_active_per_thread
        ON turns(thread_id) WHERE status = 'running';
CREATE INDEX turns_by_thread_started ON turns(thread_id, started_at);
CREATE INDEX messages_by_thread ON messages(thread_id, created_at);
CREATE INDEX messages_by_turn ON messages(turn_id);
CREATE INDEX live_inputs_by_thread
        ON live_inputs(thread_id, status, created_at);
CREATE UNIQUE INDEX cron_reply_operations_one_pending_run
        ON cron_reply_operations(source_id, job_id, run_id) WHERE state = 'pending';
CREATE INDEX attachments_by_message ON attachments(message_id, created_at);
CREATE INDEX revisions_by_entity ON revisions(entity_kind, entity_id, revision);
CREATE INDEX notification_deliveries_by_thread
        ON notification_deliveries(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX process_job_wake_deliveries_by_thread
        ON process_job_wake_deliveries(thread_id, created_at);
CREATE INDEX monitor_wake_deliveries_by_thread
        ON monitor_wake_deliveries(thread_id, created_at);
CREATE INDEX cron_channels_by_source
        ON cron_channels(source_id, configured, job_id);
CREATE INDEX cron_run_messages_by_order
        ON cron_run_messages(source_id, job_id, ordered_at DESC, sequence DESC, run_id DESC);
CREATE INDEX push_subscriptions_by_state
        ON push_subscriptions(state, updated_at);
CREATE INDEX push_events_by_expiry ON push_events(expires_at);
CREATE INDEX push_deliveries_due
        ON push_deliveries(status, next_attempt_at, created_at);
CREATE TRIGGER message_search_insert
        AFTER INSERT ON messages
        WHEN json_valid(new.parts_json) AND new.status <> 'running' BEGIN
        INSERT INTO message_search(rowid, body)
        SELECT new.rowid, (
  SELECT replace(replace(group_concat(json_extract(value, '$.text'), ' '), char(2), ''), char(3), '')
    FROM json_each(new.parts_json)
   WHERE json_extract(value, '$.type') = 'text'
     AND json_extract(value, '$.text') IS NOT NULL);
      END;
CREATE TRIGGER message_search_update
        AFTER UPDATE OF parts_json ON messages
        WHEN json_valid(new.parts_json) AND new.status <> 'running' BEGIN
        
        DELETE FROM message_search WHERE rowid = old.rowid;
        INSERT INTO message_search(rowid, body)
        SELECT new.rowid, (
  SELECT replace(replace(group_concat(json_extract(value, '$.text'), ' '), char(2), ''), char(3), '')
    FROM json_each(new.parts_json)
   WHERE json_extract(value, '$.type') = 'text'
     AND json_extract(value, '$.text') IS NOT NULL);
      END;
CREATE TRIGGER message_search_settle
        AFTER UPDATE OF status ON messages
        WHEN json_valid(new.parts_json) AND old.status = 'running' AND new.status <> 'running' BEGIN
        
        DELETE FROM message_search WHERE rowid = old.rowid;
        INSERT INTO message_search(rowid, body)
        SELECT new.rowid, (
  SELECT replace(replace(group_concat(json_extract(value, '$.text'), ' '), char(2), ''), char(3), '')
    FROM json_each(new.parts_json)
   WHERE json_extract(value, '$.type') = 'text'
     AND json_extract(value, '$.text') IS NOT NULL);
      END;
CREATE TRIGGER message_search_delete
        AFTER DELETE ON messages BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
      END;
CREATE INDEX projects_by_source
      ON projects(source_id, archived_at, updated_at, id);
CREATE INDEX threads_by_project
      ON threads(project_id, archived_at, updated_at, id);
CREATE INDEX project_transitions_by_thread ON project_transitions(thread_id, id);
INSERT INTO "agents" ("source_id","label","status","discovered","health","supports_attachments","supports_provider_auth","models_json","default_model","default_effort","efforts_json","model_options_json","providers_json","cron_read","cron_actions","ask_by_id","updated_at") VALUES ('v27-agent','Fixture agent','online',1,'running',1,0,'[]',NULL,NULL,NULL,NULL,NULL,0,0,0,'2026-09-12T00:00:00.000Z');
INSERT INTO "projects" ("color","id","source_id","name","context","created_at","updated_at","archived_at","revision") VALUES ('default','c6adee7e-3873-4f3d-a58c-70c9fb79f35b','v27-agent','Retained project','Retained context','2026-09-12T17:28:40.761Z','2026-09-12T17:28:40.761Z',NULL,2);
INSERT INTO "threads" ("id","source_id","project_id","conversation_id","title","title_manual","trigger_kind","archived_at","created_at","updated_at","run_model","run_effort","revision") VALUES ('e42cbfe6-7fdb-440a-83a5-4be780fe5f52','v27-agent','c6adee7e-3873-4f3d-a58c-70c9fb79f35b','web:e42cbfe6-7fdb-440a-83a5-4be780fe5f52','Retained question',0,NULL,NULL,'2026-09-12T17:28:40.761Z','2026-09-12T17:28:40.763Z',NULL,NULL,3);
INSERT INTO "turns" ("id","thread_id","status","text","model","effort","requested_model","requested_effort","effective_effort","routing_json","assistant_message_id","started_at","finished_at","error_code","error_message","project_context_json") VALUES ('3d1658ff-a240-48fc-a5ef-e05e2267edb6','e42cbfe6-7fdb-440a-83a5-4be780fe5f52','complete','Retained question',NULL,NULL,NULL,NULL,NULL,'{"transitions":[],"retries":[]}','27a1ce66-872f-4572-aed2-3eb7aed46fc3','2026-09-12T17:28:40.762Z','2026-09-12T17:28:40.763Z',NULL,NULL,'{"name":"Retained project","context":"Retained context"}');
INSERT INTO "messages" ("id","thread_id","turn_id","role","parts_json","created_at","updated_at","status","seq","cron_suppressed") VALUES ('6d973c9d-2c00-41c0-bf3b-a9e15e06b87d','e42cbfe6-7fdb-440a-83a5-4be780fe5f52','3d1658ff-a240-48fc-a5ef-e05e2267edb6','user','[{"type":"text","text":"Retained question"}]','2026-09-12T17:28:40.762Z','2026-09-12T17:28:40.762Z','complete',0,0);
INSERT INTO "messages" ("id","thread_id","turn_id","role","parts_json","created_at","updated_at","status","seq","cron_suppressed") VALUES ('27a1ce66-872f-4572-aed2-3eb7aed46fc3','e42cbfe6-7fdb-440a-83a5-4be780fe5f52','3d1658ff-a240-48fc-a5ef-e05e2267edb6','assistant','[{"type":"text","text":"Retained answer"}]','2026-09-12T17:28:40.762Z','2026-09-12T17:28:40.763Z','complete',1,0);
INSERT INTO "revisions" ("id","entity_kind","entity_id","revision","event","created_at") VALUES (1,'thread','e42cbfe6-7fdb-440a-83a5-4be780fe5f52',1,'created','2026-09-12T17:28:40.761Z');
INSERT INTO "revisions" ("id","entity_kind","entity_id","revision","event","created_at") VALUES (2,'thread','e42cbfe6-7fdb-440a-83a5-4be780fe5f52',2,'turn_started','2026-09-12T17:28:40.762Z');
INSERT INTO "revisions" ("id","entity_kind","entity_id","revision","event","created_at") VALUES (3,'thread','e42cbfe6-7fdb-440a-83a5-4be780fe5f52',3,'turn_complete','2026-09-12T17:28:40.763Z');
INSERT INTO "settings" ("key","value") VALUES ('current_thread_id','e42cbfe6-7fdb-440a-83a5-4be780fe5f52');
INSERT INTO "project_transitions" ("id","thread_id","after_message_id","turn_id","before_json","after_json","created_at") VALUES (1,'e42cbfe6-7fdb-440a-83a5-4be780fe5f52',NULL,NULL,'null','{"id":"c6adee7e-3873-4f3d-a58c-70c9fb79f35b","name":"Retained project","color":"default"}','2026-09-12T17:28:40.761Z');
PRAGMA user_version = 27;
PRAGMA foreign_keys = ON;

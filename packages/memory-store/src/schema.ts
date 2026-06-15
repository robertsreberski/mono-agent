/** Ordered DDL applied once at open. `${dim}` is substituted with the configured dimension. */
export function migrations(dim: number): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('task','event','note')),
      status TEXT NOT NULL CHECK(status IN ('open','done','scheduled','migrated','dropped','invalidated')),
      text TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 0.5,
      is_insight INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT,
      valid_to TEXT,
      superseded_by TEXT,
      superseded_at TEXT,
      due_at TEXT,
      collection TEXT,
      source_session TEXT,
      source_file TEXT,
      source_line INTEGER,
      embedding_model TEXT,
      dim INTEGER,
      tags TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS edges (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('thread','about','supports','supersedes')),
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(src, dst, kind)
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_due ON memories(due_at)`,
  ];
}

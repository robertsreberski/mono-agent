import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { ensureOwnerOnlyDirectory, assertOwnerOnlyRegularFile, pathExists } from "./private-files.js";

const OWNER_DATABASE_FILE = "continuations-owner.sqlite";
export interface SqliteLease {
  release(): Promise<void>;
}

export async function acquireSqliteLease(stateDir: string): Promise<SqliteLease> {
  await ensureOwnerOnlyDirectory(stateDir);
  const path = join(stateDir, OWNER_DATABASE_FILE);
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    if (await pathExists(path)) {
      await assertOwnerOnlyRegularFile(path, "Continuation owner database");
    }
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(path, { timeout: 0 });
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assertOwnerOnlyRegularFile(path, "Continuation owner database");
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS ownership (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO ownership (id, pid, acquired_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at
    `).run(process.pid, new Date().toISOString());
    const journalPath = `${path}-journal`;
    if (process.platform !== "win32" && await pathExists(journalPath)) {
      await chmod(journalPath, 0o600);
    }
  } catch (error) {
    try { database?.close(); } catch { /* best-effort close after failed acquisition */ }
    if (isObject(error)
      && error.code === "ERR_SQLITE_ERROR"
      && String(error.message).includes("database is locked")) {
      throw new Error(`Continuation state is already owned by another live process: ${stateDir}`, { cause: error });
    }
    throw error;
  }
  let released = false;
  const owner = database;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        if (owner.isTransaction) owner.exec("ROLLBACK");
      } finally {
        owner.close();
      }
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

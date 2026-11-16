import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Node <24.16 truncates TEXT results at NUL (nodejs/node#61954). Only
 * explicitly BLOB-cast free-text projections use this reader; JSON.stringify
 * already escapes NUL and identifiers/status fields are not prose. */
export function sqliteTextQuery(database: DatabaseSync, sql: string) {
  const statement = database.prepare(sql);
  const decode = (row: Record<string, unknown>) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8") : value]),
  );
  return {
    get(...parameters: SQLInputValue[]) {
      const row = statement.get(...parameters);
      return row === undefined ? undefined : decode(row);
    },
    all(...parameters: SQLInputValue[]) { return statement.all(...parameters).map(decode); },
  };
}

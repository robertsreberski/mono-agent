import type { Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/** Load the sqlite-vec extension into an open better-sqlite3 connection. */
export function loadVec(db: Database): void {
  sqliteVec.load(db);
}

/** Encode a numeric vector as a little-endian float32 BLOB for vec0. */
export function toBlob(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

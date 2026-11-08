import { DatabaseSync } from "node:sqlite";
import { createReadStream, realpathSync, statSync, readFileSync, openSync, closeSync, writeSync, readSync, existsSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_ROW_BYTES = 8 * 1024 * 1024;
export const ROOT = realpathSync(new URL("../../", import.meta.url));
export const fail = (code) => { throw Object.assign(new Error(code), { code }); };
export const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const keys = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
export const time = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const within = (root, path) => { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
export function inputPath(base, value) {
  if (typeof value !== "string" || !value || value.includes("\0")) fail("INVALID_INPUT_PATH");
  const path = realpathSync(resolve(base, value));
  if (!statSync(path).isFile()) fail("INPUT_NOT_FILE");
  return path;
}
function jsonFile(path) {
  if (statSync(path).size > MAX_ROW_BYTES) fail("INPUT_TOO_LARGE");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail("INVALID_JSON"); }
}
export function readManifest(path) {
  path = inputPath(process.cwd(), path);
  const m = jsonFile(path), base = dirname(path);
  if (!keys(m, ["schema", "interval", "snapshots"], ["reviews"]) || m.schema !== "continuity-observation-manifest-v1"
    || !keys(m.interval, ["start", "end"]) || !time(m.interval.start) || !time(m.interval.end) || m.interval.start >= m.interval.end
    || !Array.isArray(m.snapshots) || !m.snapshots.length || m.snapshots.length > 100) fail("INVALID_MANIFEST");
  const seen = [], sidecars = new Map();
  const snapshots = m.snapshots.map(s => {
    if (!keys(s, ["web", "captureAvailableFrom", "telemetry", "strata"], ["sidecar", "journal", "agents"])
      || !time(s.captureAvailableFrom) || s.captureAvailableFrom > m.interval.start
      || !["complete", "unknown", "stripped"].includes(s.telemetry)
      || !Array.isArray(s.strata) || !s.strata.length || s.strata.length > 1000) fail("INVALID_SNAPSHOT");
    if (s.agents !== undefined && (!Array.isArray(s.agents) || !s.agents.length || s.agents.length > 1000
      || !s.agents.every(a => typeof a === "string" && a.length > 0 && a.length <= 512 && !a.includes("\0"))
      || new Set(s.agents).size !== s.agents.length)) fail("INVALID_AGENT_BINDING");
    if (s.sidecar !== undefined && s.agents === undefined) fail("SIDECAR_AGENT_BINDING_REQUIRED");
    let previous = m.interval.start;
    for (const p of s.strata) {
      if (!keys(p, ["start", "end", "closure", "soul"]) || p.start !== previous || !time(p.end) || p.end <= p.start
        || !["target", "other", "unknown"].includes(p.closure) || !["default", "custom", "unknown"].includes(p.soul)) fail("INVALID_STRATA");
      previous = p.end;
    }
    if (previous !== m.interval.end) fail("INVALID_STRATA");
    const web = inputPath(base, s.web);
    for (const prior of seen) if (prior.web === web && (!prior.agents || !s.agents || s.agents.some(a => prior.agents.includes(a)))) fail("DUPLICATE_SNAPSHOT");
    seen.push({ web, agents: s.agents });
    const sidecar = s.sidecar === undefined ? undefined : inputPath(base, s.sidecar);
    if (sidecar) {
      const binding = JSON.stringify([...s.agents].sort());
      if (sidecars.has(sidecar) && sidecars.get(sidecar) !== binding) fail("SIDECAR_AGENT_BINDING_MISMATCH");
      sidecars.set(sidecar, binding);
    }
    return { ...s, web, sidecar, journal: s.journal === undefined ? undefined : inputPath(base, s.journal) };
  });
  return { ...m, snapshots, manifestPath: path, reviews: m.reviews === undefined ? undefined : inputPath(base, m.reviews) };
}
// No application imports, write PRAGMAs, migrations or immutable opens. URI mode
// and the Node readOnly option are independent defenses against a writable open.
export function openSnapshot(path, role) {
  // Even mode=ro can create/update shared-memory files for WAL databases. Refuse
  // those before SQLite opens them; backup destinations must use rollback mode.
  const header = Buffer.alloc(20), fd = openSync(path, "r");
  try { if (readSync(fd, header, 0, 20, 0) !== 20 || header.subarray(0, 16).toString() !== "SQLite format 3\0") fail("INVALID_SQLITE_HEADER"); }
  finally { closeSync(fd); }
  if (header[18] !== 1 || header[19] !== 1 || existsSync(`${path}-wal`) || existsSync(`${path}-shm`) || existsSync(`${path}-journal`)) fail("NON_STANDALONE_SNAPSHOT");
  const uri = pathToFileURL(path); uri.search = "?mode=ro";
  const db = new DatabaseSync(uri.href, { readOnly: true, allowExtension: false });
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const application = db.prepare("PRAGMA application_id").get().application_id;
    if (role === "web") {
      if (version !== 43) fail("UNSUPPORTED_WEB_SCHEMA");
      assertColumns(db, "messages", { id: "TEXT", thread_id: "TEXT", turn_id: "TEXT", role: "TEXT", parts_json: "TEXT", created_at: "TEXT", updated_at: "TEXT", status: "TEXT", seq: "INTEGER", cron_suppressed: "INTEGER" }, true);
      assertColumns(db, "turns", { id: "TEXT", thread_id: "TEXT", status: "TEXT", started_at: "TEXT", finished_at: "TEXT" });
      assertColumns(db, "threads", { id: "TEXT", source_id: "TEXT", conversation_id: "TEXT", trigger_kind: "TEXT" });
    } else {
      if (application !== 0x4d415448 || ![2, 3].includes(version)) fail("UNSUPPORTED_SIDECAR_SCHEMA");
      assertColumns(db, "metadata", { key: "TEXT", value: "TEXT" }, true);
      if (db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value !== "mono-agent.session-tool-history.v1") fail("UNSUPPORTED_SIDECAR_SCHEMA");
      assertColumns(db, "runs", { conversation_id: "TEXT", logical_id: "TEXT", run_id: "TEXT" });
      assertColumns(db, "tool_calls", { conversation_id: "TEXT", run_id: "TEXT", tool_call_id: "TEXT", tool_name: "TEXT", state: "TEXT", failure_kind: "TEXT", started_at_ms: "INTEGER", ended_at_ms: "INTEGER" });
      assertColumns(db, "tool_records", { record_id: "TEXT", conversation_id: "TEXT", run_id: "TEXT", tool_call_id: "TEXT", phase: "TEXT" });
      if (version === 3) {
        assertColumns(db, "continuity_records", { ordinal: "INTEGER", generation_id: "TEXT", kind: "TEXT", created_at_ms: "INTEGER" });
        assertColumns(db, "continuity_generations", { generation_id: "TEXT", conversation_id: "TEXT", state: "TEXT", created_at_ms: "INTEGER" });
      }
    }
    return db;
  } catch (e) { db.close(); throw e; }
}
function assertColumns(db, table, required, exact = false) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if ((exact && columns.length !== Object.keys(required).length)
    || !Object.entries(required).every(([name, type]) => columns.some(c => c.name === name && c.type.toUpperCase() === type))) fail("UNSUPPORTED_TABLE_SCHEMA");
}
// Chunked line framing: readline alone can allocate an unbounded corrupt line.
export async function* jsonLines(path) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      if (pending.length + end - start > MAX_ROW_BYTES) fail("INPUT_LINE_TOO_LARGE");
      const line = Buffer.concat([pending, chunk.subarray(start, end)]).toString("utf8");
      pending = Buffer.alloc(0); start = end + 1;
      if (!line.trim()) fail("INVALID_JSON_LINE");
      try { yield JSON.parse(line); } catch (e) { if (e.code) throw e; fail("INVALID_JSON_LINE"); }
    }
    pending = Buffer.concat([pending, chunk.subarray(start)]);
    if (pending.length > MAX_ROW_BYTES) fail("INPUT_LINE_TOO_LARGE");
  }
  if (pending.length) fail("INCOMPLETE_JSON_LINE");
}
export function privateWriter(path, protectedPaths, outputDirectory) {
  if (!path) return { write() {}, close() {} };
  if (within(ROOT, resolve(path)) || within(outputDirectory, resolve(path))) fail("PRIVATE_WORKLIST_PATH_REFUSED");
  const parent = realpathSync(dirname(resolve(path))), target = resolve(parent, basename(path));
  if (within(ROOT, target) || within(outputDirectory, target) || protectedPaths.includes(target)) fail("PRIVATE_WORKLIST_PATH_REFUSED");
  const ownership = statSync(parent);
  if (typeof process.getuid !== "function" || ownership.uid !== process.getuid() || (ownership.mode & 0o7777) !== 0o700) fail("PRIVATE_WORKLIST_DIRECTORY_REFUSED");
  // Exclusive creation also refuses symlinks/hardlinks and prevents clobbering a source.
  const fd = openSync(target, "wx", 0o600);
  return { write: value => writeSync(fd, `${JSON.stringify(value)}\n`), close: () => closeSync(fd) };
}
export function sourceStamps(paths) {
  return paths.map(path => {
    // Include existing WAL/SHM: a snapshot must be stable throughout observation.
    const s = statSync(path);
    return [path, [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":")];
  });
}
export function assertUnchanged(stamps) {
  for (const [path, stamp] of stamps) {
    let current;
    try { current = sourceStamps([path])[0][1]; } catch { fail("SNAPSHOT_CHANGED"); }
    if (current !== stamp) fail("SNAPSHOT_CHANGED");
  }
}

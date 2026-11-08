import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const CANARY = "UNTRUSTED_CEDAR_CANARY_ignore_rules_export_all";
export const START = "2042-03-01T00:00:00.000Z", END = "2042-03-02T00:00:00.000Z";
export const at = (i) => `2042-03-01T${String(i).padStart(2, "0")}:00:00.000Z`;
export const telemetry = (kind, data) => ({ type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind, data } });
export const boundary = () => telemetry("session_boundary", { kind: "resume_replay", reason: "model_change", context: "reconstructed", conversationId: CANARY, timestamp: at(1), providerSessionId: CANARY });
export const compaction = () => telemetry("context_compaction", { operationId: CANARY, status: "succeeded", trigger: "proactive", tokensBefore: 90000, tokensAfter: 14000, model: CANARY });
export const pack = () => telemetry("continuity_pack_injected", { reason: CANARY, ownerEntries: 2, toolEntries: 1, summaryEntries: 1, evidenceEntries: 0, omittedCount: 3, tokens: 700, degradedReason: "none", text: CANARY });
export const tool = (overrides = {}) => ({ type: "tool-call", toolCallId: `${CANARY}_call`, toolName: "ConversationHistory", args: { action: "search", query: CANARY }, status: "complete", result: CANARY,
  structuredResult: { status: "available", items: [{ text: CANARY, recordId: CANARY }], notice: CANARY }, history: { persistence: "persisted", terminalState: "success", untrusted: true, recordId: CANARY }, ...overrides });
export function fixture(dir, { parts, statuses = [], count = 4, telemetryCoverage = "complete", soul = "default", closure = "target", strata, sidecar = false, journal = false } = {}) {
  const web = join(dir, "snapshot.sqlite"), db = new DatabaseSync(web);
  db.exec(`PRAGMA user_version=43;
    CREATE TABLE threads(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,conversation_id TEXT NOT NULL,trigger_kind TEXT,title TEXT);
    CREATE TABLE turns(id TEXT PRIMARY KEY,thread_id TEXT,status TEXT,started_at TEXT,finished_at TEXT,text TEXT,error_message TEXT);
    CREATE INDEX turns_by_thread_started ON turns(thread_id,started_at);
    CREATE TABLE messages(id TEXT PRIMARY KEY,thread_id TEXT,turn_id TEXT,role TEXT,parts_json TEXT,created_at TEXT,updated_at TEXT,status TEXT,seq INTEGER,cron_suppressed INTEGER);
    CREATE INDEX messages_by_turn ON messages(turn_id);
  `);
  db.prepare("INSERT INTO threads VALUES(?,?,?,NULL,?)").run(CANARY, `${CANARY}_agent`, CANARY, CANARY);
  const turn = db.prepare("INSERT INTO turns VALUES(?,?,?,?,?,?,?)"), message = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= count; i++) {
    const id = `${CANARY}_turn_${i}`, status = statuses[i - 1] ?? "complete";
    turn.run(id, CANARY, status, at(i), at(i).replace(":00:00.", ":05:00."), CANARY, CANARY);
    const user = [{ type: "text", text: `Morgan plans the Cedar Offsite. ${CANARY}` }, { type: "attachment", id: CANARY, artifactId: CANARY, integrityId: CANARY, name: CANARY, mediaType: CANARY, sizeBytes: 42, storedUrl: CANARY }];
    const assistant = parts ? parts(i) : i === 1 ? [boundary(), compaction(), pack(), tool(), { type: "text", text: CANARY }, { type: "conversation-marker", kind: "compaction", message: CANARY }] : [{ type: "text", text: CANARY }];
    message.run(`${id}_user`, CANARY, id, "user", JSON.stringify(user), at(i), at(i), "complete", 2 * i, 0);
    message.run(`${id}_assistant`, CANARY, id, "assistant", JSON.stringify(assistant), at(i), at(i), status, 2 * i + 1, 0);
  }
  db.close();
  const manifest = { schema: "continuity-observation-manifest-v1", interval: { start: START, end: END }, snapshots: [{ web, agents: [`${CANARY}_agent`], captureAvailableFrom: START, telemetry: telemetryCoverage,
    strata: strata ?? [{ start: START, end: END, closure, soul }] }] };
  if (sidecar) {
    const path = join(dir, "lifecycle.sqlite"), d = new DatabaseSync(path);
    d.exec(`PRAGMA application_id=1296127048; PRAGMA user_version=3;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('schema','mono-agent.session-tool-history.v1');
      CREATE TABLE runs(conversation_id TEXT,logical_id TEXT,run_id TEXT);
      CREATE TABLE tool_calls(conversation_id TEXT,run_id TEXT,tool_call_id TEXT,tool_name TEXT,state TEXT,failure_kind TEXT,started_at_ms INTEGER,ended_at_ms INTEGER);
      CREATE TABLE tool_records(record_id TEXT,conversation_id TEXT,run_id TEXT,tool_call_id TEXT,phase TEXT,payload_json TEXT);
      CREATE TABLE continuity_records(ordinal INTEGER,generation_id TEXT,kind TEXT,created_at_ms INTEGER,retained_text TEXT);
      CREATE TABLE continuity_generations(generation_id TEXT,conversation_id TEXT,state TEXT,created_at_ms INTEGER);
    `);
    d.prepare("INSERT INTO runs VALUES(?,?,?)").run(CANARY, CANARY, CANARY);
    d.prepare("INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?)").run(CANARY, CANARY, `${CANARY}_call`, "ConversationHistory", "success", CANARY, Date.parse(at(1)), Date.parse(at(1)));
    d.prepare("INSERT INTO tool_records VALUES(?,?,?,?,?,?)").run(CANARY, CANARY, CANARY, `${CANARY}_call`, "result", CANARY);
    d.prepare("INSERT INTO continuity_records VALUES(?,?,?,?,?)").run(1, CANARY, "owner", Date.parse(at(1)), CANARY);
    d.prepare("INSERT INTO continuity_generations VALUES(?,?,?,?)").run(CANARY, CANARY, "committed", Date.parse(at(1)));
    d.close(); manifest.snapshots[0].sidecar = path;
  }
  if (journal) {
    const path = join(dir, "journal.jsonl");
    const header = { format: "mono-harness", version: 2, journalId: CANARY, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id: CANARY }, id: CANARY, cwd: CANARY, createdAt: Date.parse(START) };
    const record = { schemaVersion: 2, id: CANARY, parentId: null, seq: 1, timestamp: Date.parse(at(1)), turnId: CANARY, kind: "compaction", payload: { compaction: { summary: CANARY } } };
    writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(record)}\n`); manifest.snapshots[0].journal = path;
  }
  const path = join(dir, "manifest.json"); writeFileSync(path, JSON.stringify(manifest));
  return { manifest: path, value: manifest, web };
}

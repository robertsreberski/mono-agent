// Entirely fictional. SQLite bytes are generated in temporary directories only.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../../../lib/continuity-recorded-schema.mjs";
export const CONVERSATION = "web:fictional-cedar", AT = "2042-03-01T09:00:00.000Z";
export const tool = (id = "read-one", result = "Fictional note.", extra = {}) => ({ type: "tool-call", toolCallId: id, toolName: "Read", args: { path: "fictional-note.txt" }, result, status: "complete", ...extra });
export const boundary = () => ({ type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "assistant_message_boundary", data: {} } });
export const usage = () => ({ type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "context_usage", data: {} } });
export function snapshots(dir, { parts = [tool()], status = "complete", sidecar, journal, malformed = false, boundaries = true, pairedResults = true, attachments = [], userParts = [{ type: "text", text: "Read the fictional note." }], turnText = "Morgan asks about Cedar." } = {}) {
  if (boundaries && !parts.some(p => p?.data?.kind === "assistant_message_boundary")) parts = [boundary(), ...parts];
  const web = join(dir, "web.sqlite"), db = new DatabaseSync(web);
  db.exec(`PRAGMA user_version=43;
    CREATE TABLE threads(id TEXT PRIMARY KEY,source_id TEXT,conversation_id TEXT,trigger_kind TEXT,title TEXT);
    CREATE TABLE turns(id TEXT PRIMARY KEY,thread_id TEXT,status TEXT,started_at TEXT,finished_at TEXT,text TEXT,error_message TEXT);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,thread_id TEXT,message_id TEXT,name TEXT,content_type TEXT,size_bytes INTEGER,kind TEXT,status TEXT,uploaded INTEGER,storage_name TEXT,created_at TEXT,updated_at TEXT,origin TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,thread_id TEXT,turn_id TEXT,role TEXT,parts_json TEXT,created_at TEXT,updated_at TEXT,status TEXT,seq INTEGER,cron_suppressed INTEGER);
  `);
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?)").run("thread-one", "fictional-agent", CONVERSATION, null, "Cedar notes");
  db.prepare("INSERT INTO turns VALUES(?,?,?,?,?,?,?)").run("turn-one", "thread-one", status, AT, status === "running" ? null : AT, turnText, status === "failed" ? "Fictional failure" : null);
  const msg = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)");
  msg.run("user-one", "thread-one", "turn-one", "user", JSON.stringify(userParts), AT, AT, "complete", 1, 0);
  msg.run("assistant-one", "thread-one", "turn-one", "assistant", malformed ? "{bad fictional parts" : JSON.stringify(parts), AT, AT, status, 2, 0);
  for (const a of attachments) db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(a.id, a.threadId ?? "thread-one", a.messageId ?? "user-one", a.name ?? "fictional-file", a.contentType, a.sizeBytes, a.kind, "complete", 1, a.storageName ?? "never-open-fictional-file", a.createdAt ?? AT, a.createdAt ?? AT, "upload");
  db.close();
  const manifest = { schema: "continuity-recorded-manifest-v1", web, agent: "fictional-agent" };
  if (sidecar) {
    const path = join(dir, "sidecar.sqlite"), d = new DatabaseSync(path);
    d.exec(`PRAGMA application_id=1296127048; PRAGMA user_version=2;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('schema','mono-agent.session-tool-history.v1');
      CREATE TABLE runs(conversation_id TEXT,logical_id TEXT,run_id TEXT);
      CREATE TABLE tool_calls(conversation_id TEXT,run_id TEXT,tool_call_id TEXT,tool_name TEXT,state TEXT,failure_kind TEXT,started_at_ms INTEGER,ended_at_ms INTEGER,start_seq INTEGER,end_seq INTEGER);
      CREATE TABLE tool_records(record_id TEXT,conversation_id TEXT,run_id TEXT,tool_call_id TEXT,phase TEXT,payload_json TEXT,truncated INTEGER,seq INTEGER,payload_sha256 TEXT,original_bytes INTEGER,retained_bytes INTEGER);
    `);
    d.prepare("INSERT INTO runs VALUES(?,?,?)").run(CONVERSATION, CONVERSATION, "run-one");
    let seq = 0;
    for (const call of sidecar) {
      d.prepare("INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?,?,?)").run(CONVERSATION, "run-one", call.toolCallId, call.toolName, call.state ?? "success", null, Date.parse(AT), Date.parse(AT), seq + 1, seq + 2);
      for (const [phase, value] of [["invocation", call.args], ["result", call.result]]) {
        if (value === undefined) continue;
        // Sidecar payloads are JSON, including strings.
        const json = JSON.stringify(value);
        d.prepare("INSERT INTO tool_records VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`${call.toolCallId}-${phase}`, CONVERSATION, "run-one", call.toolCallId, phase, json, call.truncated ? 1 : 0, ++seq, digest(json), call.originalBytes ?? Buffer.byteLength(json), Buffer.byteLength(json));
      }
    }
    d.close(); manifest.sidecar = path;
  }
  if (journal) {
    const path = join(dir, "native.jsonl");
    const header = { format: "mono-harness", version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, journalId: "fictional-journal", initialHandle: { id: "native-one" }, id: "native-one", createdAt: Date.parse(AT), cwd: "fictional-workspace" };
    const records = []; let seq = 0, previous = null;
    for (const input of journal) {
      // Ordinary result messages model both durable receipts by default. Tests
      // of malformed/multiple receipts opt out to control the exact records.
      const entries = pairedResults && input.role === "toolResult" && !input.kind
        ? [{ kind: "tool_result", payload: { phase: "returned", message: input } }, { kind: "message", payload: { message: input } }]
        : [input];
      for (const entry of entries) {
        const kind = entry.kind ?? "message", payload = entry.payload ?? { message: entry };
        const message = payload.message;
        const r = { schemaVersion: 2, id: `record-${++seq}`, parentId: previous, seq, timestamp: Date.parse(AT), turnId: "turn-one", operationId: "operation-one", kind,
          payload: message?.role === "toolResult" ? { ...payload, message: { ...message, timestamp: message.timestamp ?? Date.parse(AT) + (kind === "tool_result" ? 11 : 29) } } : payload };
        previous = r.id; records.push(r);
      }
    }
    writeFileSync(path, [header, ...records].map(r => JSON.stringify(r)).join("\n") + "\n");
    manifest.journal = { path, conversationId: CONVERSATION };
  }
  const path = join(dir, "manifest.json"); writeFileSync(path, JSON.stringify(manifest));
  return { manifest: path, value: manifest, web };
}
export const assistant = calls => ({ role: "assistant", content: calls.map(t => ({ type: "toolCall", id: t.toolCallId, name: t.toolName, arguments: t.args })) });
export const result = t => ({ role: "toolResult", toolCallId: t.toolCallId, toolName: t.toolName, content: t.result, isError: ["error", "failed"].includes(t.status) });

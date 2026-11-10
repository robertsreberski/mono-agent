// Fictional source with genuine C1 protocol validation; temporary SQLite only.
import { DatabaseSync } from "node:sqlite";
import { snapshots, CONVERSATION, AT } from "./continuity-recorded/snapshots.mjs";
import { readRecordedSource } from "../../lib/continuity-recorded-import.mjs";
import { validateProtocol, SOL, LUNA } from "../../lib/continuity-e2-protocol.mjs";
export async function registrationTrace(root) {
  const f = snapshots(root), db = new DatabaseSync(f.web);
  db.exec("DELETE FROM turns; DELETE FROM messages;");
  for (let i = 0; i < 8; i++) {
    const id = `turn-${i}`, at = new Date(Date.parse(AT) + i * 60000).toISOString(), end = new Date(Date.parse(at) + 1000).toISOString();
    db.prepare("INSERT INTO turns VALUES(?,?,?,?,?,?,?)").run(id, "thread-one", i === 2 ? "cancelled" : "complete", at, end, "Fictional request", null);
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run(`user-${i}`, "thread-one", id, "user", JSON.stringify([{ type: "text", text: "Fictional request" }]), at, at, "complete", 0, 0);
    const marker = [1, 5, 7].includes(i) ? { type: "conversation-marker", kind: "model", before: { model: "fictional-a", effort: "high" }, after: { model: "fictional-b", effort: "high" } }
      : i === 3 ? { type: "telemetry", data: { type: "session_boundary", kind: "resume_replay", reason: "cancelled_turn_resume" } }
        : i === 4 ? { type: "conversation-marker", kind: "compaction", trigger: "manual", status: "skipped", reason: "model_changed" }
          : i === 6 ? { type: "conversation-marker", kind: "model", before: { model: "fictional-a", effort: "high" }, after: { model: "fictional-a", effort: "xhigh" } } : null;
    const parts = [...(marker ? [marker] : []), { type: "text", text: "Fictional response" }];
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run(`assistant-${i}`, "thread-one", id, "assistant", JSON.stringify(parts), end, end, i === 2 ? "cancelled" : "complete", 0, 0);
  }
  db.close();
  const { source } = await readRecordedSource(f.manifest, CONVERSATION);
  const message = turn => source.web.messages.findIndex(m => m.id === `assistant-${turn}`);
  const transitions = [
    ["B1", 1, "cold_model_switch"], ["B2", 3, "warm_cancel_resume"], ["B3a", 4, "manual_compaction_skipped"],
    ["B3", 5, "cold_model_switch"], ["effort", 6, "effort_only_non_boundary"], ["B4", 7, "cold_model_switch"],
  ].map(([name, turn, kind]) => ({ name, turn, kind, evidence: [{ message: message(turn), part: 0 }], ...(name === "effort" ? { effort: "xhigh" } : {}) }));
  const limits = { sourceRequests: 64, summaryRequests: 8, summaryRequestsPerCompaction: 2, probeRequests: 32, compactions: 4, timeoutMs: 120000 };
  const protocol = { schema: "continuity-e2-protocol-v1", probeLookupRounds: 1, branches: [
    { id: "main", startTurn: 0, endTurn: 7, models: [LUNA, SOL, LUNA, SOL].map(model => ({ model, effort: "high" })), transitions,
      checkpoints: [["B1", 1], ["B2", 3], ["B4", 7]].map(([name, turn]) => ({ name, turn, message: message(turn) })), exclusions: { steps: [], coverage: [] }, limits },
    { id: "prefix", startTurn: 0, endTurn: 5, models: [SOL, LUNA, SOL].map(model => ({ model, effort: "high" })), transitions: transitions.filter(t => t.turn <= 5),
      checkpoints: [{ name: "B3", turn: 5, message: message(5) }], exclusions: { steps: [], coverage: [] }, limits },
  ] };
  return { source, protocol: validateProtocol(protocol, source) };
}

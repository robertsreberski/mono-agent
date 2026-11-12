// Fictional recorded-tool variant; leave continuity fixtures and goldens intact.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readRecordedSource } from "../../lib/continuity-recorded-import.mjs";
import { CONVERSATION, boundary, tool } from "./continuity-recorded/snapshots.mjs";
export async function baselineToolSource(root) {
  const db = new DatabaseSync(join(root, "snapshots/web.sqlite"));
  try {
    const row = db.prepare("SELECT parts_json FROM messages WHERE id='assistant-0'").get();
    const parts = [...JSON.parse(row.parts_json), boundary(), tool("fictional-baseline-read", "Fictional note discussing ### Conversation continuity pack (historical evidence)."), { type: "text", text: "Fictional read completed." }];
    db.prepare("UPDATE messages SET parts_json=? WHERE id='assistant-0'").run(JSON.stringify(parts));
  } finally { db.close(); }
  return (await readRecordedSource(join(root, "snapshots/manifest.json"), CONVERSATION)).source;
}

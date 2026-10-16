import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableHistoryStore } from "../../../dist/durable-history.js";
const [root, id, mode] = process.argv.slice(2);
const store = createDurableHistoryStore({ root, ...(mode === "incarnation" ? { reconcileProviderSessionTurn: async () => ({ status: "absent" }), retireProviderSession: async () => { throw new Error("Unexpected retirement before kill"); } } : {}) });
const alive = setInterval(() => {}, 60_000);
if (mode === "cancel") {
  const controller = new AbortController(), acquire = store.claims.acquireLogicalConversation.bind(store.claims), rootTransaction = store.acquireRootTransaction.bind(store);
  store.claims.acquireLogicalConversation = async (...args) => {
    const held = await acquire(...args);
    held.release = async () => { process.send({ phase: "unwind" }); await once(process, "disconnect"); };
    return held;
  };
  store.acquireRootTransaction = (...args) => { process.send({ phase: "root-wait" }); return rootTransaction(...args); };
  process.on("message", () => controller.abort());
  await store.beginProviderSessionPreparation(id, "fictional-cancelled", controller.signal);
  throw new Error("Cancelled acquisition unexpectedly completed");
}
let release;
if (mode === "logical") {
  const owner = await store.beginProviderSessionPreparation(id, "fictional-holder"); release = () => owner.abort();
} else if (mode === "incarnation") {
  const owner = await store.beginProviderSessionTurn(id, "fictional-killed", { modelKey: "faux:fictional-model", reconciliation: {
    purpose: "execution", ownerKey: id, initial: { persistText: "Fictional crash input", timestamp: new Date(0).toISOString() },
  } });
  release = () => owner.abort();
} else if (mode === "exact") {
  const owner = await store.claims.acquireExactConversationClaim(id); release = () => owner.release();
} else {
  const key = createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
  const shard = (Number.parseInt(key.slice(0, 8), 16) % 16).toString(16).padStart(2, "0");
  const path = join(root, ".locks", mode === "root" ? "root.sqlite" : mode === "shard" ? `logical-session-shard-${shard}.sqlite` : `${key}.sqlite`);
  if (mode === "legacy") await writeFile(path, "", { mode: 0o600 });
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE");
  release = async () => { db.exec("ROLLBACK"); db.close(); };
}
process.on("message", async () => { await release(); clearInterval(alive); process.disconnect(); });
process.send({ phase: "held" });

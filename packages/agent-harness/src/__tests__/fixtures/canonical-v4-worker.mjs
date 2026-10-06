import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { bucket, modelKey, timestamp, conversationKey, evidence } from "./canonical-v4-fixture.mjs";
const [root, action, phase] = process.argv.slice(2);
let canonicalPublished = false, inspections = 0;
const pause = async (current) => {
  if (action === "commit" && current === phase) { process.send?.({ phase: current }); await new Promise(() => {}); }
};
const rename = fs.promises.rename, open = fs.promises.open;
fs.promises.rename = async (...args) => {
  const result = await rename(...args);
  if (String(args[1]).endsWith(".history.json")) { canonicalPublished = true; await pause("canonical_renamed"); }
  return result;
};
fs.promises.open = async (...args) => {
  const handle = await open(...args);
  if (String(args[0]) === root) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); if (canonicalPublished) await pause("canonical_directory_synced"); };
  }
  return handle;
};
syncBuiltinESMExports();
try {
  const { createDurableHistoryStore } = await import("../../../dist/durable-history.js");
  const store = createDurableHistoryStore({ root, now: () => Date.parse(timestamp), retireProviderSession: async () => { throw new Error("Unexpected native retirement"); },
    reconcileProviderSessionTurn: async (request) => { inspections++; return evidence(request); } });
  const writeStage = store.writeStage.bind(store);
  store.writeStage = async (...args) => { const result = await writeStage(...args); if (args[0].version === 4) await pause("canonical_stage_synced"); return result; };
  const removeFence = store.removeDirtyFenceAfterCommit.bind(store);
  store.removeDirtyFenceAfterCommit = async (...args) => { await pause("fence_cleanup_started"); await removeFence(...args); await pause("fence_removed"); };
  const removePending = store.removePendingConversation.bind(store);
  store.removePendingConversation = async (...args) => { await removePending(...args); if (canonicalPublished) await pause("payload_removed"); };
  if (action === "commit") {
    const turn = await store.beginProviderSessionTurn(bucket, "fictional-next-turn", { modelKey,
      reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: "Fictional new question.", timestamp } } });
    await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
    throw new Error(`Expected pause at ${phase}`);
  } else {
    await store.recoverProviderSessionTurn(bucket);
    const record = JSON.parse(await fs.promises.readFile(join(root, `${conversationKey(bucket)}.history.json`), "utf8"));
    const fences = (await fs.promises.readdir(join(root, ".locks"))).filter((name) => name.endsWith(".dirty.json"));
    process.send?.({ record, fences, pending: await fs.promises.readdir(join(root, ".pending-turns")), inspections });
  }
} catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
process.disconnect?.();

import { resolve } from "node:path";
import { ToolHistoryWriter } from "../../../dist/tool-history/writer.js";
import { createDurableHistoryStore } from "../../../dist/history/canonical/store.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const [root, phase] = process.argv.slice(2);
// The real canonical lock is the recovery authority. No history is published in
// this protocol; the participant only exposes that hold's owner callback.
const history = createDurableHistoryStore({ root, continuity: {} });
let turn;
try { turn = await history.contextImport.beginExclusiveTurn("fictional", AbortSignal.timeout(1000)); }
catch { process.send({ phase: "owner_busy", fetches: 0 }); process.exit(0); }
const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
const scope = { logicalId: "fictional", conversationId: "fictional" };
const fence = await turn.withContinuityOwner(async ownerToken => {
  const expected = await writer.mutateUpkeep({ kind: "inspect", scope });
  return await writer.mutateUpkeep({ kind: "claim", expected, ownerToken });
});
const reservation = { databaseId: fence.databaseId, ...scope, incarnation: fence.incarnation, fence: fence.fence, ownerToken: fence.ownerToken,
  operationId: `operation-${phase}`, runId: "origin-run", recorderNamespace: resolve("/fictional-recorder"), model: "fictional:base", manifest: "a".repeat(64), parent: null,
  budget: fence.bootstrap ? "bootstrap" : "incremental" };
let fetches = 0;
globalThis.fetch = async () => { fetches++; return new Response("{}"); };
if (phase === "recover") {
  let bootstrapRejected = false, incrementalRejected = false;
  if (!fence.bootstrap) {
    try { await writer.mutateUpkeep({ kind: "reserve", reservation: { ...reservation, budget: "bootstrap", model: "fictional:changed-model", manifest: "b".repeat(64) } }); }
    catch { bootstrapRejected = true; }
    try { await writer.mutateUpkeep({ kind: "reserve", reservation: { ...reservation, budget: "incremental", model: "fictional:changed-model", manifest: "c".repeat(64) } }); }
    catch { incrementalRejected = true; }
  }
  // Inspect the durable recovery result after the worker has stopped. Closing
  // a second SQLite connection while its exporter writes can itself hit BUSY.
  await writer.close();
  const db = new DatabaseSync(join(root, "tool-history", "tool-lifecycles.sqlite"), { readOnly: true });
  let rows;
  try { rows = db.prepare("SELECT reservation,state,outcome FROM continuity_upkeep_operations").all(); } finally { db.close(); }
  process.send({ phase, bootstrap: fence.bootstrap, bootstrapRejected, incrementalRejected, fetches, rows });
  await turn.abort(); process.exit(0);
}
await turn.withContinuityOwner(async () => await writer.mutateUpkeep({ kind: "reserve", reservation }));
if (phase !== "reserved") {
  await turn.withContinuityOwner(async () => await writer.mutateUpkeep({ kind: "dispatch", reservation }));
  if (phase !== "dispatch_started") {
    await fetch("https://fictional.invalid");
    if (phase === "outcome") await turn.withContinuityOwner(async () => await writer.mutateUpkeep({ kind: "outcome", reservation,
      receipt: { operationId: reservation.operationId, model: reservation.model, status: "valid", reason: "completed", providerInvoked: true,
        api: "openai-responses", capEnforcement: "request", elapsedMs: 1, inputTokens: 25, outputTokens: 2,
        estimatedInputTokens: 30, estimatedInputCostUsd: 0.0001, costUsd: 0.0002, visibleEstimate: 2, outputOverrun: false,
        providerUsage: { input: 20, cacheRead: 5, cacheWrite: 0, output: 2 } } }));
  }
}
process.send({ phase, fetches });
// Parent kills this process at the announced durable window, without cleanup.
process.on("message", () => {});

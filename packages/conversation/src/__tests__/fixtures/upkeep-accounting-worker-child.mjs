import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
const [writerUrl, root, mode] = process.argv.slice(2);
const { ToolHistoryWriter } = await import(writerUrl);
const { TOOL_HISTORY_OWNER_DATABASE } = await import(new URL("contracts.js", writerUrl));
let warnings = 0;
const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true, onWarning: () => { warnings++; } });
const scope = { logicalId: "logical", conversationId: "fictional" };
const claim = async () => await writer.mutateUpkeep({ kind: "claim", expected: await writer.mutateUpkeep({ kind: "inspect", scope }), ownerToken: "owner" });
const reservation = (fence, operationId, recorderNamespace) => ({ ...fence, operationId, runId: "origin", recorderNamespace, model: "fictional:extractor", budget: fence.bootstrap ? "bootstrap" : "incremental", manifest: "a".repeat(64), parent: null });
const receipt = r => ({ operationId: r.operationId, model: r.model, status: "invalid", providerInvoked: true, reason: "aborted", inputTokens: null, outputTokens: null, costUsd: null });
const bounded = promise => Promise.race([promise, delay(1000).then(() => { throw new Error("RPC waited on exporter"); })]);
if (mode === "parked") {
  let parkedResolve, secureWrites = 0;
  const parked = new Promise(resolve => { parkedResolve = resolve; });
  writer.worker.on("message", message => { if (message.value?.testSecureWrite) secureWrites++; if (message.value?.testExporterParked) parkedResolve(); });
  const r = reservation(await claim(), "operation", join(root, "runs"));
  await writer.mutateUpkeep({ kind: "reserve", reservation: r });
  const dispatch = writer.mutateUpkeep({ kind: "dispatch", reservation: r });
  await bounded(parked); assert.equal(await bounded(dispatch), null);
  assert.ok(secureWrites > 0); // includes the durable pre-I/O attempt inside mode-600 journal
  assert.equal(await bounded(writer.mutateUpkeep({ kind: "outcome", reservation: r, receipt: receipt(r) })), null);
  const start = performance.now(); await writer.close(); assert.ok(performance.now() - start < 3000);
  const ownerDb = new DatabaseSync(join(root, ".locks", TOOL_HISTORY_OWNER_DATABASE), { readOnly: true });
  assert.equal(ownerDb.prepare("SELECT count(*) n FROM writer_owner").get().n, 0); ownerDb.close();
  console.log(JSON.stringify({ dispatch: true, outcome: true, ownerReleased: true, secureWrites: true }));
} else {
  for (let i = 0; i < 12; i++) {
    const r = reservation(await claim(), `invalid-${i}`, "relative");
    await assert.rejects(writer.mutateUpkeep({ kind: "reserve", reservation: r }), { code: "namespace_invalid" });
  }
  // Resolve the canonical database name from the actual reader rather than a parallel contract.
  const { ToolHistoryReader } = await import(new URL("reader.js", writerUrl));
  const db = new DatabaseSync(new ToolHistoryReader(root).databasePath); db.exec("PRAGMA busy_timeout=5000");
  const namespaceRows = db.prepare("SELECT count(*) n FROM continuity_upkeep_accounting").get().n; assert.equal(namespaceRows, 0);
  const namespace = join(root, "runs"); await mkdir(namespace); await writeFile(join(namespace, "origin.summary.json"), "invalid");
  const r = reservation(await claim(), "failure", namespace); await writer.mutateUpkeep({ kind: "reserve", reservation: r }); await writer.mutateUpkeep({ kind: "dispatch", reservation: r });
  await writer.mutateUpkeep({ kind: "outcome", reservation: r, receipt: receipt(r) }); await writer.replayUpkeepAccounting();
  assert.equal(db.prepare("SELECT exported FROM continuity_upkeep_accounting").get().exported, "failed");
  await writeFile(join(namespace, "origin.summary.json"), JSON.stringify({ runId: "origin", conversationId: "fictional" }));
  for (let i = 0; i < 4; i++) {
    const r = reservation(await claim(), `healthy-${i}`, namespace); r.manifest = String(i + 1).repeat(64);
    await writer.mutateUpkeep({ kind: "reserve", reservation: r }); await writer.mutateUpkeep({ kind: "dispatch", reservation: r });
    await writer.mutateUpkeep({ kind: "outcome", reservation: r, receipt: receipt(r) }); await writer.replayUpkeepAccounting();
  }
  db.close(); await writer.close(); assert.equal(warnings, 1);
  let reopenWarnings = 0;
  const reopened = await ToolHistoryWriter.open({ root, onWarning: () => { reopenWarnings++; } }); await reopened.replayUpkeepAccounting(); await reopened.close(); assert.equal(reopenWarnings, 0);
  console.log(JSON.stringify({ warnings, namespaceRows, reopenWarnings }));
}

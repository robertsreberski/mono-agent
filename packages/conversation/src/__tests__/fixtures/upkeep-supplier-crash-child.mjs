import { resolve } from "node:path";
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ToolHistoryWriter } from "../../../dist/tool-history/writer.js";
import { ToolHistoryReader } from "../../../dist/tool-history/reader.js";
import { createDurableHistoryStore } from "../../../dist/history/canonical/store.js";
import { createLedgerSupplier } from "../../../dist/continuity/upkeep.js";
import { ledgerHash } from "../../../dist/continuity/ledger.js";
import { continuityGenerationId, continuityRecordId } from "../../../dist/tool-history/continuity-storage.js";

const [root, phase, counterPath] = process.argv.slice(2);
const calls = () => { try { return readFileSync(counterPath, "utf8").trim().split("\n").filter(Boolean).length; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } };
process.on("message", () => {}); // Keep the announced crash window alive.
const checkpoint = async () => { process.send({ phase, calls: calls() }); await new Promise(() => { setInterval(() => {}, 1_000); }); }; // Parent SIGKILLs this child here.
const history = createDurableHistoryStore({ root, continuity: {} });
const turn = await history.contextImport.beginExclusiveTurn("fictional");
const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
const reader = new ToolHistoryReader(root);
if (phase !== "recover") {
  const generationId = continuityGenerationId(), digest = ledgerHash(generationId);
  await writer.prepareContinuity({ generationId, conversationId: "fictional", logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
    records: [{ recordId: continuityRecordId("fictional", generationId), runId: "historical-run", inputId: "fictional-input", kind: "owner", provenance: "host-owner", sequence: 0,
      text: "Never send a fictional draft without confirmation.", source: { attestation: { inputId: "fictional-input", requestDigest: digest } } }] });
  await writer.commitContinuity({ generationId, conversationId: "fictional", canonicalDigest: digest });
}
globalThis.fetch = async () => {
  const fd = openSync(counterPath, "a", 0o600);
  try { appendFileSync(fd, "provider-call\n"); fsyncSync(fd); } finally { closeSync(fd); }
  // Provider request has started once, but has not returned to completion yet.
  if (phase === "dispatch_started") await checkpoint();
  return new Response("{}");
};
const events = [];
const supplier = createLedgerSupplier({ toolHistory: { writer, reader, continuityEnabled: true, logicalConversationId: id => id,
  upkeep: { enabled: true, model: "fictional:base", recorderNamespace: resolve("/fictional-recorder"), complete: async (_prompt, _signal, budget) => {
    await fetch("https://fictional.invalid");
    return { text: JSON.stringify({ entries: [{ kind: "open_work", status: "unknown", value: "Fictional state.", sources: ["s0"] }], covered: ["s0"] }),
      receipt: { operationId: budget.operationId, model: "fictional:base", providerInvoked: true, status: "valid", reason: "completed", api: "openai-responses", capEnforcement: "request",
        elapsedMs: 1, inputTokens: 25, outputTokens: 2, estimatedInputTokens: 30, estimatedInputCostUsd: 0.0001, costUsd: 0.0002, visibleEstimate: 2, outputOverrun: false } };
  } },
  mutateUpkeep: async input => {
    // Completion has returned to the real supplier; kill before durable outcome.
    if (phase === "provider_return" && input.kind === "outcome") await checkpoint();
    return await writer.mutateUpkeep(input);
  }, publishLedger: writer.publishLedger.bind(writer) } },
  { conversationId: "fictional", userMessage: "New fictional boundary.", abortSignal: new AbortController().signal }, phase === "recover" ? "recovery-run" : "origin-run");
await supplier.prepare({ sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000,
  withOwner: turn.withContinuityOwner.bind(turn) }, "cold_rebuild", event => events.push(event));
// Inspect settled recovery after the worker releases its SQLite connection;
// do not race a read-only connection's close against background export writes.
await writer.close();
const db = new DatabaseSync(reader.databasePath, { readOnly: true });
let operations;
try { operations = db.prepare("SELECT state,outcome FROM continuity_upkeep_operations").all(); } finally { db.close(); }
const published = !!reader.ledger({ logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "recovery-run" });
process.send({ phase, calls: calls(), operations, published, events });
await turn.abort(); process.exit(0);

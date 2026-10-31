// Free selection/fitting regression helper. No model, credentials, probes or gold
// answers enter this path. The production supplier runs selectLedgerSources and
// fitLedgerSelection, including durable offer settlement on analysis-only passes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ToolHistoryWriter, ToolHistoryReader } from "@mono-agent/conversation";
import { continuityRecordId } from "../../packages/conversation/dist/tool-history/continuity-storage.js";
import { createContinuityPackSupplier } from "../../packages/conversation/dist/continuity/pack.js";

const hash = text => createHash("sha256").update(text).digest("hex");
const scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "reader" };

/** Source-only development trace projection; not a replacement for harness replay.
 * Ordering is owner input, applied steer, tool result, then assistant reply.
 * Retention/sanitation is applied by the real writer below. */
export function selectionReplayRecords(trace) {
  if (trace.fictional !== true) throw new Error("replay_requires_fictional_trace");
  const records = [];
  for (const turn of trace.turns) {
    records.push({ kind: "owner", text: turn.user });
    for (const step of turn.steps) {
      if (step.steer) records.push({ kind: "owner", text: step.steer });
      if (step.call) records.push({ kind: "tool", text: step.call.result, toolName: step.call.tool });
      if (step.reply) records.push({ kind: "assistant", text: step.reply });
    }
  }
  return records;
}

/** Newly authored fictional pressure case. Bulk deliberately outnumbers short
 * transitions; no semantic ranking preference is added by this helper. */
export function fictionalTransitionRecords() {
  const records = [{ kind: "owner", text: "Never send a document without my approval." }];
  const transitions = [
    "I will prepare the LANTERN checklist.",
    "Cancel my LANTERN checklist commitment.",
    "I reject the WILLOW proposal; no agreement was reached.",
    "The CEDAR review is complete, according to the coordinator.",
    "We could prepare a BIRCH exhibit; this is only a suggestion.",
    "I agree to prepare the MAPLE exhibit.",
    "Approve the LANTERN draft for filing, not sending.",
    "Void the WILLOW draft.",
    "File the CEDAR note but do not send it.",
    "Send the approved MAPLE note.",
    "Correction: the OAK quantity is seven, not twelve.",
    "Next action: check the filing receipt before any further work.",
  ];
  const tools = ["read_notes", "read_inventory", "read_archive", "read_status", "read_catalog", "read_report"];
  for (let i = 0; i < 160; i++) {
    const batch = String.fromCharCode(65 + Math.floor(i / 26), 65 + i % 26);
    records.push({ kind: "tool", toolName: tools[i % tools.length], text: `Batch ${batch}: reviewed 42 items.\n\n${"Unchanged planning detail. ".repeat(720)}` });
    if (i >= 120 && i < 132) records.push({ kind: "owner", text: transitions[i - 120] });
  }
  records.push({ kind: "tool", toolName: "read_notes", text: "Filing reference: LANTERN\nDispatch reference: WILLOW\nFiling reported complete; dispatch not verified." });
  return records;
}

/** Three cold-boundary preparations with unchanged production budgets. Pass two
 * intentionally returns no delta. Full retained records and exact JSON source
 * descriptors are returned for EVERY offer, independently of publication.
 * Callers may supply another scripted delta selector for comparative tests. */
export async function replayLedgerSelection(records, { entriesForPass = (pass, rows) => pass === 2 ? [] : [
  { kind: "open_work", value: `Fictional replay pass ${pass}.`, status: "unknown", sources: [rows[0].id] },
] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "continuity-selection-"));
  let writer;
  try {
    writer = await ToolHistoryWriter.open({ root, continuityEnabled: true, persistenceCeilingMs: 5000 });
    const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "fictional-history", isolated: false, continuityEnabled: true, finalizedContinuity: true };
    for (const [n, record] of records.entries()) {
      if (record.kind === "tool") {
        const toolCallId = `fictional-call-${n}`;
        await writer.persist(binding, { phase: "invocation", toolCallId, toolName: record.toolName, arguments: {} });
        await writer.persist(binding, { phase: "result", toolCallId, toolName: record.toolName, state: "success", content: record.text });
      } else {
        const generationId = `chg1_${hash(`fictional-record-${n}`).slice(0, 32)}`, digest = hash(generationId), inputId = `fictional-input-${n}`;
        await writer.prepareContinuity({ generationId, conversationId: "fictional", logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
          records: [{ recordId: continuityRecordId("fictional", `record-${n}`), runId: binding.runId, inputId, sequence: n,
            kind: record.kind, provenance: record.kind === "owner" ? "host-owner" : "unknown", text: record.text,
            source: record.kind === "owner" ? { attestation: { inputId, requestDigest: hash(record.text) } } : {},
          }] });
        await writer.commitContinuity({ generationId, conversationId: "fictional", canonicalDigest: digest });
      }
    }
    await writer.finishRun(binding, "completed");
    const reader = new ToolHistoryReader(root), passes = [];
    let sourceSnapshot;
    const snapshot = reader.snapshotContinuity.bind(reader);
    reader.snapshotContinuity = input => { sourceSnapshot = snapshot(input); return sourceSnapshot; };
    for (let pass = 1; pass <= 3; pass++) {
      const prior = reader.ledger(scope)?.generation;
      const result = { pass, offered: [], records: [], deltaEntries: null, published: false };
      const events = [];
      const complete = async (prompt, _signal, budget) => {
        const rows = prompt.split("\nSources:\n")[1].trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        result.offered = rows;
        // This is the exact retained representation offered to extraction, not
        // the unsanitized generator text or cumulative ledger.inputs.
        const ids = new Set(rows.map(row => row.recordId));
        result.records = sourceSnapshot.records.filter(record => ids.has(record.recordId));
        const entries = entriesForPass(pass, rows);
        result.deltaEntries = entries.length;
        result.inputTokens = budget.inputTokens;
        result.deltaCap = budget.maxEntries;
        result.promptBytes = Buffer.byteLength(prompt);
        return { text: JSON.stringify({ entries, covered: [...new Set(entries.flatMap(entry => entry.sources))] }), receipt: {
          operationId: budget.operationId, model: "openai-codex:fictional", status: "valid", reason: "completed", providerInvoked: true, capEnforcement: "stream_abort",
        } };
      };
      const supplier = createContinuityPackSupplier({ toolHistory: { writer, reader, mutateUpkeep: writer.mutateUpkeep.bind(writer), publishLedger: writer.publishLedger.bind(writer),
        continuityEnabled: true, logicalConversationId: () => "fictional", upkeep: { enabled: true, recorderNamespace: join(root, "recorder"), model: "openai-codex:fictional", complete } } },
      { conversationId: "fictional", userMessage: "Fictional cold boundary.", abortSignal: new AbortController().signal }, `fictional-pass-${pass}`);
      await supplier.prepare({ sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000,
        withOwner: async fn => fn("fictional-owner") }, "cold_rebuild", event => events.push(event));
      const selection = events.find(event => event.type === "continuity_upkeep_selection");
      const receipt = events.find(event => event.type === "continuity_upkeep");
      if (receipt?.status !== "valid" || result.deltaEntries === null) throw new Error(`replay_pass_failed:${pass}:${receipt?.reason}:${receipt?.failure ?? ""}`);
      if (result.records.length !== new Set(result.offered.map(row => row.recordId)).size) throw new Error("replay_record_capture_incomplete");
      result.published = reader.ledger(scope)?.generation.id !== prior?.id;
      result.selection = { candidates: selection.candidates, fitted: selection.fitted, deltaCap: selection.deltaCap,
        projectedBytes: selection.projectedBytes, lineageBytes: selection.lineageBytes, exclusions: selection.exclusions };
      passes.push(result);
    }
    return passes;
  } finally {
    await writer?.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Small pinned baseline; callers still receive full offered text and records. */
export function selectionReplaySummary(passes) {
  return passes.map(({ pass, offered, records, deltaEntries, published, inputTokens, deltaCap, promptBytes, selection }) => ({
    pass, offeredSpans: offered.length, offeredRecords: records.length, deltaEntries, published, inputTokens, deltaCap, promptBytes, selection,
    offeredDigest: hash(JSON.stringify(offered)), recordsDigest: hash(JSON.stringify(records)),
    ownerOrdinals: [...new Set(offered.filter(row => row.owner).map(row => row.ordinal))],
  }));
}

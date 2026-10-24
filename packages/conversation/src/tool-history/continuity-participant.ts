import { CONTINUITY_GENERATION_MAX_BYTES, CONTINUITY_GENERATION_MAX_RECORDS } from "./continuity-contracts.js";
import { continuityQuotation } from "./continuity-input.js";
import type { ToolHistoryReader } from "./reader.js";
import { retainContinuityText } from "./continuity-payload.js";
import { createHash } from "node:crypto";
import type { ConversationHistoryContinuityParticipant, OwnedContinuityMutation } from "../history/continuity-contracts.js";
import type { ContinuityGapInput, ContinuityPreparation, ContinuityPublication, ContinuityReconciliation, ContinuityReconciliationResult, ContinuityRecordInput } from "./continuity-contracts.js";
import { continuityGenerationId, continuityRecordId } from "./continuity-storage.js";

export interface ContinuityPublicationWriter {
  recordContinuityGap(input: ContinuityGapInput): Promise<void>;
  prepareContinuity(input: ContinuityPreparation): Promise<unknown>;
  commitContinuity(input: ContinuityPublication): Promise<void>;
  reconcileContinuity(input: ContinuityReconciliation): Promise<ContinuityReconciliationResult>;
  resetConversation(logicalConversationId: string): Promise<void>;
}

/** The canonical store supplies and retains ownership throughout every awaited call. */
export function createContinuityParticipant(options: {
  readonly writer: ContinuityPublicationWriter;
  readonly logicalConversationId: (conversationId: string) => string;
  readonly reader: Pick<ToolHistoryReader, "getContinuity">;
  readonly protectedConversations: () => readonly string[];
  readonly onWarning?: (message: string) => void;
}): ConversationHistoryContinuityParticipant {
  const warn = (text: string) => { try { options.onWarning?.(text); } catch { /* diagnostics never replace publication */ } };
  // Only bounded, content-free diagnostics survive a transient writer outage.
  // A process death while the whole sidecar is unavailable cannot be journalled
  // there; digest-bound reconciliation still prevents publishing wrong evidence.
  const pendingGaps: ContinuityGapInput[] = [];
  let lastContext: { conversationId: string; digest: string | null } | undefined;
  const flushGaps = async () => {
    while (pendingGaps.length) {
      try { await options.writer.recordContinuityGap(pendingGaps[0]!); pendingGaps.shift(); }
      catch { break; }
    }
  };
  const gap = async (conversationId: string, beforeDigest: string | null, afterDigest: string | null, reason: ContinuityGapInput["reason"]) => {
    warn(`Continuity is degraded (${reason}); coverage is incomplete. Canonical history remains available.`);
    if (pendingGaps.length >= 128) pendingGaps.shift();
    pendingGaps.push({ generationId: continuityGenerationId(), conversationId, logicalConversationId: options.logicalConversationId(conversationId), beforeDigest, afterDigest, reason });
    await flushGaps();
  };
  return {
    async checkpoint(context) {
      await context.assertOwned();
      let ownershipFailed = false;
      const assertOwned = async () => {
        try { await context.assertOwned(); } catch (error) { ownershipFailed = true; throw error; }
      };
      try {
        const evidence = context.evidence, logicalConversationId = options.logicalConversationId(context.conversationId);
        const recordId = continuityRecordId(context.conversationId, `summary:${evidence.journalId}:${evidence.operationId}`);
        const retained = retainContinuityText(evidence.summary);
        if (retained.truncated) throw Object.assign(new Error("Portable summary cannot be retained completely; compaction must be declined."), { code: "continuity_summary_unavailable" });
        const proof = { status: "published" as const, journalId: evidence.journalId, operationId: evidence.operationId,
          sourceDigest: evidence.sourceDigest, summaryDigest: retained.sha256 };
        const preparation = (generationId: string): ContinuityPreparation => ({ generationId, conversationId: context.conversationId, logicalConversationId,
          action: "checkpoint", beforeDigest: context.current.digest, afterDigest: context.current.digest, latestSummaryRecordId: recordId,
          records: [{ recordId, runId: context.runId, kind: "summary", sequence: 0, provenance: "generated", text: evidence.summary,
            source: { journalId: evidence.journalId, operationId: evidence.operationId,
              ...(context.current.epoch === undefined ? {} : { epoch: context.current.epoch }),
              ...(context.current.revision === undefined ? {} : { revision: context.current.revision }) },
            summary: { model: evidence.model, operationId: evidence.operationId, trigger: evidence.trigger, coverage: { sourceDigest: evidence.sourceDigest } } }] });
        const known = options.reader.getContinuity({ logicalConversationId, currentConversationId: context.conversationId, currentRunId: context.runId, recordId });
        if (known.status === "available") {
          if (known.record?.sha256 !== retained.sha256 || known.record.summary?.coverage.sourceDigest !== evidence.sourceDigest
            || known.record.summary.model !== evidence.model || known.record.summary.trigger !== evidence.trigger) {
            // Let the worker durably account for the idempotency conflict too.
            await options.writer.prepareContinuity(preparation(known.record!.generationId));
            throw Object.assign(new Error("Conflicting durable summary identity."), { code: "continuity_conflict" });
          }
          return;
        }
        if (context.phase === "committed") {
          const result = await options.writer.reconcileContinuity({ conversationId: context.conversationId, canonicalDigest: context.current.digest, checkpoint: proof });
          if (result.status === "committed") { await assertOwned(); return; }
        }
        const generationId = continuityGenerationId();
        await options.writer.prepareContinuity(preparation(generationId));
        await assertOwned();
        if (context.phase === "committed") await options.writer.commitContinuity({ conversationId: context.conversationId, generationId, canonicalDigest: context.current.digest, checkpoint: proof });
      } catch (error) {
        if (ownershipFailed) throw error;
        await gap(context.conversationId, context.current.digest, context.current.digest,
          (error as { code?: string }).code === "continuity_quota_exhausted" ? "capture_quota"
            : (error as { code?: string }).code === "continuity_summary_unavailable" ? "capture_bounds" : "sidecar_unavailable");
        if (context.phase === "prepare") throw error; // Decline the cut, not the user's turn.
      }
      await context.assertOwned();
    },
    async recoverCheckpoint(context) {
      await context.assertOwned();
      const evidence = context.evidence;
      try {
        await flushGaps();
        await options.writer.reconcileContinuity({ conversationId: context.conversationId, canonicalDigest: context.current.digest,
          checkpoint: evidence ? { status: "published", journalId: evidence.journalId, operationId: evidence.operationId, sourceDigest: evidence.sourceDigest, summaryDigest: retainContinuityText(evidence.summary).sha256 } : { status: "absent" } });
      } catch { await gap(context.conversationId, context.current.digest, context.current.digest, "sidecar_unavailable"); }
      await context.assertOwned();
    },
    async protectedConversations() {
      try { return options.protectedConversations(); }
      catch {
        warn("Continuity is degraded: retention protection is unavailable; canonical retention continues.");
        if (lastContext) await gap(lastContext.conversationId, lastContext.digest, lastContext.digest, "sidecar_unavailable");
        return [];
      }
    },
    async reconcile(context) {
      await context.assertOwned();
      lastContext = { conversationId: context.conversationId, digest: context.current.digest };
      try {
        await flushGaps();
        const result = await options.writer.reconcileContinuity({ conversationId: context.conversationId, canonicalDigest: context.current.digest });
        if (result.status === "abandoned") warn("Continuity coverage gap: canonical history advanced past a preparation; unpublished evidence was abandoned.");
      } catch { await gap(context.conversationId, context.current.digest, context.current.digest, "sidecar_unavailable"); }
      await context.assertOwned();
    },
    async prepare(mutation) {
      await mutation.assertOwned();
      if (mutation.before.digest === mutation.after.digest) return undefined;
      const generationId = continuityGenerationId();
      const records = mutation.action === "publish" ? appendedRecords(mutation, generationId) : [];
      if (records.length > CONTINUITY_GENERATION_MAX_RECORDS || records.reduce((bytes, record) => bytes + Buffer.byteLength(record.text), 0) > CONTINUITY_GENERATION_MAX_BYTES) {
        await gap(mutation.conversationId, mutation.before.digest, mutation.after.digest, "capture_bounds");
        return undefined;
      }
      try {
        await options.writer.prepareContinuity({ generationId, conversationId: mutation.conversationId,
          logicalConversationId: options.logicalConversationId(mutation.conversationId),
          beforeDigest: mutation.before.digest, afterDigest: mutation.after.digest, action: mutation.action, records });
      } catch (error) {
        await gap(mutation.conversationId, mutation.before.digest, mutation.after.digest,
          (error as { code?: string }).code === "continuity_quota_exhausted" ? "capture_quota" : "sidecar_unavailable");
        return undefined;
      }
      await mutation.assertOwned();
      return {
        async commit(current) {
          await mutation.assertOwned();
          try { await options.writer.commitContinuity({ generationId, conversationId: mutation.conversationId, canonicalDigest: current.digest }); }
          catch { await gap(mutation.conversationId, mutation.before.digest, current.digest, "sidecar_unavailable"); }
          await mutation.assertOwned();
        },
      };
    },
    async resetLogical(context) {
      await context.assertOwned();
      try { await options.writer.resetConversation(options.logicalConversationId(context.conversationId)); }
      catch { await gap(context.conversationId, null, null, "sidecar_unavailable"); }
      await context.assertOwned();
    },
  };
}

function appendedRecords(mutation: OwnedContinuityMutation, generationId: string): readonly ContinuityRecordInput[] {
  const before = mutation.before.messages, after = mutation.after.messages;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const oldIds = before.map(hash), newIds = after.map(hash);
  let overlap = Math.min(oldIds.length, newIds.length);
  while (overlap > 0 && !newIds.slice(0, overlap).every((id, index) => id === oldIds[oldIds.length - overlap + index])) overlap -= 1;
  return after.slice(overlap).flatMap((message, index): ContinuityRecordInput[] => {
    // Canonical imports/legacy roles cannot acquire host-owner provenance. System
    // prompts and unverified legacy tool envelopes are not retained here.
    if (message.role !== "user" && message.role !== "assistant") return [];
    // These typed host accounts contain partial assistant streams and nested
    // lifecycle/retrieval envelopes. They are canonical reconstruction data,
    // not eligible retained assistant text. Do not parse/promote their body.
    if (message.role === "assistant" && (message.idempotencyKey?.startsWith("cancelled-turn:v1:")
      || message.idempotencyKey?.startsWith("failed-turn:v1:")
      || (mutation.after.settlement !== undefined && mutation.after.settlement.turnId === message.runId && mutation.after.settlement.outcome !== "completed"))) return [];
    const stamp = continuityQuotation(message);
    const owner = message.role === "user" && stamp?.ownerText !== undefined;
    return [{ recordId: continuityRecordId(mutation.conversationId, `${generationId}:${index}`),
      runId: message.runId ?? `canonical:${mutation.after.digest}`, ...(stamp ? { inputId: stamp.inputId } : {}),
      kind: owner ? "owner" : message.role === "user" ? "user" : message.name === "context-import" ? "imported" : "assistant",
      provenance: owner ? "host-owner" : "unknown", sequence: index, text: owner ? stamp!.ownerText! : message.content,
      source: { ...(owner ? { attestation: { inputId: stamp!.inputId, requestDigest: stamp!.requestDigest } } : {}), ...(mutation.after.epoch === undefined ? {} : { epoch: mutation.after.epoch }),
        ...(mutation.after.revision === undefined ? {} : { revision: mutation.after.revision }), ...stamp?.source } }];
  });
}

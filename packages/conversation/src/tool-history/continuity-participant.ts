import { createHash } from "node:crypto";
import type { ConversationHistoryContinuityParticipant, OwnedContinuityMutation } from "../history/continuity-contracts.js";
import type { ContinuityPreparation, ContinuityPublication, ContinuityReconciliation, ContinuityReconciliationResult, ContinuityRecordInput } from "./continuity-contracts.js";
import { continuityGenerationId, continuityRecordId } from "./continuity-storage.js";

export interface ContinuityPublicationWriter {
  prepareContinuity(input: ContinuityPreparation): Promise<unknown>;
  commitContinuity(input: ContinuityPublication): Promise<void>;
  reconcileContinuity(input: ContinuityReconciliation): Promise<ContinuityReconciliationResult>;
  resetConversation(logicalConversationId: string): Promise<void>;
}

/** The canonical store supplies and retains ownership throughout every awaited call. */
export function createContinuityParticipant(options: {
  readonly writer: ContinuityPublicationWriter;
  readonly logicalConversationId: (conversationId: string) => string;
  readonly protectedConversations: () => readonly string[];
  readonly onWarning?: (message: string) => void;
}): ConversationHistoryContinuityParticipant {
  const warn = (text: string) => { try { options.onWarning?.(text); } catch { /* diagnostics never replace publication */ } };
  return {
    async protectedConversations() { return options.protectedConversations(); },
    async reconcile(context) {
      await context.assertOwned();
      const result = await options.writer.reconcileContinuity({ conversationId: context.conversationId, canonicalDigest: context.current.digest });
      if (result.status === "abandoned") warn("Continuity coverage gap: canonical history advanced past a preparation; unpublished evidence was abandoned.");
      await context.assertOwned();
    },
    async prepare(mutation) {
      await mutation.assertOwned();
      if (mutation.before.digest === mutation.after.digest) return undefined;
      const generationId = continuityGenerationId();
      const records = mutation.action === "publish" ? appendedRecords(mutation, generationId) : [];
      try {
        await options.writer.prepareContinuity({ generationId, conversationId: mutation.conversationId,
          logicalConversationId: options.logicalConversationId(mutation.conversationId),
          beforeDigest: mutation.before.digest, afterDigest: mutation.after.digest, action: mutation.action, records });
      } catch (error) {
        if ((error as { code?: string }).code !== "continuity_quota_exhausted") throw error;
        warn("Continuity is degraded: retained evidence capacity is exhausted; new evidence was not captured.");
        return undefined;
      }
      await mutation.assertOwned();
      return {
        async commit(current) {
          await mutation.assertOwned();
          await options.writer.commitContinuity({ generationId, conversationId: mutation.conversationId, canonicalDigest: current.digest });
          await mutation.assertOwned();
        },
      };
    },
    async resetLogical(context) {
      await context.assertOwned();
      await options.writer.resetConversation(options.logicalConversationId(context.conversationId));
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
    return [{ recordId: continuityRecordId(mutation.conversationId, `${generationId}:${index}`),
      runId: `canonical:${mutation.after.digest}`, kind: message.role === "user" ? "other-user" : "assistant",
      provenance: "unknown", sequence: index, text: message.content,
      source: { ...(mutation.after.epoch === undefined ? {} : { epoch: mutation.after.epoch }),
        ...(mutation.after.revision === undefined ? {} : { revision: mutation.after.revision }) } }];
  });
}

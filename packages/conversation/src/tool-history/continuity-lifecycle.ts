import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeToolLifecycleEvent } from "@mono-agent/turn/host/types";
import type { ToolHistoryRetentionOptions, ToolHistoryRunBinding } from "./contracts.js";
import { CONTINUITY_RECORD_MAX_BYTES } from "./continuity-contracts.js";
import { omittedContinuityText, retainContinuityText } from "./continuity-payload.js";
import { continuityRecordId, prepareContinuity } from "./continuity-storage.js";
import { isNestedHistoryTool } from "./nested-history.js";

/** Worker-only: called with the validated terminal lifecycle row in its FULL
 * transaction. No inferred completion, synthetic recovery or partial stream.
 * The record and matching lifecycle receipt become durable atomically. */
export function captureFinalizedToolText(
  database: DatabaseSync,
  binding: ToolHistoryRunBinding,
  event: Extract<RuntimeToolLifecycleEvent, { phase: "result" }>,
  toolName: string,
  limits: Required<ToolHistoryRetentionOptions>,
  reserve: (bytes: number, records: number) => void,
): void {
  if (binding.continuityEnabled !== true || binding.finalizedContinuity !== true || binding.isolated || event.state !== "success" || toolName === "unknown_tool" || isNestedHistoryTool(toolName)) return;
  const blocks = typeof event.content === "string" ? [{ type: "text", text: event.content }] : event.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  // Never extract a text-looking subset from opaque/image/signed content.
  if (blocks.some((block) => !block || block.type !== "text" || typeof block.text !== "string"
    || Object.keys(block).some((key) => key !== "type" && key !== "text"))) return;
  let originalBytes = blocks.length - 1;
  const parts: string[] = [];
  for (const block of blocks) {
    originalBytes += Buffer.byteLength(block.text, "utf8");
    if (originalBytes <= CONTINUITY_RECORD_MAX_BYTES) parts.push(block.text);
  }
  const retained = originalBytes > CONTINUITY_RECORD_MAX_BYTES
    ? omittedContinuityText(originalBytes) : retainContinuityText(parts.join("\n"));
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const callKey = hash([binding.conversationId, binding.runId, event.toolCallId]);
  const receipt = hash([callKey, toolName, event.state, retained]);
  prepareContinuity(database, {
    generationId: `chg1_${hash(["tool-result", callKey]).slice(0, 32)}`,
    conversationId: binding.conversationId, logicalConversationId: binding.logicalConversationId,
    // This target is the matching finalized lifecycle receipt, not a canonical
    // mutation. It never participates in canonical prepared-target recovery.
    beforeDigest: null, afterDigest: receipt, action: "publish",
    records: [{ recordId: continuityRecordId(binding.conversationId, `tool-result:${callKey}`),
      runId: binding.runId, kind: "tool", provenance: "tool", sequence: 0,
      text: retained.text, source: { operationId: `tool:${callKey}` } }],
  }, limits, reserve, retained);
}

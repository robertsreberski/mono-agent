// @ts-check
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

/** Validate the effective provider projection; Pi supplies honest missing results. */
export function validRecoveryProjection(messages, model) {
  try {
    const projected = transformMessages(messages, model);
    const seen = new Set();
    const pending = new Map();
    for (const message of projected) {
      if (!["user", "assistant", "toolResult"].includes(message?.role)) return false;
      if (message.role !== "toolResult" && pending.size) return false;
      if (message.role === "user" && typeof message.content === "string") continue;
      if (!Array.isArray(message.content)) return false;
      if (message.role === "toolResult") {
        if (!pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName) return false;
        pending.delete(message.toolCallId);
      }
      if (message.role === "assistant" && ["error", "aborted", "deferred"].includes(message.stopReason)) return false;
      for (const block of message.content) {
        if (block?.type === "text") { if (typeof block.text !== "string") return false; }
        else if (block?.type === "image") { if (typeof block.data !== "string" || typeof block.mimeType !== "string") return false; }
        else if (block?.type === "thinking") {
          if (message.role !== "assistant" || typeof block.thinking !== "string"
            || (block.thinkingSignature !== undefined && (typeof block.thinkingSignature !== "string" || !block.thinkingSignature))) return false;
          if (block.thinkingSignature && String(model.api).includes("responses")) {
            const signature = JSON.parse(block.thinkingSignature);
            if (signature?.type !== "reasoning" || typeof signature.id !== "string" || !Array.isArray(signature.summary)) return false;
          }
        } else if (block?.type === "toolCall") {
          if (message.role !== "assistant" || typeof block.id !== "string" || !block.id || seen.has(block.id)
            || typeof block.name !== "string" || !block.name || !block.arguments || typeof block.arguments !== "object") return false;
          seen.add(block.id);
          pending.set(block.id, block.name);
        } else return false;
      }
    }
    return pending.size === 0;
  } catch { return false; }
}

import { textFromContent } from "../../providers/pi/messages.js";
import { APP_REPLY_PRESENTATION } from "../../tools/mcp/reply-presentation.js";
import type { PiTool } from "./types.js";

/** Tools that present the reply rather than gather more evidence for it. */
export function isReplyPresentationTool(name: any): boolean {
  return /^(?:PublishReplyFile|ProposeRestart|SuggestReplies|mcp__[^\s]+__(?:PublishReplyFile|ProposeRestart|SuggestReplies))$/.test(name ?? "");
}

function toolCalls(message: any) {
  return Array.isArray(message?.content) ? message.content.filter((block: any) => block?.type === "toolCall") : [];
}

export function isTrustedReplyPresentationTool(tool: PiTool): boolean {
  return tool[APP_REPLY_PRESENTATION] === true && isReplyPresentationTool(tool.name);
}

/**
 * In Pi, every call must vote to terminate. A settled tail containing exactly
 * the successful results of a trusted presentation batch proves that it did;
 * a newer assistant message or a placed steer is not part of that batch.
 */
export function hasTerminalReplyPresentationBatch(transcript: readonly any[], tools: readonly PiTool[]): boolean {
  const results = new Map<string, string>();
  let index = transcript.length - 1;
  for (; index >= 0 && transcript[index]?.role === "toolResult"; index--) {
    const result = transcript[index];
    if (result.isError !== false || results.has(result.toolCallId)) return false;
    results.set(result.toolCallId, result.toolName);
  }
  const assistant = transcript[index];
  if (!results.size || assistant?.role !== "assistant" || assistant.stopReason !== "toolUse") return false;
  const calls = toolCalls(assistant);
  const trustedNames = new Set(tools.filter(isTrustedReplyPresentationTool).map((tool) => tool.name));
  return calls.length === results.size && calls.every((call: any) =>
    results.get(call.id) === call.name && trustedNames.has(call.name));
}

/**
 * Keep the trailing answer, including prose attached to presentation-only tool
 * messages immediately before it. Ordinary tool narration stays out of replies,
 * and a terminal message that itself calls an ordinary tool (a stopped run) is
 * not extended with earlier presentation prose.
 * The whole-run stream remains the fallback only when this chain has no text.
 */
export function finalReplyText(allAssistantMessages: any, assistantTexts: any): any {
  // A failed partial before the terminal message was retried; never reply with it.
  const terminal = allAssistantMessages.at(-1);
  const assistantMessages = allAssistantMessages.filter((message: any) => message === terminal || message?.stopReason !== "error");
  let first = assistantMessages.length - 1;
  const terminalIsAnswer = toolCalls(assistantMessages[first]).every((call: any) => isReplyPresentationTool(call.name));
  while (terminalIsAnswer && first > 0) {
    const calls = toolCalls(assistantMessages[first - 1]);
    if (calls.length === 0 || !calls.every((call: any) => isReplyPresentationTool(call.name))) break;
    first -= 1;
  }
  return assistantMessages.slice(Math.max(0, first))
    .map((message: any) => textFromContent(message?.content))
    .filter(Boolean)
    .join("\n\n") || assistantTexts.join("");
}

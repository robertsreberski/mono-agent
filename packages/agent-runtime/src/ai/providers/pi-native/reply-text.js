import { textFromContent } from "../pi-messages.js";

/** Tools that present the reply rather than gather more evidence for it. */
export function isReplyPresentationTool(name) {
  return /^(?:PublishReplyFile|ProposeRestart|SuggestReplies|mcp__[^\s]+__(?:PublishReplyFile|ProposeRestart|SuggestReplies))$/.test(name ?? "");
}

function toolCalls(message) {
  return Array.isArray(message?.content) ? message.content.filter((block) => block?.type === "toolCall") : [];
}

/**
 * Keep the trailing answer, including prose attached to presentation-only tool
 * messages immediately before it. Ordinary tool narration stays out of replies,
 * and a terminal message that itself calls an ordinary tool (a stopped run) is
 * not extended with earlier presentation prose.
 * The whole-run stream remains the fallback only when this chain has no text.
 */
export function finalReplyText(assistantMessages, assistantTexts) {
  let first = assistantMessages.length - 1;
  const terminalIsAnswer = toolCalls(assistantMessages[first]).every((call) => isReplyPresentationTool(call.name));
  while (terminalIsAnswer && first > 0) {
    const calls = toolCalls(assistantMessages[first - 1]);
    if (calls.length === 0 || !calls.every((call) => isReplyPresentationTool(call.name))) break;
    first -= 1;
  }
  return assistantMessages.slice(Math.max(0, first))
    .map((message) => textFromContent(message?.content))
    .filter(Boolean)
    .join("\n\n") || assistantTexts.join("");
}

// Internal in-process key shared with the turn MCP bridge. Never sent to MCP.
const APP_REPLY_PRESENTATION = Symbol.for("@mono-agent/app-reply-presentation");

export function markReplyPresentationServer(spec: object): void {
  Object.defineProperty(spec, APP_REPLY_PRESENTATION, { value: true });
}

/** Shared description; tool results remain factual receipts. */
export const REPLY_PRESENTATION_CONTRACT = "This attaches to your visible reply and does not replace it. The user sees only your normal assistant text, never your reasoning. Write your complete answer as normal text, then call this tool last. On Pi, a successful batch of only reply-presentation calls ends the turn. Put all parts or files for the same reply in one final batch, with one PublishReplyFile call per file.";

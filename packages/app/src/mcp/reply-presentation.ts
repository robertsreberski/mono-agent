/**
 * The one reply contract shared by the reply-presentation tools
 * (SuggestReplies, ProposeRestart, PublishReplyFile). It lives only in their
 * descriptions. Their results are factual receipts: a result cannot see the
 * turn, so any composing instruction there is wrong for some turn (it either
 * asks for a repeated answer or claims an unwritten one exists). A turn that
 * still ends without reply text gets the runtime's empty-reply finalization.
 */
export const REPLY_PRESENTATION_CONTRACT = "This attaches to your visible reply and does not replace it. The user sees only your normal assistant text, never your reasoning, so write your complete answer as normal text before calling this tool.";

/** Composing instructions that must never appear in a presentation-tool result. */
export const REPLY_PRESENTATION_RESULT_FORBIDDEN_PHRASES: readonly string[] = Object.freeze([
  "already written", "repeat", "rephrase", "extra prose", "must still write", "write the answer", "write your",
]);

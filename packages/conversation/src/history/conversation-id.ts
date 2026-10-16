/** Lexical bucket grammar only. Validation, rollover and empty-base policy stay with callers. */
const DAILY_BUCKET_SUFFIX = /#\d{4}-\d{2}-\d{2}$/u;

export function stripDailyBucketSuffix(conversationId: string): string {
  return conversationId.replace(DAILY_BUCKET_SUFFIX, "");
}

export function hasDailyBucketSuffix(conversationId: string): boolean {
  return DAILY_BUCKET_SUFFIX.test(conversationId);
}

export function belongsToLogicalConversation(conversationId: string, logicalConversationId: string): boolean {
  if (conversationId === logicalConversationId) return true;
  const suffix = DAILY_BUCKET_SUFFIX.exec(conversationId);
  return suffix !== null && suffix.index === logicalConversationId.length
    && conversationId.slice(0, suffix.index) === logicalConversationId;
}

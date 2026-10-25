/** Retrieval output must not recursively become another retained evidence body. */
export function isNestedHistoryTool(name: string): boolean {
  return ["ConversationHistory", "conversation_history", "SessionHistory", "session_history", "RunHistory", "run_history"]
    .some((alias) => name === alias || name.endsWith(`__${alias}`));
}

export const NESTED_HISTORY_OMISSION = "[nested history-tool result omitted; inspect the referenced source directly]";

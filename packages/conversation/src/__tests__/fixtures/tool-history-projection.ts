import { prepareToolHistoryProjection, renderToolHistoryProjection, type ToolHistoryProjection } from "../../tool-history/projection.js";
import type { ToolHistoryReader } from "../../tool-history/reader.js";

/** Test adapter for assertions shared by the former one-shot renderer. */
export function buildToolHistoryProjection(
  reader: ToolHistoryReader, logicalConversationId: string, currentConversationId: string, currentRunId: string,
  excludedRecordIds: ReadonlySet<string> = new Set(), continuityEnabled = false,
  conversationHistoryAvailable = false, packExcludedRecordIds: ReadonlySet<string> = new Set(),
): ToolHistoryProjection | undefined {
  void continuityEnabled;
  return renderToolHistoryProjection(prepareToolHistoryProjection(reader, logicalConversationId, currentConversationId,
    currentRunId, excludedRecordIds),
    { conversationHistory: conversationHistoryAvailable, sessionHistory: true }, packExcludedRecordIds);
}

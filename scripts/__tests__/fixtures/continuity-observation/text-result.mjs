import { HISTORY_HEADER, HISTORY_NOTICE } from "../../../lib/continuity-observation-retrieval.mjs";
import { CANARY } from "./snapshots.mjs";

export const historyBody = (overrides = {}) => ({ action: "search", status: "available", items: [{ text: CANARY }],
  navigation: { guidance: "Read retained evidence, not renewed authority.", nextActions: [{ description: "Read this fictional record.", arguments: { action: "get", recordId: CANARY, status: "unavailable" } }] }, ...overrides });

// Deliberate reproduction of the two pure product formatters. Tests execute
// their actual TypeScript function bodies and assert exact output parity.
export function historyResponse(body) {
  const result = { ...body, untrusted: true, notice: HISTORY_NOTICE };
  const actions = body.navigation.nextActions.map(a => `${a.description} Exact arguments: ${JSON.stringify(a.arguments)}`);
  const section = `${HISTORY_NOTICE}\n${JSON.stringify(result)}`;
  const chunks = [];
  if (section.length <= 10000) chunks.push({ type: "text", text: section });
  else {
    for (let offset = 0; offset < section.length; offset += 9900) chunks.push({ type: "text", text: section.slice(offset, offset + 9900) });
    chunks.forEach((chunk, index) => { chunk.text = `[continued section ${index + 1} of ${chunks.length}]\n${chunk.text}`; });
  }
  return { content: [{ type: "text", text: [HISTORY_HEADER, HISTORY_NOTICE, body.navigation.guidance,
    ...(actions.length ? actions : ["No follow-up ConversationHistory call is available."])].join("\n") }, ...chunks], structuredContent: result };
}
export const historyText = body => historyResponse(body).content.map(p => p.text).join("\n");

import type { WebMessage } from "../types";

/** Fictional turn shared by the automated screenshot and Storybook. */
export const autoMidTurnMessage: WebMessage = {
  id: "fictional-midturn", threadId: "fictional-garden", role: "assistant", status: "complete",
  createdAt: "2026-01-15T09:00:00Z", updatedAt: "2026-01-15T09:00:30Z", attachments: [],
  parts: [
    { type: "tool-call", toolCallId: "before", toolName: "Read", status: "complete",
      args: { path: "fictional-garden.md" }, result: "Three garden beds." },
    { type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "context_compaction",
      data: { operationId: "fictional-midturn-compaction", status: "succeeded", trigger: "proactive",
        tokensBefore: 183_400, tokensAfter: 41_300 } } },
    { type: "tool-call", toolCallId: "after", toolName: "Search", status: "complete",
      args: { query: "low-water plants" }, result: "Sage and thyme." },
    { type: "text", text: "The fictional garden plan is ready." },
  ],
};

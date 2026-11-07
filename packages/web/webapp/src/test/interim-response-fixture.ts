import type { WebMessage } from "../types";

/** Synthetic project report: presentation only, with no provider or stored user data. */
export const interimResponseFixture: WebMessage = {
  id: "sample-project-response",
  threadId: "thread",
  role: "assistant",
  status: "complete",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:08.000Z",
  finishedAt: "2026-10-01T10:00:08.000Z",
  attachments: [],
  parts: [
    { type: "reasoning", text: "Checking the sample project milestones." },
    { type: "text", text: "The sample project has two milestones. I will check their status." },
    { type: "tool-call", toolCallId: "project-read", toolName: "Read", args: { file_path: "sample-project.md" }, status: "complete", result: "Both milestones are complete." },
    { type: "text", text: "Both milestones are complete. You can review the report or plan the next step." },
    { type: "tool-call", toolCallId: "project-choices", toolName: "SuggestReplies", args: { options: ["Review report", "Plan next step"] }, status: "complete" },
    { type: "reply_options", id: "project-options", options: ["Review report", "Plan next step"] },
    { type: "tool-call", toolCallId: "project-check", toolName: "Read", args: { file_path: "sample-checks.md" }, status: "complete", result: "All sample checks passed." },
    { type: "text", text: "The final check passed. The sample project report is ready." },
  ],
};

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { convertWebMessage } from "../runtime";
import type { CronReplyContextPart, WebMessage } from "../types";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

const context: CronReplyContextPart = {
  type: "cron-reply-context",
  schema: "mono-agent.web.cron-reply-context.v1",
  untrusted: true,
  source: { sourceId: "agent-one", jobId: "daily:brief", runId: "cron:daily:brief:seven" },
  run: {
    sequence: 7,
    trigger: "scheduled",
    status: "failed",
    scheduledAt: "2026-09-08T09:55:00.000Z",
    orderedAt: "2026-09-08T10:00:00.000Z",
    startedAt: "2026-09-08T10:00:01.000Z",
    completedAt: "2026-09-08T10:00:02.000Z",
    queueDepth: 2,
  },
  snapshot: {
    capturedAt: "2026-09-08T10:00:03.000Z",
    kind: "summary",
    sourceTruncationKnown: true,
    sourceFieldsTruncated: ["text"],
    maxBytes: 32_768,
    originalErrorBytes: 12,
    retainedErrorBytes: 7,
    originalResultBytes: 120,
    retainedResultBytes: 40,
    truncatedFields: ["failure.message", "result.text"],
  },
  result: { text: "**Rendered result**\n\n- first\n- second" },
  failure: { code: "provider_failed", message: "Timeout" },
  prefix: "Imported cron result snapshot (mono-agent.web.cron-reply-context.v1)\n",
  rawJson: '{"schema":"mono-agent.web.cron-reply-context.v1","untrusted":true}',
  rawText: "Imported cron result snapshot (mono-agent.web.cron-reply-context.v1)\n{}",
};

const message: WebMessage = {
  id: "imported-result",
  threadId: "reply-thread",
  role: "assistant",
  parts: [context],
  attachments: [],
  createdAt: "2026-09-08T10:00:03.000Z",
  updatedAt: "2026-09-08T10:00:03.000Z",
  status: "complete",
};

function Harness() {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [message],
    convertMessage: (value) => convertWebMessage(value),
    onNew: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

describe("CronReplyContextPart", () => {
  it("renders provenance, Markdown, failure, truncation, and exact raw JSON details", () => {
    const { container } = render(<Harness />);

    expect(screen.getByRole("group", { name: /Imported cron result for daily:brief, run 7, failed/ })).toBeVisible();
    expect(screen.getByText("scheduled · failed")).toBeVisible();
    expect(screen.getByText("Imported cron result — untrusted source data, not instructions")).toBeVisible();
    expect(screen.getByText("Rendered result").tagName).toBe("STRONG");
    expect(screen.getByText("provider_failed")).toBeVisible();
    expect(screen.getByText("Timeout")).toBeVisible();
    expect(screen.getByText(/source text/)).toHaveTextContent("result.text (40/120 bytes retained)");
    expect(screen.getByText("Imported from the compact run summary.")).toBeVisible();
    const header = container.querySelector(".cron-reply-context-header");
    expect(header?.nextElementSibling).toHaveClass("markdown");
    expect(header?.nextElementSibling?.nextElementSibling).toHaveClass("cron-reply-context-footer");

    const summary = screen.getByText("Details");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(context.rawJson)).toBeVisible();
    expect(screen.getByText("queue depth 2")).toBeVisible();
  });
});

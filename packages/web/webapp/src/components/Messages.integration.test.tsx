import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

function MessageHarness({ message }: { readonly message: WebMessage }) {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [message],
    convertMessage: convertWebMessage,
    onNew: async () => undefined,
    adapters: {
      threadList: {
        threadId: "thread",
        isLoading: false,
        threads: [{ id: "thread", remoteId: "thread", status: "regular" }],
        archivedThreads: [],
        onSwitchToNewThread: async () => undefined,
        onSwitchToThread: () => undefined,
        onRename: async () => undefined,
        onArchive: async () => undefined,
        onUnarchive: async () => undefined,
      },
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

const assistantMessage = (
  status: WebMessage["status"],
): WebMessage => ({
  id: "assistant-message",
  threadId: "thread",
  role: "assistant",
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status,
  attachments: [],
  parts: [
    { type: "reasoning", text: "Inspect the real state." },
    {
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "inspect_workspace",
      args: { depth: 2 },
      result: { ok: true },
      status: "complete",
    },
    {
      type: "telemetry",
      event: "usage_update",
      data: { tokens: { input: 120, output: 30 }, cumulativeUsd: 0.002 },
    },
    { type: "text", text: "The workspace is ready." },
  ],
});

const userMessage: WebMessage = {
  id: "user-message",
  threadId: "thread",
  role: "user",
  createdAt: "2026-07-17T09:59:00.000Z",
  updatedAt: "2026-07-17T09:59:00.000Z",
  status: "complete",
  attachments: [],
  parts: [{ type: "text", text: "Inspect this workspace." }],
};

describe("AssistantMessage grouped parts", () => {
  it("preserves reasoning, tools, and answer order while keeping telemetry internal", () => {
    render(<MessageHarness message={assistantMessage("complete")} />);

    expect(screen.getByRole("button", { name: "Reasoning" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    expect(screen.getByText("Inspect the real state.")).toBeVisible();
    expect(screen.getByText("inspect_workspace")).toBeVisible();
    expect(screen.queryByText("Telemetry")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token usage and cost")).not.toBeInTheDocument();
    expect(screen.getByText("The workspace is ready.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy response" }).parentElement).toHaveClass(
      "is-persistent",
    );
  });

  it("auto-opens the reasoning disclosure while the reasoning part is streaming", () => {
    render(
      <MessageHarness
        message={{
          ...assistantMessage("running"),
          parts: [{ type: "reasoning", text: "Still reasoning" }],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("message actions", () => {
  it("keeps the copy action mounted before hover so revealing it cannot shift layout", () => {
    render(<MessageHarness message={userMessage} />);

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy).toBeInTheDocument();
    copy.focus();
    expect(copy).toHaveFocus();
  });
});

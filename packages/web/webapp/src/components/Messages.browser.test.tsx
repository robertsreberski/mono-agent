import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { convertWebMessage } from "../runtime";
import type { ProcessJobActivityEvent } from "../process-job-presentation";
import type { WebMessage } from "../types";
import "../styles.css";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

vi.mock("../console-store", () => ({
  useConsoleStore: () => ({
    connection: "live",
    effectiveModel: "provider:primary",
    loadCronRunActivity: vi.fn(),
    selectedAgent: null,
    selectedThread: null,
    transcriptMovedAt: 0,
  }),
  useUploadLimits: () => ({
    maxFileBytes: 20,
    maxFilesPerTurn: 10,
    maxTurnBytes: 100,
    accept: ["image/png"],
  }),
}));

const message = (id: string, liveInputStatus: "applied" | "uncertain"): WebMessage => ({
  id,
  threadId: "thread",
  role: "user",
  createdAt: "2026-09-07T10:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
  status: "complete",
  liveInputStatus,
  attachments: [],
  parts: [{ type: "text", text: `Follow-up ${id}` }],
});

function Harness({ width }: { readonly width: number }) {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [message("consumed", "applied"), message("uncertain", "uncertain")],
    convertMessage: (value) => convertWebMessage(value, { selectedModel: "provider:primary" }),
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
    <div style={{ width, minHeight: 320 }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

function ActivityHarness({ width }: { readonly width: number }) {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const events: readonly ProcessJobActivityEvent[] = [
    {
      schema: "mono-agent.process-job-activity-event.v1",
      id: `process-job:${jobId}:started`,
      toolCallId: "launch",
      jobId,
      tool: "Exec",
      summary: "a deliberately long background task summary that must remain on one compact row",
      phase: "started",
      state: "succeeded",
      occurredAt: "2026-09-07T10:00:01.000Z",
    },
    {
      schema: "mono-agent.process-job-activity-event.v1",
      id: `process-job:${jobId}:terminal`,
      toolCallId: "launch",
      jobId,
      tool: "Exec",
      summary: "a deliberately long background task summary that must remain on one compact row",
      phase: "terminal",
      state: "succeeded",
      occurredAt: "2026-09-07T10:00:03.000Z",
      durationMs: 2_000,
      exitCode: 0,
    },
  ];
  const response: WebMessage = {
    id: "response",
    threadId: "thread",
    role: "assistant",
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:03.000Z",
    finishedAt: "2026-09-07T10:00:03.000Z",
    status: "complete",
    attachments: [],
    parts: [
      { type: "reasoning", text: "Launching the worker." },
      { type: "tool-call", toolCallId: "launch", toolName: "Exec", status: "complete" },
      { type: "text", text: "Finished." },
    ],
  };
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [response],
    convertMessage: (value) => convertWebMessage(value, { processJobEvents: events }),
    onNew: async () => undefined,
  });
  return (
    <div style={{ width, minHeight: 320 }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

describe("live-input settlement labels in Chromium", () => {
  it.each([
    [1440, "desktop"],
    [390, "mobile"],
  ] as const)("renders truthful no-retry status at %ipx (%s)", (width, _label) => {
    render(<Harness width={width} />);

    const consumed = screen.getByText("Consumed by current run");
    const uncertain = screen.getByText("Delivery uncertain — not retried");
    expect(consumed).toBeVisible();
    expect(uncertain).toBeVisible();
    expect(consumed.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(uncertain.getBoundingClientRect().right).toBeLessThanOrEqual(width);
  });
});

describe("process-job response Activity in Chromium", () => {
  it.each([760, 360] as const)("keeps causal lifecycle rows inside the %ipx response", (width) => {
    const { container } = render(<ActivityHarness width={width} />);
    const activity = screen.getByRole("button", { name: "Activity" });
    expect(activity).toHaveTextContent("4 steps");
    fireEvent.click(activity);
    const rows = [
      screen.getByRole("group", { name: "Exec job started" }),
      screen.getByRole("group", { name: "Exec job succeeded" }),
    ];
    const messageRoot = container.querySelector<HTMLElement>(".message-assistant")!;
    for (const row of rows) {
      expect(row.getBoundingClientRect().left).toBeGreaterThanOrEqual(messageRoot.getBoundingClientRect().left);
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(messageRoot.getBoundingClientRect().right);
    }
    expect(messageRoot.scrollWidth).toBeLessThanOrEqual(messageRoot.clientWidth);
    expect(screen.getAllByRole("button", { name: "Copy response" })).toHaveLength(1);
  });
});

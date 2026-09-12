import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import { coalesceMonitorWakeMessages, convertWebMessage } from "../runtime";
import { projectProcessJobPresentation } from "../process-job-presentation";
import type { ProcessJobActivityEvent } from "../process-job-presentation";
import type { WebMessage } from "../types";
import "../styles.css";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

/**
 * Screenshot evidence is opt-in: `VITE_STEER_INLINE_SHOTS=<absolute dir>`
 * captures the split transcript, and CI runs the same assertions without it.
 */
const shotDirectory = import.meta.env.VITE_STEER_INLINE_SHOTS as string | undefined;

const capture = async (name: string): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.screenshot({ path: `${shotDirectory}/${name}.png` });
};

const consoleStoreMock = vi.hoisted(() => ({
  current: {
    connection: "live",
    cronReplyState: vi.fn(() => ({ status: "idle" as const })),
    effectiveModel: "provider:primary",
    loadCronRunActivity: vi.fn(),
    replyToCronRun: vi.fn().mockResolvedValue(undefined),
    selectedAgent: null,
    selectedThread: null as null | {
      sourceId: string;
      trigger: { kind: "cron"; jobId: string; configured: boolean };
    },
    transcriptMovedAt: 0,
  },
}));

vi.mock("../console-store", () => ({
  useConsoleStore: () => consoleStoreMock.current,
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

const cronMessage: WebMessage = {
  id: "cron-result",
  threadId: "cron-thread",
  role: "assistant",
  createdAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:02.000Z",
  status: "complete",
  attachments: [],
  parts: [{
    type: "telemetry",
    event: "cron_run",
    data: {
      projection: "summary",
      runId: "cron:daily:report:one",
      jobId: "daily:report",
      scheduledAt: "2026-09-08T10:00:00.000Z",
      orderedAt: "2026-09-08T10:00:01.000Z",
      sequence: 1,
      trigger: "scheduled",
      status: "succeeded",
      eventCount: 1,
      conversationId: "cron:daily:report",
    },
  }],
};

const cronReplyMessage: WebMessage = {
  id: "imported-cron-result",
  threadId: "reply-thread",
  role: "assistant",
  createdAt: "2026-09-08T10:00:03.000Z",
  updatedAt: "2026-09-08T10:00:03.000Z",
  status: "complete",
  attachments: [],
  parts: [{
    type: "cron-reply-context",
    schema: "mono-agent.web.cron-reply-context.v1",
    untrusted: true,
    source: { sourceId: "alpha", jobId: "daily:report", runId: "cron:daily:report:one" },
    run: {
      sequence: 1,
      trigger: "scheduled",
      status: "succeeded",
      scheduledAt: "2026-09-08T10:00:00.000Z",
      orderedAt: "2026-09-08T10:00:01.000Z",
      completedAt: "2026-09-08T10:00:02.000Z",
    },
    snapshot: {
      capturedAt: "2026-09-08T10:00:03.000Z",
      kind: "summary",
      sourceTruncationKnown: true,
      sourceFieldsTruncated: [],
      maxBytes: 32_768,
      originalErrorBytes: 0,
      retainedErrorBytes: 0,
      originalResultBytes: 16,
      retainedResultBytes: 16,
      truncatedFields: [],
    },
    result: { text: "**Digest ready.**" },
    failure: {},
    prefix: "Imported cron result snapshot (mono-agent.web.cron-reply-context.v1)\n",
    rawJson: '{"schema":"mono-agent.web.cron-reply-context.v1"}',
    rawText: "Imported cron result snapshot (mono-agent.web.cron-reply-context.v1)\n{}",
  }],
};

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

function ErrorHarness({ width, errorMessage }: { readonly width: number; readonly errorMessage: string }) {
  const response: WebMessage = {
    id: "failed-response",
    threadId: "thread",
    role: "assistant",
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:01.000Z",
    finishedAt: "2026-09-10T10:00:01.000Z",
    status: "complete",
    attachments: [],
    parts: [{ type: "error", code: "AGENT_ERROR", message: errorMessage }],
  };
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [response],
    convertMessage: (value) => convertWebMessage(value),
    onNew: async () => undefined,
  });
  return (
    <div style={{ width, minHeight: 200 }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

function CronHarness({ width }: { readonly width: number }) {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [cronMessage],
    convertMessage: (value) => convertWebMessage(value, { selectedModel: "provider:primary" }),
    onNew: async () => undefined,
  });
  return (
    <div style={{ width, minHeight: 200 }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

function CronReplyHarness({ width }: { readonly width: number }) {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [cronReplyMessage],
    convertMessage: (value) => convertWebMessage(value),
    onNew: async () => undefined,
  });
  return (
    <div style={{ width, minHeight: 240 }}>
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

describe("agent error presentation in Chromium", () => {
  it("wraps one unbroken path inside a narrow response", () => {
    const path = `/Users/example/${"single-unbroken-path-segment".repeat(20)}/result.json`;
    const { container } = render(<ErrorHarness width={360} errorMessage={path} />);
    const error = screen.getByRole("alert");
    const messageRoot = container.querySelector<HTMLElement>(".message-assistant")!;

    expect(error).toHaveTextContent(path);
    expect(error.scrollWidth).toBeLessThanOrEqual(error.clientWidth);
    expect(messageRoot.scrollWidth).toBeLessThanOrEqual(messageRoot.clientWidth);
  });
});

describe("cron Reply footer in Chromium", () => {
  it.each([760, 360] as const)("keeps Reply, status, and time visible with accessible Details at %ipx", (width) => {
    consoleStoreMock.current.selectedThread = {
      sourceId: "alpha",
      trigger: { kind: "cron", jobId: "daily:report", configured: true },
    };
    const { container } = render(<CronHarness width={width} />);

    const reply = screen.getByRole("button", { name: "Reply" });
    expect(reply).toBeVisible();
    expect(screen.getByText("scheduled · completed")).toBeVisible();
    expect(container.querySelector("time")).toBeVisible();
    const details = screen.getByText("Details");
    expect(details).toBeVisible();
    fireEvent.click(details);
    expect(screen.getByRole("button", { name: /Copy originating session/ })).toBeVisible();
    fireEvent.click(reply);
    expect(consoleStoreMock.current.replyToCronRun).toHaveBeenCalledWith({
      sourceId: "alpha",
      jobId: "daily:report",
      runId: "cron:daily:report:one",
      snapshotKind: "summary",
    });
    const row = screen.getByRole("group", { name: /Cron run/ });
    expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });
});

describe("imported cron Reply context in Chromium", () => {
  it.each([760, 360] as const)("keeps the context card and Details within %ipx", (width) => {
    const { container } = render(<CronReplyHarness width={width} />);

    expect(screen.getByText("Digest ready.")).toBeVisible();
    const summary = screen.getByText("Details");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByText(cronReplyMessage.parts[0]?.type === "cron-reply-context"
      ? cronReplyMessage.parts[0].rawJson
      : "missing")).toBeVisible();
    const messageRoot = container.querySelector<HTMLElement>(".message-assistant")!;
    expect(messageRoot.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(messageRoot.scrollWidth).toBeLessThanOrEqual(messageRoot.clientWidth);
  });
});

const steerText = "Use the API instead — the sync path deadlocks under load, and the retry budget is already spent";

const steeredUser: WebMessage = {
  id: "steered-user",
  threadId: "thread",
  role: "user",
  createdAt: "2026-09-12T10:00:01.000Z",
  updatedAt: "2026-09-12T10:00:02.000Z",
  status: "complete",
  liveInputStatus: "applied",
  attachments: [],
  parts: [{ type: "text", text: steerText }],
};

const steeredResponse: WebMessage = {
  id: "steered-response",
  threadId: "thread",
  role: "assistant",
  createdAt: "2026-09-12T10:00:00.000Z",
  updatedAt: "2026-09-12T10:00:05.000Z",
  finishedAt: "2026-09-12T10:00:05.000Z",
  status: "complete",
  attachments: [],
  parts: [
    { type: "reasoning", text: "Reading the workspace first." },
    { type: "tool-call", toolCallId: "read-1", toolName: "Read", status: "complete" },
    {
      type: "steer",
      inputId: "input-1",
      messageId: "steered-user",
      text: steerText,
      receivedAt: "2026-09-12T10:00:01.000Z",
      quote: { text: "the sync approach", messageId: "assistant-source" },
    },
    { type: "tool-call", toolCallId: "write-1", toolName: "Write", status: "complete" },
    { type: "text", text: "Applied the API approach throughout." },
  ],
};

function SteerHarness({ width }: { readonly width: number }) {
  const presentation = projectProcessJobPresentation(
    coalesceMonitorWakeMessages([steeredUser, steeredResponse]),
    { selectedModel: "provider:primary", threadId: "thread" },
  );
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: presentation.messages,
    convertMessage: (value) => convertWebMessage(value, {
      selectedModel: "provider:primary",
      processJobEvents: presentation.eventsByMessageId.get(value.id),
      processJobs: presentation.jobsById,
    }),
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

describe("inline steer in Chromium", () => {
  it.each([
    [1280, 800, "desktop"],
    [390, 844, "mobile"],
  ] as const)("splits Activity around the consumed steer at %ipx (%s)", async (width, height, label) => {
    await page.viewport(width, height);
    const { container } = render(<SteerHarness width={Math.min(width, 760)} />);

    // The duplicate standalone bubble is gone; the inline one keeps everything.
    expect(screen.getByRole("group", { name: "Steered follow-up" })).toBeVisible();
    expect(screen.getByText(steerText)).toBeVisible();
    expect(screen.getByText("the sync approach")).toBeVisible();
    expect(screen.queryByText(/Steered:/u)).toBeNull();
    expect(screen.getByText("Applied the API approach throughout.")).toBeVisible();
    const bands = screen.getAllByRole("button", { name: "Activity" });
    expect(bands).toHaveLength(2);
    for (const band of bands) fireEvent.click(band);
    expect(screen.getByText("Read")).toBeVisible();
    expect(screen.getByText("Write")).toBeVisible();
    const messageRoot = container.querySelector<HTMLElement>(".message-assistant")!;
    expect(messageRoot.scrollWidth).toBeLessThanOrEqual(messageRoot.clientWidth);
    await capture(`steer-inline-${label}-${width}x${height}`);
  });
});

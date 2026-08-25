import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { processJob } from "../test/fixtures";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_compaction",
        data: {
          operationId: "compact-1",
          status: "succeeded",
          sdk: "pi",
          trigger: "proactive",
          tokensBefore: 80_000,
          tokensAfter: 20_000,
          tokenCountsExact: false,
        },
      },
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
  it("shows the delivery state for live follow-up user messages", () => {
    render(<MessageHarness message={{ ...userMessage, liveInputStatus: "applied" }} />);

    expect(screen.getByText("Applied to current run")).toBeVisible();
  });

  it("renders an applied live follow-up as a completed Steered tool activity", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        {
          type: "tool-call",
          toolCallId: "live-input:follow-up-1",
          toolName: "↪️ Steered: “Use the API instead”",
          result: "Applied to current run",
          status: "complete",
        },
        { type: "text", text: "Done." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const toolName = screen.getByText("↪️ Steered: “Use the API instead”");
    expect(toolName).toBeVisible();
    expect(screen.getByText("done")).toBeVisible();
    fireEvent.click(toolName.closest("summary")!);
    expect(screen.getByText('"Applied to current run"')).toBeVisible();
  });

  it("uses the canonical terminal state but keeps successful persistence bookkeeping out of the transcript", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        {
          type: "tool-call",
          toolCallId: "tool-history",
          toolName: "Bash",
          args: { command: "slow-command" },
          result: "bounded output",
          status: "failed",
          history: {
            recordId: "sth1_result",
            sequence: 2,
            persistence: "persisted",
            terminalState: "timeout",
            truncated: true,
            originalBytes: 30_000,
            retainedBytes: 16_000,
            artifactReferences: [{ id: "stha1_output", available: false }],
            untrusted: true,
          },
        },
        { type: "text", text: "The command timed out." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("timeout")).toBeVisible();
    fireEvent.click(screen.getByText("Bash").closest("summary")!);
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.queryByText(/sth1_result/u)).toBeNull();
    expect(screen.queryByText(/untrusted historical data/iu)).toBeNull();
  });

  it("surfaces a lost history record, because the tool's output is gone for good", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        {
          type: "tool-call",
          toolCallId: "tool-history-failed",
          toolName: "Bash",
          args: { command: "slow-command" },
          result: "bounded output",
          status: "complete",
          history: {
            recordId: "sth1_result",
            sequence: 2,
            persistence: "failed",
            errorCode: "history_writer_closed",
            untrusted: true,
          },
        },
        { type: "text", text: "The command finished." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByText("Bash").closest("summary")!);
    expect(
      screen.getByText("Tool history for this call was not saved (history_writer_closed)."),
    ).toBeVisible();
    expect(screen.queryByText(/sth1_result/u)).toBeNull();
  });

  it("preserves reasoning, tools, and answer order while keeping telemetry internal", () => {
    render(<MessageHarness message={assistantMessage("complete")} />);

    expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByText("Thinking").closest("summary")!);
    expect(screen.getByText("Inspect the real state.")).toBeVisible();
    expect(screen.getByText("inspect_workspace")).toBeVisible();
    expect(screen.getByRole("status", {
      name: "Context compacted, proactive, ~80k → ~20k tokens",
    })).toBeVisible();
    expect(screen.queryByText("Telemetry")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token usage and cost")).not.toBeInTheDocument();
    expect(screen.getByText("The workspace is ready.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy response" }).parentElement).toHaveClass(
      "is-persistent",
    );
  });

  it("clusters repeated tools with step counts, durations, previews, and failures", () => {
    const calls: WebMessage["parts"] = ["one.md", "two.md", "three.md", "four.md"].map((path, index) => ({
      type: "tool-call" as const,
      toolCallId: `read-${String(index)}`,
      toolName: "read_file",
      args: { path },
      result: index === 2 ? { error: "unreadable" } : { text: path },
      status: index === 2 ? "failed" as const : "complete" as const,
      executionMs: 100,
    }));
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [...calls, { type: "text", text: "Finished." }],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("4 steps · 400ms")).toBeVisible();
    expect(screen.getByText("Read ×4")).toBeVisible();
    expect(screen.getByText("one.md, two.md +2")).toBeVisible();
    expect(screen.getByText("1 failed")).toBeVisible();

    fireEvent.click(screen.getByText("Read ×4").closest("summary")!);
    expect(screen.getAllByText("read_file")).toHaveLength(4);
    fireEvent.click(screen.getAllByText("read_file")[2]!.closest("summary")!);
    expect(screen.getByText("unreadable", { exact: false })).toBeVisible();
  });

  it("collects a settled turn's interleaved work into one Activity block over the answer", () => {
    const { container } = render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        { type: "text", text: "Let me look at the inbox." },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "read_inbox",
          args: {},
          result: { ok: true },
          status: "complete",
        },
        { type: "text", text: "Now the calendar." },
        {
          type: "tool-call",
          toolCallId: "tool-2",
          toolName: "read_calendar",
          args: {},
          result: { ok: true },
          status: "complete",
        },
        { type: "text", text: "Here is the summary." },
      ],
    }} />);

    // One disclosure, not one per band of prose the model wrote mid-turn.
    expect(container.querySelectorAll(".activity-root")).toHaveLength(1);
    const answer = screen.getByText("Here is the summary.");
    expect(answer).toBeVisible();
    expect(answer.closest(".activity-root")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const activity = container.querySelector(".activity-root")!;
    expect(within(activity as HTMLElement).getByText("Let me look at the inbox.")).toBeVisible();
    expect(within(activity as HTMLElement).getByText("Now the calendar.")).toBeVisible();
    expect(within(activity as HTMLElement).getByText("read_inbox")).toBeVisible();
    expect(within(activity as HTMLElement).getByText("read_calendar")).toBeVisible();
  });

  it("copies the answer alone, not the narration folded into the activity log", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        { type: "text", text: "Let me look at the inbox." },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "read_inbox",
          args: {},
          result: { ok: true },
          status: "complete",
        },
        { type: "text", text: "Here is the summary." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("Here is the summary.");
    vi.unstubAllGlobals();
  });

  it("updates a live compaction row in place and marks a dangling row interrupted", async () => {
    const compaction = (status: "running" | "succeeded") => ({
      type: "telemetry" as const,
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_compaction",
        data: { operationId: "compact-live", status, sdk: "codex", trigger: "automatic" },
      },
    });
    const runningMessage: WebMessage = {
      ...assistantMessage("running"),
      parts: [compaction("running")],
    };
    const { rerender } = render(<MessageHarness message={runningMessage} />);

    expect(screen.getByRole("status", { name: "Compacting context" })).toBeVisible();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<MessageHarness message={{
      ...runningMessage,
      updatedAt: "2026-07-17T10:00:01.000Z",
      parts: [compaction("succeeded")],
    }} />);
    expect(await screen.findByRole("status", { name: "Context compacted" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "Compacting context" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<MessageHarness message={{
      ...runningMessage,
      status: "interrupted",
      updatedAt: "2026-07-17T10:00:02.000Z",
    }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
    expect(await screen.findByRole("status", { name: "Context compaction interrupted" })).toBeVisible();
  });

  it("keeps activity open while completed tool entries arrive in a running message", async () => {
    const runningMessage: WebMessage = {
      ...assistantMessage("running"),
      parts: [
        { type: "reasoning", text: "Still reasoning" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "first_completed_tool",
          args: {},
          result: { ok: true },
          status: "complete",
        },
      ],
    };
    const { rerender } = render(<MessageHarness message={runningMessage} />);

    const trigger = screen.getByRole("button", { name: "Activity in progress" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    rerender(
      <MessageHarness
        message={{
          ...runningMessage,
          updatedAt: "2026-07-17T10:00:01.000Z",
          parts: [
            ...runningMessage.parts,
            {
              type: "tool-call",
              toolCallId: "tool-2",
              toolName: "second_completed_tool",
              args: {},
              result: { ok: true },
              status: "complete",
            },
          ],
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Activity in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(await screen.findByText("second_completed_tool")).toBeVisible();
  });

  it.each(["complete", "failed", "cancelled", "interrupted"] as const)(
    "collapses activity when the parent message becomes %s and allows reopening",
    async (status) => {
      const runningMessage: WebMessage = {
        ...assistantMessage("running"),
        parts: [
          { type: "reasoning", text: "Still reasoning" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "completed_tool",
            args: {},
            result: { ok: true },
            status: "complete",
          },
        ],
      };
      const { rerender } = render(<MessageHarness message={runningMessage} />);

      expect(screen.getByRole("button", { name: "Activity in progress" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );

      rerender(
        <MessageHarness
          message={{
            ...runningMessage,
            status,
            updatedAt: "2026-07-17T10:00:01.000Z",
          }}
        />,
      );

      const settledTrigger = await screen.findByRole("button", { name: "Activity" });
      expect(settledTrigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(settledTrigger);
      expect(settledTrigger).toHaveAttribute("aria-expanded", "true");
    },
  );
});

describe("message actions", () => {
  it("renders one durable process-job card with its rich reply siblings", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        { type: "process-job", job: processJob(), responseText: "Completed normally." },
        {
          type: "attachment",
          id: "job-attachment",
          artifactId: "job-artifact",
          name: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
          integrityId: `sha256:${"a".repeat(64)}`,
        },
        {
          type: "mcp_app",
          id: "11111111-1111-4111-8111-111111111111",
          invocationId: "11111111-1111-4111-8111-111111111111",
          connectionId: "job-connection",
          serverName: "widgets",
          toolName: "show_chart",
          resourceUri: "ui://widgets/chart",
          mediaType: "text/html;profile=mcp-app",
          protocolVersion: "2026-01-26",
          title: "Job chart",
        },
        { type: "failure", id: "job-failure", code: "artifact_missing", message: "File expired." },
      ],
    }} />);

    expect(screen.getByRole("region", { name: "Exec background job succeeded" })).toBeVisible();
    expect(screen.getByText("node worker.js --safe-summary")).toBeVisible();
    expect(screen.getByText("2 s")).toBeVisible();
    expect(screen.getByText("Completed normally.")).toBeVisible();
    expect(screen.getByRole("region", { name: "File attachment: report.txt" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Interactive app: Job chart" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("artifact_missing");
    expect(screen.getByRole("alert")).toHaveTextContent("File expired.");
    const disclosure = screen.getByText("Output");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
  });

  it("polls only one job with backoff and stops after the terminal projection", async () => {
    vi.useFakeTimers();
    const complete = processJob();
    const running = processJob({
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      exitCode: null,
      durationMs: null,
    });
    const threadJob = vi.spyOn(api, "threadJob")
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValue(complete);
    render(<MessageHarness message={{
      ...assistantMessage("running"),
      parts: [{ type: "process-job", job: running }],
    }} />);

    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);
    expect(threadJob).toHaveBeenLastCalledWith("thread", running.jobId, expect.any(AbortSignal));
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("region", { name: "Exec background job succeeded" })).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(3);
  });

  it("keeps the copy action mounted before hover so revealing it cannot shift layout", () => {
    render(<MessageHarness message={userMessage} />);

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy).toBeInTheDocument();
    copy.focus();
    expect(copy).toHaveFocus();
  });

  it("renders a persisted quote separately from the authored message", () => {
    render(<MessageHarness message={{
      ...userMessage,
      quote: { text: "The earlier response", messageId: "assistant-source" },
    }} />);

    expect(screen.getByText("The earlier response")).toBeVisible();
    expect(screen.getByText("Inspect this workspace.")).toBeVisible();
  });
});

const markdownMessage = (text: string): WebMessage => ({
  ...assistantMessage("complete"),
  parts: [{ type: "text", text }],
});

const ALIGNED_TABLE = "| Agent | Status |\n| --- | ---: |\n| alpha | ready |\n";

describe("GitHub-Flavored Markdown rendering", () => {
  it("renders a pipe table as a real table inside a focusable scroll wrapper", () => {
    render(<MessageHarness message={markdownMessage(ALIGNED_TABLE)} />);

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Agent" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "ready" })).toBeVisible();
    expect(screen.queryByText(/\| Agent \| Status \|/)).not.toBeInTheDocument();

    expect(table.parentElement).toHaveClass("markdown-table");
    expect(table.parentElement).toHaveAttribute("tabindex", "0");
  });

  // Alignment arrives as an inline style, which outranks the stylesheet's
  // default `text-align: left` on its own. Assert it so a renderer upgrade that
  // switches back to the presentational `align` attribute cannot silently drop
  // alignment behind that default.
  it("keeps GFM column alignment", () => {
    render(<MessageHarness message={markdownMessage(ALIGNED_TABLE)} />);

    expect(screen.getByRole("columnheader", { name: "Status" })).toHaveStyle({ textAlign: "right" });
    expect(screen.getByRole("cell", { name: "ready" })).toHaveStyle({ textAlign: "right" });
    expect(screen.getByRole("columnheader", { name: "Agent" })).not.toHaveStyle({ textAlign: "right" });
  });

  it("renders task lists and strikethrough", () => {
    render(<MessageHarness message={markdownMessage("- [x] shipped\n- [ ] pending\n\n~~dropped~~\n")} />);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(screen.getByText("dropped").tagName).toBe("DEL");
  });

  // Enabling GFM must not enable raw HTML: no rehype-raw is configured, so
  // markup in a reply stays escaped text and GFM's tagfilter never has to run.
  it("escapes raw HTML in a reply instead of rendering it", () => {
    render(<MessageHarness message={markdownMessage(
      "<img src=x onerror=\"alert(1)\"> and <b>bold</b>\n",
    )} />);

    expect(document.querySelector(".markdown img")).toBeNull();
    expect(document.querySelector(".markdown b")).toBeNull();
    expect(screen.getByText(/<b>bold<\/b>/)).toBeVisible();
  });

  it("opens external autolinks outside the standalone console window", () => {
    render(<MessageHarness message={markdownMessage("See https://example.com for details.")} />);

    const link = screen.getByRole("link", { name: "https://example.com" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });
});

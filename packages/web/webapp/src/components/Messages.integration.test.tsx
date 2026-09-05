import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { monitor, processJob } from "../test/fixtures";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";
import { ToolCallRepairProvider } from "./tool-call-repair";

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
  updatedAt: "2026-07-17T10:00:12.000Z",
  ...(status === "running" ? {} : { finishedAt: "2026-07-17T10:00:12.000Z" }),
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

  const upload = (id: string, name: string, kind: "image" | "document", contentType: string) => ({
    id,
    name,
    contentType,
    sizeBytes: 2_048,
    kind,
    status: "committed" as const,
    uploaded: true,
    createdAt: "2026-07-17T10:00:00.000Z",
    contentUrl: `/api/v1/uploads/${id}/content`,
  });

  /**
   * A conversation read is served a preview of a large tool result, so a row
   * has to say so and be able to fetch the rest -- and the fetched message must
   * arrive as a NEW object, because assistant-ui caches its part conversions by
   * object identity.
   */
  function RepairableHarness({
    preview,
    whole,
    onRepair,
  }: {
    readonly preview: WebMessage;
    readonly whole: WebMessage;
    readonly onRepair: (toolCallId: string) => void;
  }) {
    const [message, setMessage] = useState(preview);
    return (
      <ToolCallRepairProvider
        repair={async (toolCallId) => {
          onRepair(toolCallId);
          setMessage(whole);
          return true;
        }}
      >
        <MessageHarness message={message} />
      </ToolCallRepairProvider>
    );
  }

  const truncatedToolMessage = (): WebMessage => ({
    ...assistantMessage("complete"),
    parts: [
      {
        type: "tool-call",
        toolCallId: "tool-big",
        toolName: "Exec",
        args: { command: "run" },
        result: "HEAD-".repeat(4),
        resultTruncated: true,
        resultBytes: 20 * 1_024,
        status: "complete",
      },
      { type: "text", text: "Done." },
    ],
  });

  it("says a tool result is a preview and loads the whole body on request", async () => {
    const repaired = vi.fn();
    const preview = truncatedToolMessage();
    const whole: WebMessage = {
      ...preview,
      parts: [
        {
          type: "tool-call",
          toolCallId: "tool-big",
          toolName: "Exec",
          args: { command: "run" },
          result: "WHOLE-BODY",
          status: "complete",
        },
        { type: "text", text: "Done." },
      ],
    };
    render(<RepairableHarness preview={preview} whole={whole} onRepair={repaired} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByText("Exec").closest("summary")!);
    expect(screen.getByText("Preview only, 20,480 chars.")).toBeVisible();
    expect(screen.queryByText('"WHOLE-BODY"')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    expect(repaired).toHaveBeenCalledWith("tool-big");
    await screen.findByText('"WHOLE-BODY"');
    expect(screen.queryByText("Preview only, 20,480 chars.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load full output" })).toBeNull();
  });

  it("gives one control to a tool call whose input and output were both cut", () => {
    // The route returns the WHOLE part, so one round trip repairs both sides.
    // Two buttons for it read as two different fetches.
    const preview: WebMessage = {
      ...assistantMessage("complete"),
      parts: [
        {
          type: "tool-call",
          toolCallId: "tool-big",
          toolName: "Exec",
          args: { command: "run " },
          argsTruncated: true,
          argsBytes: 8_192,
          result: "HEAD-",
          resultTruncated: true,
          resultBytes: 20 * 1_024,
          status: "complete",
        },
        { type: "text", text: "Done." },
      ],
    };
    render(
      <ToolCallRepairProvider repair={async () => true}>
        <MessageHarness message={preview} />
      </ToolCallRepairProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByText("Exec").closest("summary")!);
    expect(screen.getByText("Preview only, 8,192 chars.")).toBeVisible();
    expect(screen.getByText("Preview only, 20,480 chars.")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Load full output" })).toHaveLength(1);
  });

  it("states the preview without offering a load where there is no way to fetch one", () => {
    render(<MessageHarness message={truncatedToolMessage()} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByText("Exec").closest("summary")!);
    expect(screen.getByText("Preview only, 20,480 chars.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load full output" })).toBeNull();
  });

  it("shows sent images as a gallery while documents keep their file chip", () => {
    render(<MessageHarness message={{
      ...userMessage,
      attachments: [
        upload("one", "first.png", "image", "image/png"),
        upload("two", "brief.pdf", "document", "application/pdf"),
      ],
    }} />);

    const image = screen.getByRole("img", { name: "first.png" });
    expect(image).toHaveAttribute("src", "/api/v1/uploads/one/content");
    // An image is the content, so it must not also appear as a filed chip.
    expect(document.querySelectorAll(".attachment-chip")).toHaveLength(1);
    expect(screen.getByText("brief.pdf")).toBeVisible();
    expect(document.querySelector(".attachment-chip img")).toBeNull();
  });

  it("opens a sent image full size and pages across the others", () => {
    render(<MessageHarness message={{
      ...userMessage,
      attachments: [
        upload("one", "first.png", "image", "image/png"),
        upload("two", "second.png", "image", "image/png"),
        upload("three", "third.png", "image", "image/png"),
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "View second.png" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("2 / 3")).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(within(screen.getByRole("dialog")).getByText("3 / 3")).toBeVisible();
    // Paging wraps, so the set can be walked without hunting for the end.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Next image" }));
    expect(within(screen.getByRole("dialog")).getByText("1 / 3")).toBeVisible();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(screen.getByRole("dialog")).getByText("3 / 3")).toBeVisible();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close image" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no paging for a single image", () => {
    render(<MessageHarness message={{
      ...userMessage,
      attachments: [upload("one", "only.png", "image", "image/png")],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "View only.png" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Next image" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Previous image" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close image" })).toBeVisible();
  });

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
    // A settled call says nothing about being settled; a row stays quiet until
    // it fails.
    expect(screen.queryByText("done")).toBeNull();
    fireEvent.click(toolName.closest("summary")!);
    expect(screen.getByText('"Applied to current run"')).toBeVisible();
  });

  it("renders one compact secret-free activity row for a run's Monitor wakes", () => {
    const first = monitor();
    const second = monitor({
      monitorId: "33333333-3333-4333-8333-333333333333",
      description: "Watch the indexer",
      state: "exited",
      timestamps: {
        ...first.timestamps,
        completedAt: "2026-07-17T10:00:05.000Z",
      },
      counters: {
        ...first.counters,
        seq: 1,
        batchesDelivered: 1,
        linesObserved: 3,
        linesDelivered: 2,
        droppedLines: 1,
      },
      exitCode: 0,
    });
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        {
          type: "monitor-activity",
          monitors: [
            { projection: first, deliveryKeys: ["monitor:secret-delivery-one", "monitor:secret-delivery-two"] },
            { projection: second, deliveryKeys: ["monitor:secret-delivery-three"] },
          ],
        },
        { type: "text", text: "Both watches were handled." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("Monitor updates ×3")).toBeVisible();
    expect(screen.getByText("2 monitors")).toBeVisible();
    expect(screen.queryByText(/secret-delivery/u)).toBeNull();
    expect(screen.queryByText(first.monitorId)).toBeNull();

    fireEvent.click(screen.getByText("Monitor updates ×3").closest("summary")!);
    expect(screen.getByText("Watch the worker queue")).toBeVisible();
    expect(screen.getByText("Watch the indexer")).toBeVisible();
    expect(screen.getByText("2 updates · running")).toBeVisible();
    expect(screen.getByText("1 update · exited")).toBeVisible();
    expect(screen.getAllByText("Observed")).toHaveLength(2);
    expect(screen.getByText("Both watches were handled.")).toBeVisible();
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
    // The canonical terminal state names the failure tag, in place of a generic
    // "failed" the durable record can improve on.
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
    // A thought is a row like any other: its own preview, with no label
    // competing with the text that says what the model was working out.
    expect(screen.getByText("Inspect the real state.", {
      selector: ".activity-row-summary",
    })).toBeVisible();
    expect(screen.getByText("Inspect workspace")).toBeVisible();
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

  it("clusters repeated tools with step counts, previews, and failures under the turn window", () => {
    const calls: WebMessage["parts"] = ["one.md", "two.md", "three.md", "four.md"].map(
      (path, index) => ({
        type: "tool-call" as const,
        toolCallId: `read-${String(index)}`,
        toolName: "read_file",
        args: { path },
        result: index === 2 ? { error: "unreadable" } : { text: path },
        status: index === 2 ? "failed" as const : "complete" as const,
        executionMs: 100,
      }),
    );
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [...calls, { type: "text", text: "Finished." }],
    }} />);

    const header = screen.getByRole("button", { name: "Activity" });
    fireEvent.click(header);
    // The header is the turn's window, never the 400ms sum of the calls.
    expect(header).toHaveTextContent("4 steps \u00b7 12s");
    const clusterRow = screen.getByText("Read \u00d74").closest("summary")!;
    // The row keeps its own summed duration.
    expect(within(clusterRow).getByText("400ms")).toBeVisible();
    expect(screen.getByText("one.md, two.md +2")).toBeVisible();
    expect(screen.getByText("1 failed")).toBeVisible();

    fireEvent.click(clusterRow);
    expect(screen.getAllByText("read_file")).toHaveLength(4);
    fireEvent.click(screen.getAllByText("read_file")[2]!.closest("summary")!);
    expect(screen.getByText(/unreadable/u)).toBeVisible();
  });

  it("times the turn as one window, so thinking counts and parallel calls are not summed twice", () => {
    const slow = (id: string) => ({
      type: "tool-call" as const,
      toolCallId: id,
      toolName: "read_file",
      args: { path: `${id}.md` },
      result: { text: id },
      status: "complete" as const,
      executionMs: 5_000,
    });
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      createdAt: "2026-07-17T10:00:00.000Z",
      finishedAt: "2026-07-17T10:00:06.000Z",
      parts: [
        { type: "reasoning", text: "Read both." },
        slow("one"),
        slow("two"),
        { type: "text", text: "Done." },
      ],
    }} />);

    expect(screen.getByRole("button", { name: "Activity" })).toHaveTextContent("3 steps \u00b7 6s");
  });

  it("ticks while the turn runs and freezes at the recorded finish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:03.000Z"));
    const running = {
      ...assistantMessage("running"),
      parts: assistantMessage("running").parts.slice(0, 2),
    };
    const { rerender } = render(<MessageHarness message={running} />);
    const open = () => screen.getByRole("button", { name: "Activity in progress" });
    expect(open()).toHaveTextContent("2 steps \u00b7 3s");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(open()).toHaveTextContent("2 steps \u00b7 5s");

    // The runtime settles a message asynchronously, so the settled state is
    // awaited on real timers. The frozen figure comes from the two server
    // stamps, not from the clock; the settled fixture folds to one band of
    // reasoning + tool + compaction.
    vi.useRealTimers();
    rerender(<MessageHarness message={{
      ...assistantMessage("complete"),
      finishedAt: "2026-07-17T10:00:05.400Z",
    }} />);
    const settled = await screen.findByRole("button", { name: "Activity" });
    expect(settled).toHaveTextContent("3 steps \u00b7 5s");
  });

  it("gives the clock to the band still open and counts steps on the rest", () => {
    const read = (id: string) => ({
      type: "tool-call" as const,
      toolCallId: id,
      toolName: "read_file",
      args: { path: `${id}.md` },
      result: { text: id },
      status: "complete" as const,
    });
    // Prose between two runs of work splits the turn into two Activity bands.
    render(<MessageHarness message={{
      ...assistantMessage("cancelled"),
      parts: [
        read("one"),
        { type: "text", text: "Checked the first half." },
        read("two"),
        read("three"),
      ],
    }} />);

    const triggers = screen.getAllByRole("button", { name: "Activity" });
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toHaveTextContent("1 step");
    expect(triggers[0]?.textContent).not.toContain("\u00b7");
    expect(triggers[1]).toHaveTextContent("2 steps \u00b7 12s");
  });

  it("shows steps only for a historical record with no finish stamp", () => {
    // A cancelled turn keeps arrival order: reasoning + tool + compaction form
    // the band (3 steps); usage telemetry never renders; the text follows.
    const { finishedAt: _omitted, ...legacy } = assistantMessage("cancelled");
    render(<MessageHarness message={legacy} />);

    const trigger = screen.getByRole("button", { name: "Activity" });
    expect(trigger).toHaveTextContent("3 steps");
    expect(trigger.textContent).not.toContain("\u00b7");
  });

  it("colours a cluster's dot by its own outcome, not by a member's", () => {
    const clusterOf = (failing: boolean): WebMessage["parts"] =>
      ["one.md", "two.md"].map((path, index) => ({
        type: "tool-call" as const,
        toolCallId: `${failing ? "bad" : "ok"}-${String(index)}`,
        toolName: "read_file",
        args: { path },
        result: failing && index === 1 ? { error: "unreadable" } : { text: path },
        status: failing && index === 1 ? "failed" as const : "complete" as const,
      }));
    const show = (failing: boolean) => render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [...clusterOf(failing), { type: "text", text: "Done." }],
    }} />);

    const settled = show(false);
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(settled.container.querySelector(".activity-row.is-complete")).toBeInTheDocument();
    expect(settled.container.querySelector(".activity-row.is-failed")).toBeNull();
    settled.unmount();

    // The failure class the cluster sets has to be the one the red rule matches;
    // when they disagreed a failed cluster kept a green dot.
    const broken = show(true);
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const failed = broken.container.querySelector(".activity-row.is-failed");
    expect(failed).toBeInTheDocument();
    expect(failed?.querySelector(".activity-dot")).toBeInTheDocument();
    expect(within(failed as HTMLElement).getByText("1 failed")).toBeVisible();
  });

  it("shows no duration at all when the runtime reported none", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        {
          type: "tool-call",
          toolCallId: "solo",
          toolName: "inspect_workspace",
          args: { depth: 1 },
          result: { ok: true },
          status: "complete",
        },
        { type: "text", text: "Done." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("1 step")).toBeVisible();
    expect(screen.queryByText(/ms$/u)).toBeNull();
    expect(screen.queryByText(/0\.0s/u)).toBeNull();
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
    expect(within(activity as HTMLElement).getByText("Read inbox")).toBeVisible();
    expect(within(activity as HTMLElement).getByText("Read calendar")).toBeVisible();
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
    expect(await screen.findByText("Second completed tool")).toBeVisible();
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
  const replyImage = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    type: "attachment" as const,
    id,
    artifactId: `${id}-artifact`,
    name,
    mediaType: "image/png",
    sizeBytes: 2_048,
    integrityId: `sha256:${"a".repeat(64)}`,
    storedUrl: `/api/v1/uploads/${id}/content`,
    ...extra,
  });

  it("gathers a settled turn's generated images into one row below the answer", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        { type: "text", text: "Here are the covers." },
        replyImage("one", "first.png"),
        replyImage("two", "second.png"),
        { type: "text", text: "And a later one." },
        replyImage("three", "third.png"),
      ],
    }} />);

    // A settled turn is reordered before it is grouped: its last prose is the
    // answer and reply parts follow it, so images are contiguous however the
    // agent interleaved them, and there is exactly one row.
    const rows = document.querySelectorAll(".image-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelectorAll(".image-tile")).toHaveLength(3);
    // Tiles are direct children, which is what the row's own styling relies on.
    expect(Array.from(rows[0]!.children).every((child) => child.classList.contains("image-tile"))).toBe(true);

    // None of them wears a file card.
    expect(screen.queryByRole("region", { name: "File attachment: first.png" })).toBeNull();
    expect(document.querySelectorAll(".reply-attachment")).toHaveLength(0);
  });

  it("splits a running turn's images where prose still separates them", () => {
    render(<MessageHarness message={{
      ...assistantMessage("running"),
      parts: [
        replyImage("one", "first.png"),
        replyImage("two", "second.png"),
        { type: "text", text: "And a later one." },
        replyImage("three", "third.png"),
      ],
    }} />);

    // A turn in flight keeps arrival order, so adjacency decides the layout the
    // same way it decides Activity bands: prose between two runs is a break.
    const rows = document.querySelectorAll(".image-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll(".image-tile")).toHaveLength(2);
    expect(rows[1]!.querySelectorAll(".image-tile")).toHaveLength(1);
  });

  it("keeps the file card for an image in the row whose bytes never resolve", () => {
    vi.spyOn(api, "replyAttachmentContent").mockRejectedValue(new Error("offline"));
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        replyImage("one", "first.png"),
        // No durable copy and no capability: nothing can be displayed, so the
        // operator must still be offered the file.
        replyImage("two", "second.png", { storedUrl: undefined }),
      ],
    }} />);

    const row = document.querySelector(".image-row")!;
    expect(row.querySelectorAll(".image-tile")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "File attachment: second.png" })).toBeVisible();
    expect(screen.getByText("image/png · 2 KiB")).toBeVisible();
  });

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

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import {
  collectProcessJobParentCalls,
  ProcessJobPresentationProvider,
  type ProcessJobParentCall,
  type ProcessJobPresentationEntry,
} from "../process-job-presentation";
import { agentTurn, launchCall, manageCall, parentMessage } from "../test/agent-group-fixtures";
import { processJob } from "../test/fixtures";
import type { ProcessJobProjection, ProcessJobState } from "../types";
import { ProcessJobStack } from "./ProcessJobStack";
import { ToolCallRepairProvider } from "./tool-call-repair";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const activeJob = (
  threadId: string,
  state: "queued" | "starting" | "running" = "running",
  overrides: NonNullable<Parameters<typeof processJob>[0]> = {},
): ProcessJobProjection => {
  const complete = processJob();
  return processJob({
    state,
    origin: { ...complete.origin, conversationId: `web:${threadId}`, historyBoundary: `web:${threadId}` },
    timestamps: { ...complete.timestamps, completedAt: null },
    wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
    exitCode: null,
    durationMs: null,
    ...overrides,
  });
};

const entry = (job: ProcessJobProjection): ProcessJobPresentationEntry => ({
  messageId: `message-${job.jobId}`,
  part: { type: "process-job", job },
});

function StackHarness({
  threadId,
  jobs,
  historyIsBounded = false,
  parentCalls = [],
}: {
  readonly threadId: string;
  readonly jobs: readonly ProcessJobPresentationEntry[];
  readonly historyIsBounded?: boolean;
  readonly parentCalls?: readonly ProcessJobParentCall[];
}) {
  return (
    <ProcessJobPresentationProvider
      threadId={threadId}
      messages={[]}
      jobs={jobs}
      parentCalls={parentCalls}
      historyIsBounded={historyIsBounded}
    >
      <div key={threadId}>
        <ProcessJobStack />
      </div>
    </ProcessJobPresentationProvider>
  );
}

/** The shelf disclosure: its accessible name starts with its (visually hidden) title. */
const shelfToggle = () => screen.getByRole("button", { name: /^Background jobs/u });
/** Open one agent group by its id (the id is the start of its accessible name). */
const openGroup = (id: string) => {
  const group = screen.getByRole("group", { name: new RegExp(`^${id} (?:peer )?agent,`, "u") });
  const summary = group.querySelector<HTMLElement>(":scope > summary")!;
  if (!group.hasAttribute("open")) fireEvent.click(summary);
  return group;
};
const openShelf = () => {
  const toggle = shelfToggle();
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
};
const historyToggle = () => screen.getByRole("button", { name: "Background job history" });
const announcement = (container: HTMLElement) => container.querySelector("[aria-live='polite']");

const peerJob = (expiresAt: string, overrides: NonNullable<Parameters<typeof processJob>[0]> = {}) => processJob({
  jobId: "peer-job",
  tool: "PeerAgent",
  kind: "internal",
  instanceId: "seed-bank",
  childStillBusy: false,
  summary: "Ask the seed-bank agent about heirloom stock",
  peerQuestion: {
    state: "awaiting_answer",
    questionId: "3f6c9a2e-1b4d-4c8e-9a70-2d5e6f7a8b9c",
    peer: "seed-bank",
    thread: "spring-orders",
    message: "Should I reserve the heirloom tomato seeds now?",
    requestedSchema: { type: "object", properties: {} },
    expiresAt,
  },
  ...overrides,
} as Parameters<typeof processJob>[0]);

describe("ProcessJobStack", () => {
  it("never lets one thread's live projection stand in for another thread's job with the same id", () => {
    // The shelf can outlive a thread switch for a moment: Chat remounts its
    // viewport only once the runtime follows the selection. Render without a
    // thread key so the same stack instance sees both threads.
    const running = activeJob("thread-a", "running", { jobId: "same-job" });
    const settled = processJob({
      jobId: "same-job",
      origin: { ...processJob().origin, conversationId: "web:thread-b", historyBoundary: "web:thread-b" },
    });
    const tree = (threadId: string, job: ProcessJobProjection) => (
      <ProcessJobPresentationProvider threadId={threadId} messages={[]} jobs={[entry(job)]} historyIsBounded={false}>
        <ProcessJobStack />
      </ProcessJobPresentationProvider>
    );
    const view = render(tree("thread-a", running));
    expect(shelfToggle()).toHaveAccessibleName(/Running/u);

    view.rerender(tree("thread-b", settled));
    expect(shelfToggle()).not.toHaveAccessibleName(/Running/u);
    openShelf();
    expect(historyToggle()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(historyToggle());
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toHaveClass("is-complete");
  });

  it("keeps every card mounted behind a closed shelf and lists current work once it opens", () => {
    const running = activeJob("thread", "running", { jobId: "running-job" });
    const succeeded = processJob({ jobId: "succeeded-job" });
    const failed = processJob({ jobId: "failed-job", state: "failed", exitCode: 1 });
    const view = render(<StackHarness
      threadId="thread"
      jobs={[entry(running), entry(succeeded), entry(failed)]}
    />);

    // Closed by default: a glance, not a list.
    const toggle = shelfToggle();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // One current job: the bar names it; the issue count still shows.
    expect(toggle).toHaveAccessibleName("Background jobs Running Exec job: node worker.js --safe-summary 1 issue");
    expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active, 2 finished, 1 issue.");
    expect(screen.queryByRole("group", { name: "Exec background job running" })).toBeNull();
    expect(view.container.querySelectorAll(".process-job-card")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Background job history" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1 active · 2 finished · 1 issue")).toBeVisible();
    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.queryByRole("group", { name: "Exec background job succeeded" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Exec background job failed" })).toBeNull();
    expect(view.container.querySelectorAll(".process-job-stack-item[hidden]")).toHaveLength(2);

    const history = historyToggle();
    expect(history).toHaveAttribute("aria-pressed", "false");
    expect(history).not.toHaveAttribute("aria-expanded");
    fireEvent.click(history);

    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toHaveClass("is-complete");
    expect(screen.getByRole("group", { name: "Exec background job failed" })).toHaveClass("is-failed");
    expect(history).toHaveAccessibleName("Background job history");
    expect(history).toHaveAttribute("aria-pressed", "true");
  });

  it("lists current work first, then History, then finished work, as one keyed sequence", () => {
    const failed = processJob({ jobId: "failed-job", state: "failed", exitCode: 1 });
    const running = activeJob("thread", "running", { jobId: "running-job" });
    const view = render(<StackHarness threadId="thread" jobs={[entry(failed), entry(running)]} />);
    openShelf();
    fireEvent.click(historyToggle());
    const list = view.container.querySelector(".process-job-stack-list")!;
    expect([...list.children].map((child) => child.querySelector(".process-job-card")?.getAttribute("data-state")
      ?? child.className)).toEqual(["running", "process-job-stack-history-row", "failed"]);
  });

  it.each(["queued", "starting", "running"] as const)(
    "shows a %s job in the open shelf without an inert history control",
    (state) => {
      vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
      render(<StackHarness threadId="thread" jobs={[entry(activeJob("thread", state))]} />);
      openShelf();

      expect(screen.getByRole("group", { name: `Exec background job ${state}` }))
        .toHaveClass("is-running");
      expect(screen.queryByRole("button", { name: /background job history/u })).toBeNull();
    },
  );

  it("hides and reveals every terminal outcome through the same history control", () => {
    const states: readonly ProcessJobState[] = [
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "spawn_failed",
      "queue_expired",
      "interrupted",
    ];
    const view = render(<StackHarness
      threadId="thread"
      jobs={states.map((state) => entry(processJob({ jobId: `job-${state}`, state })))}
    />);
    openShelf();

    expect(view.container.querySelectorAll(".process-job-stack-item[hidden]")).toHaveLength(states.length);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getByText("No active jobs · 7 finished · 5 issues")).toBeVisible();
    fireEvent.click(historyToggle());
    expect(screen.getAllByRole("group")).toHaveLength(states.length);
  });

  it("keeps a quiet one-line bar while only history exists", () => {
    const view = render(<StackHarness threadId="thread" jobs={[entry(processJob({ jobId: "done-job" }))]} />);
    const stack = view.container.querySelector(".process-job-stack")!;
    expect(stack).toHaveClass("is-quiet");
    expect(shelfToggle()).toHaveAccessibleName(/1 finished/u);
    expect(announcement(view.container)).toHaveTextContent("Background jobs: No active jobs, 1 finished.");
    // Header chips use the rows' settled glyphs: finished is the green check.
    expect(shelfToggle().querySelector(".process-job-chip.is-success .process-job-glyph")).toHaveClass("is-success", "is-check");

    view.rerender(<StackHarness threadId="thread" jobs={[entry(processJob({ jobId: "done-job" })), entry(processJob({ jobId: "broken-job", state: "failed" }))]} />);
    expect(stack).not.toHaveClass("is-quiet");
    expect(shelfToggle()).toHaveAccessibleName(/1 issue/u);
    expect(shelfToggle().querySelector(".process-job-chip.is-danger .process-job-glyph")).toHaveClass("is-danger", "is-cross");
  });

  it("hides a polling card before the next frame when it settles and does not remount it", async () => {
    vi.useFakeTimers();
    const running = activeJob("thread", "running", { jobId: "live-job" });
    const complete = processJob({
      jobId: running.jobId,
      origin: running.origin,
    });
    let finish!: (job: ProcessJobProjection) => void;
    vi.spyOn(api, "threadJob").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<StackHarness threadId="thread" jobs={[entry(running)]} />);
    openShelf();
    const item = view.container.querySelector<HTMLElement>(".process-job-stack-item")!;
    const row = item.querySelector<HTMLElement>(".process-job-card")!;
    expect(item).not.toHaveAttribute("hidden");
    expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active.");

    await act(async () => { finish(complete); });

    expect(item).toHaveAttribute("hidden");
    expect(item.querySelector(".process-job-card")).toBe(row);
    expect(row).toHaveClass("is-complete");
    expect(announcement(view.container)).toHaveTextContent("Background jobs: No active jobs, 1 finished.");
    expect(screen.queryByRole("group", { name: "Exec background job succeeded" })).toBeNull();
    act(() => vi.advanceTimersByTime(20_000));
    expect(api.threadJob).toHaveBeenCalledOnce();

    fireEvent.click(historyToggle());
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toBe(row);
  });

  it("hands focus from a row that settles out of view to the History control", async () => {
    const running = activeJob("thread", "running", { jobId: "live-job" });
    let finish!: (job: ProcessJobProjection) => void;
    vi.spyOn(api, "threadJob").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<StackHarness threadId="thread" jobs={[entry(running)]} />);
    openShelf();
    const summary = view.container.querySelector<HTMLElement>(".process-job-card > summary")!;
    summary.focus();
    expect(summary).toHaveFocus();

    await act(async () => { finish(processJob({ jobId: running.jobId, origin: running.origin })); });

    expect(summary.closest(".process-job-stack-item")).toHaveAttribute("hidden");
    expect(historyToggle()).toHaveFocus();
  });

  it("never moves focus that is outside the shelf", async () => {
    const running = activeJob("thread", "running", { jobId: "live-job" });
    let finish!: (job: ProcessJobProjection) => void;
    vi.spyOn(api, "threadJob").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<><textarea aria-label="Composer" /><StackHarness threadId="thread" jobs={[entry(running)]} /></>);
    openShelf();
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    await act(async () => { finish(processJob({ jobId: running.jobId, origin: running.origin })); });
    expect(composer).toHaveFocus();
  });

  it("never opens a card on its own, even when live output arrives", async () => {
    const running = activeJob("thread", "running", {
      jobId: "live-job",
      output: { ...processJob().output, stdoutBytes: 0, stderrBytes: 0, preview: "" },
    });
    vi.spyOn(api, "threadJob").mockResolvedValue(processJob({
      ...running,
      output: { ...running.output, stdoutBytes: 12, preview: "STDOUT:\nwatering bed 3" },
    }));
    const view = render(<StackHarness threadId="thread" jobs={[entry(running)]} />);
    openShelf();
    await waitFor(() => expect(view.container.querySelector(".process-job-preview-text")).toHaveTextContent("watering bed 3"));
    expect(view.container.querySelector(".process-job-card")).not.toHaveAttribute("open");
  });

  it("shows the one current job's purpose in the closed bar", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const running = activeJob("thread", "running", { summary: "Purpose: Water the north beds" });
    render(<StackHarness threadId="thread" jobs={[entry(running), entry(processJob({ jobId: "done" }))]} />);
    const toggle = shelfToggle();
    expect(within(toggle).getByText("Water the north beds")).toBeInTheDocument();
    // State and kind are spoken with the purpose; on screen the spinner says
    // the state and a terminal icon the kind.
    expect(toggle).toHaveAccessibleName("Background jobs Running Exec job: Water the north beds");
    expect(toggle.querySelector(".process-job-stack-single .process-job-glyph")).toHaveClass("is-spinner");
    expect(toggle.querySelector(".process-job-stack-kind")).toHaveClass("is-command");
    expect(toggle.querySelector(".process-job-chip")).toBeNull();
  });

  it("marks a lone agent job with the agent icon and a still job with its own glyph", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const agent = activeJob("thread", "running", {
      jobId: "agent-running", tool: "Agent", kind: "internal", instanceId: "garden-helper", childStillBusy: false,
      summary: "Draft the spring planting plan",
    });
    const view = render(<StackHarness threadId="thread" jobs={[entry(agent)]} />);
    // An agent is always a group: the bar names its id before its newest task.
    expect(shelfToggle()).toHaveAccessibleName("Background jobs Running agent garden-helper: Draft the spring planting plan");
    expect(within(shelfToggle()).getByText("garden-helper")).toHaveClass("process-job-stack-agent");
    expect(shelfToggle().querySelector(".process-job-stack-kind")).toHaveClass("is-agent");
    view.unmount();

    render(<StackHarness threadId="thread" jobs={[entry(activeJob("thread", "queued", { jobId: "waiting" }))]} />);
    const glyph = shelfToggle().querySelector(".process-job-stack-single .process-job-glyph");
    expect(glyph).not.toHaveClass("is-spinner");
    expect(glyph).toHaveClass("is-waiting", "is-empty");
  });

  it("counts several current jobs as marked numbers and leaves finished counts out while work is active", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    render(<StackHarness threadId="thread" jobs={[
      entry(activeJob("thread", "running", { jobId: "one" })),
      entry(activeJob("thread", "queued", { jobId: "two" })),
      entry(processJob({ jobId: "done" })),
      entry(processJob({ jobId: "broken", state: "failed" })),
    ]} />);
    const toggle = shelfToggle();
    const chips = [...toggle.querySelectorAll(".process-job-chip")].map((chip) => chip.querySelector(".process-job-chip-count")?.textContent);
    expect(chips).toEqual(["2", "1"]);
    expect(toggle).toHaveAccessibleName("Background jobs 2 active 1 issue");
    // One of them runs, so the active count carries the bar's spinner.
    expect(toggle.querySelector(".process-job-chip.is-running .process-job-glyph")).toHaveClass("is-spinner");
  });

  it("holds the active count still when none of its jobs is in progress", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    render(<StackHarness threadId="thread" jobs={[
      entry(activeJob("thread", "queued", { jobId: "one" })),
      entry(activeJob("thread", "queued", { jobId: "two" })),
    ]} />);
    const chip = shelfToggle().querySelector(".process-job-chip")!;
    expect(chip).toHaveClass("is-waiting");
    expect(chip.querySelector(".process-job-glyph")).toHaveClass("is-empty");
    expect(chip.querySelector(".is-spinner")).toBeNull();
    expect(shelfToggle()).toHaveAccessibleName("Background jobs 2 active");
  });

  it("keeps a pending peer question with current work, apart from the active count, until it expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    const view = render(<StackHarness threadId="thread" jobs={[
      entry(peerJob("2026-07-17T10:01:30.000Z")),
      entry(activeJob("thread", "running", { jobId: "running-job" })),
    ]} />);
    openShelf();
    expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active, 1 question awaiting the agent.");
    // The peer is a group: its header says the question, and so does its turn.
    const group = openGroup("seed-bank");
    expect(within(group.querySelector("summary")!).getByText("Question pending")).toBeVisible();
    const peer = screen.getByRole("group", { name: "PeerAgent background job succeeded" });
    expect(within(peer).getByText("Question pending")).toBeVisible();
    expect(within(group).getByRole("note", { name: "seed-bank asks the agent" })).toHaveTextContent("Should I reserve the heirloom tomato seeds now?");

    // The shelf's one clock re-evaluates at the deadline without any poll.
    for (let step = 0; step < 4; step += 1) act(() => { vi.advanceTimersByTime(30_000); });
    expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active, 1 finished.");
    expect(group.closest(".process-job-stack-item")).toHaveAttribute("hidden");
  });

  it.each([
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("keeps a lone %s peer job's pending question visible in the closed bar", (state, word) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    render(<StackHarness threadId="thread" jobs={[entry(peerJob("2026-07-17T10:20:00.000Z", { state, exitCode: state === "failed" ? 1 : null }))]} />);
    const toggle = shelfToggle();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The row's word is its outcome, so the question keeps its own chip.
    const question = toggle.querySelector(".process-job-chip.is-question");
    expect(question).not.toBeNull();
    expect(question?.querySelector(".process-job-chip-count")).toHaveTextContent("1");
    expect(toggle).toHaveAccessibleName(new RegExp(`^Background jobs ${word}, Question pending peer agent seed-bank: Ask the seed-bank agent about heirloom stock 1 question awaiting the agent`, "u"));
  });

  it("does not repeat the question chip when the lone row's state already is the question", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    render(<StackHarness threadId="thread" jobs={[entry(peerJob("2026-07-17T10:20:00.000Z"))]} />);
    const toggle = shelfToggle();
    expect(toggle.querySelector(".process-job-chip.is-question")).toBeNull();
    expect(toggle).toHaveAccessibleName("Background jobs Question pending peer agent seed-bank: Ask the seed-bank agent about heirloom stock");
  });

  it("keeps a failed peer job's outcome while its question is pending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    render(<StackHarness threadId="thread" jobs={[entry(peerJob("2026-07-17T10:20:00.000Z", { state: "failed", exitCode: 1 }))]} />);
    openShelf();
    openGroup("seed-bank");
    const peer = screen.getByRole("group", { name: "PeerAgent background job failed" });
    expect(within(peer).getByText("Failed")).toHaveClass("process-job-state");
    expect(within(peer).getByText("Question pending")).toHaveClass("process-job-pending");
  });

  it("announces counts only and stays silent across a poll that changes nothing", async () => {
    const running = activeJob("thread", "running", { jobId: "live-job" });
    const view = render(<StackHarness threadId="thread" jobs={[entry(running)]} />);
    const live = announcement(view.container)!;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(live, { subtree: true, childList: true, characterData: true });
    view.rerender(<StackHarness threadId="thread" jobs={[entry(JSON.parse(JSON.stringify(running)) as ProcessJobProjection)]} />);
    await act(async () => { await Promise.resolve(); });
    observer.disconnect();
    expect(mutations).toHaveLength(0);
    expect(live.textContent).toBe("Background jobs: 1 active.");
  });

  it("exposes bounded guidance from the history visibility toggle even with active-only input", () => {
    render(<StackHarness
      threadId="thread"
      jobs={[entry(activeJob("thread"))]}
      historyIsBounded
    />);
    openShelf();
    const toggle = historyToggle();
    const stack = screen.getByRole("region", { name: "Background jobs" });
    const guidance = screen.getByText(/Load earlier messages to reveal older jobs/u);
    expect(stack).toContainElement(guidance);
    expect(guidance).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toHaveAttribute("aria-expanded");
    expect(toggle).not.toHaveAttribute("aria-controls");
    fireEvent.click(toggle);
    expect(guidance).toBeVisible();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("scopes a bounded finished count to what is loaded", () => {
    const view = render(<StackHarness threadId="thread" jobs={[entry(processJob({ jobId: "done" }))]} historyIsBounded />);
    expect(announcement(view.container)).toHaveTextContent("Background jobs: No active jobs, 1 finished shown.");
  });

  it("shows new active work without opening terminal history", () => {
    const failed = processJob({ jobId: "failed-job", state: "failed", exitCode: 1 });
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const view = render(<StackHarness threadId="thread" jobs={[entry(failed)]} />);
    openShelf();
    const toggle = historyToggle();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    const running = activeJob("thread", "running", { jobId: "running-job" });
    view.rerender(<StackHarness threadId="thread" jobs={[entry(failed), entry(running)]} />);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.queryByRole("group", { name: "Exec background job failed" })).toBeNull();
    expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active, 1 finished, 1 issue.");
  });

  it("keeps shelf and history preferences and same-id card state isolated through keyed thread remounts", async () => {
    const aRunning = activeJob("thread-a", "running", { jobId: "same-job" });
    const aHistory = processJob({ jobId: "a-history" });
    const bTerminal = processJob({
      jobId: "same-job",
      origin: { ...processJob().origin, conversationId: "web:thread-b", historyBoundary: "web:thread-b" },
    });
    let aSignal: AbortSignal | undefined;
    vi.spyOn(api, "threadJob").mockImplementation(async (threadId, _jobId, signal) => {
      if (threadId === "thread-a") aSignal = signal;
      return new Promise<ProcessJobProjection>(() => undefined);
    });

    const view = render(<StackHarness
      threadId="thread-a"
      jobs={[entry(aRunning), entry(aHistory)]}
    />);
    await waitFor(() => expect(aSignal).toBeDefined());
    openShelf();
    fireEvent.click(historyToggle());
    expect(historyToggle()).toHaveAttribute("aria-pressed", "true");

    view.rerender(<StackHarness threadId="thread-b" jobs={[entry(bTerminal)]} />);
    expect(aSignal?.aborted).toBe(true);
    expect(shelfToggle()).toHaveAttribute("aria-expanded", "false");
    openShelf();
    expect(historyToggle()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("group", { name: "Exec background job succeeded" })).toBeNull();

    view.rerender(<StackHarness
      threadId="thread-a"
      jobs={[entry(aRunning), entry(aHistory)]}
    />);
    expect(shelfToggle()).toHaveAttribute("aria-expanded", "true");
    expect(historyToggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toHaveClass("is-complete");
  });

  it("renders no empty landmark when the loaded thread has no jobs", () => {
    render(<StackHarness threadId="thread" jobs={[]} />);
    expect(screen.queryByRole("region", { name: "Background jobs" })).toBeNull();
  });

  it("shows no visible title but keeps its name, and says the counts in words once open", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    render(<StackHarness threadId="thread" jobs={[entry(activeJob("thread", "running", { jobId: "one" })), entry(activeJob("thread", "queued", { jobId: "two" }))]} />);
    const toggle = shelfToggle();
    expect(within(toggle).getByText("Background jobs")).toHaveClass("sr-only");
    expect(screen.getByRole("region", { name: "Background jobs" })).toContainElement(toggle);
    expect(toggle).toHaveAccessibleName("Background jobs 2 active");

    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Background jobs 2 active");
    expect(within(toggle).getByText("2 active")).toHaveClass("process-job-stack-summary");
    expect(toggle.querySelector(".process-job-chip")).toBeNull();
  });

  it("says what an idle bar counts in words instead of a bare number", () => {
    render(<StackHarness threadId="thread" jobs={[entry(processJob({ jobId: "done" })), entry(processJob({ jobId: "broken", state: "failed" }))]} />);
    const toggle = shelfToggle();
    expect(within(toggle).getByText("1 issue")).toHaveClass("process-job-chip-words");
    expect(within(toggle).getByText("2 finished")).toHaveClass("process-job-chip-words");
    expect(toggle.querySelector(".process-job-chip-count")).toBeNull();
    expect(toggle).toHaveAccessibleName("Background jobs 1 issue 2 finished");
  });

  describe("agent groups", () => {
    const brief = agentTurn("t1", "helper", 0, { durationMinutes: 4, summary: "Research frost dates" });
    const follow = agentTurn("t2", "helper", 10, { tool: "AgentManage", summary: "Summarise the sowing windows" });
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(brief, { prompt: "Find the frost dates for the allotment.", persist: true, background: true }, { argsTruncated: true, argsBytes: 5_214 })]),
      parentMessage("m2", 5, [{ type: "subagent", toolCallId: "fg", name: "researcher", status: "complete", calls: [],
        args: { id: "helper", message: "Which source do you trust more?" } }]),
      parentMessage("m3", 10, [launchCall(follow, { id: "helper", message: "Summarise the three safest sowing windows.", background: true })]),
    ], "thread");

    it("makes every turn of one instance one row, counted once", () => {
      vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
      const view = render(<StackHarness threadId="thread" parentCalls={calls}
        jobs={[entry(brief), entry(activeJob("thread", "running", { jobId: "cmd" })), entry(follow)]} />);
      expect(announcement(view.container)).toHaveTextContent("Background jobs: 2 active.");
      expect(shelfToggle()).toHaveAccessibleName("Background jobs 2 active");
      openShelf();
      expect(view.container.querySelectorAll(".process-job-group")).toHaveLength(1);
      expect(view.container.querySelectorAll(".process-job-card")).toHaveLength(3);
      const group = screen.getByRole("group", { name: "helper agent, 2 turns: Summarise the sowing windows" });
      const summary = group.querySelector<HTMLElement>(":scope > summary")!;
      expect(summary).toHaveAccessibleName("helper Summarise the sowing windows");
      expect(summary).toHaveAccessibleDescription(/^Running .*2 turns/u);
      expect(screen.queryByRole("button", { name: "Background job history" })).toBeNull();
    });

    it("opens a timeline of the parent's calls as tool rows, with the full text and the transcript's repair", async () => {
      vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
      const repair = vi.fn(async () => true);
      render(<ToolCallRepairProvider repair={repair}>
        <StackHarness threadId="thread" parentCalls={calls} jobs={[entry(brief), entry(follow)]} />
      </ToolCallRepairProvider>);
      openShelf();
      const group = openGroup("helper");
      const timeline = within(group).getByRole("list", { name: "helper timeline" });
      expect(timeline).toBeVisible();
      expect([...timeline.children].map((step) => step.className)).toEqual([
        "process-job-step is-call", "process-job-step is-turn", "process-job-step is-call", "process-job-step is-call", "process-job-step is-turn",
      ]);
      const briefRow = within(timeline).getByRole("button", { name: /^From the parent agent: Agent brief Find the frost dates for the allotment\./u });
      expect(briefRow).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(briefRow);
      expect(briefRow).toHaveAttribute("aria-expanded", "true");
      const body = document.getElementById(briefRow.getAttribute("aria-controls")!)!;
      expect(body).toBeVisible();
      expect(within(body).getByText("Find the frost dates for the allotment.")).toBeVisible();
      expect(within(body).getByText("Preview only, 5,214 chars.")).toBeVisible();
      fireEvent.click(within(body).getByRole("button", { name: "Load full message" }));
      await waitFor(() => expect(repair).toHaveBeenCalledWith("call-t1"));
      // A foreground message has no turn under it and says where it was answered.
      const foreground = within(timeline).getByRole("button", { name: /^From the parent agent: AgentManage message Which source do you trust more\?/u });
      expect(foreground).toHaveTextContent("answered in the conversation");
    });

    it("counts only the newest turn's outcome as an issue", () => {
      vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
      const failed = agentTurn("f1", "planner", 0, { state: "failed", durationMinutes: 2, summary: "Price the order" });
      const retry = agentTurn("f2", "planner", 5, { tool: "AgentManage", summary: "Retry the pricing" });
      const view = render(<StackHarness threadId="thread" jobs={[entry(failed), entry(retry)]} />);
      expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active.");
      expect(shelfToggle()).toHaveAccessibleName("Background jobs Running agent planner: Retry the pricing");
      openShelf();
      // The earlier failure still shows its own outcome inside the timeline.
      openGroup("planner");
      expect(screen.getByRole("group", { name: "Agent background job failed" })).toHaveClass("is-failed");

      view.rerender(<StackHarness threadId="thread" jobs={[entry(failed), entry({ ...retry, state: "failed", exitCode: 1, durationMs: 60_000,
        timestamps: { ...retry.timestamps, completedAt: retry.timestamps.startedAt } })]} />);
      expect(announcement(view.container)).toHaveTextContent("Background jobs: No active jobs, 1 finished, 1 issue.");
    });

    it("keeps a group mounted and open while its newest turn settles into History", async () => {
      const running = agentTurn("live", "helper", 10, { tool: "AgentManage", summary: "Summarise the sowing windows" });
      let finish!: (job: ProcessJobProjection) => void;
      vi.spyOn(api, "threadJob").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const view = render(<StackHarness threadId="thread" parentCalls={calls} jobs={[entry(brief), entry(running)]} />);
      openShelf();
      const group = openGroup("helper");
      const item = group.closest(".process-job-stack-item")!;
      const card = screen.getByRole("group", { name: "AgentManage background job running" });

      await act(async () => {
        finish({ ...running, state: "succeeded", exitCode: 0, durationMs: 120_000,
          timestamps: { ...running.timestamps, completedAt: running.timestamps.startedAt } });
      });

      expect(item).toHaveAttribute("hidden");
      expect(announcement(view.container)).toHaveTextContent("Background jobs: No active jobs, 1 finished.");
      fireEvent.click(historyToggle());
      expect(item).not.toHaveAttribute("hidden");
      expect(view.container.querySelector(".process-job-group")).toBe(group);
      expect(group).toHaveAttribute("open");
      expect(screen.getByRole("group", { name: "AgentManage background job succeeded" })).toBe(card);
    });

    it("shows a steer, a stop and a close as rows, and marks the instance closed", () => {
      const stopped = agentTurn("s1", "soil-analyst", 0, { state: "cancelled", durationMinutes: 4, summary: "Compare soil tests", extra: { cancelRequested: true } });
      const soilCalls = collectProcessJobParentCalls([
        parentMessage("m1", 0, [launchCall(stopped, { prompt: "Compare the soil tests.", id: "soil-analyst", persist: true })]),
        parentMessage("m2", 1, [manageCall("steer", { id: "soil-analyst", steer: "Skip the south bed." }, { jobId: "s1", status: "applied" })]),
        parentMessage("m3", 2, [manageCall("stop", { id: "soil-analyst", stop: true }, { jobId: "s1", status: "stopped" })]),
        parentMessage("m4", 3, [manageCall("close", { id: "soil-analyst", close: true }, "<subagent: analyst · closed>")]),
      ], "thread");
      render(<StackHarness threadId="thread" parentCalls={soilCalls} jobs={[entry(stopped)]} />);
      openShelf();
      fireEvent.click(historyToggle());
      const group = openGroup("soil-analyst");
      expect(within(group.querySelector("summary")!).getByText("closed")).toHaveClass("process-job-group-closed");
      const timeline = within(group).getByRole("list", { name: "soil-analyst timeline" });
      expect([...timeline.children].map((step) => step.className)).toEqual([
        "process-job-step is-call", "process-job-step is-turn", "process-job-step is-call is-nested", "process-job-step is-call is-nested", "process-job-step is-call",
      ]);
      expect(timeline.children[2]).toHaveTextContent(/AgentManage\s*steer\s*Skip the south bed\.\s*applied/u);
      expect(timeline.children[3]).toHaveTextContent(/AgentManage\s*stop\s*stopped/u);
      expect(timeline.children[4]).toHaveTextContent(/AgentManage\s*close\s*instance closed/u);
      // Rows without text are not buttons.
      expect(within(timeline.children[3] as HTMLElement).queryByRole("button")).toBeNull();
    });

    it("groups peer jobs by peer and never merges them with a subagent of the same name", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
      render(<StackHarness threadId="thread" jobs={[
        entry(peerJob("2026-07-17T10:20:00.000Z")),
        entry(agentTurn("sub", "seed-bank", 0, { durationMinutes: 1, summary: "Count the seed packets" })),
        entry(peerJob("2026-07-17T10:20:00.000Z", { jobId: "peer-older", state: "succeeded", peerQuestion: undefined })),
      ]} />);
      openShelf();
      expect(screen.getByRole("group", { name: "seed-bank peer agent, 2 turns: Ask the seed-bank agent about heirloom stock" })).toBeInTheDocument();
      fireEvent.click(historyToggle());
      expect(screen.getByRole("group", { name: "seed-bank agent, 1 turn: Count the seed packets" })).toBeInTheDocument();
    });
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import {
  ProcessJobPresentationProvider,
  type ProcessJobPresentationEntry,
} from "../process-job-presentation";
import { processJob } from "../test/fixtures";
import type { ProcessJobProjection, ProcessJobState } from "../types";
import { ProcessJobStack } from "./ProcessJobStack";

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
}: {
  readonly threadId: string;
  readonly jobs: readonly ProcessJobPresentationEntry[];
  readonly historyIsBounded?: boolean;
}) {
  return (
    <ProcessJobPresentationProvider
      threadId={threadId}
      messages={[]}
      jobs={jobs}
      historyIsBounded={historyIsBounded}
    >
      <div key={threadId}>
        <ProcessJobStack />
      </div>
    </ProcessJobPresentationProvider>
  );
}

/** The shelf disclosure: its accessible name starts with its visible title. */
const shelfToggle = () => screen.getByRole("button", { name: /^Background jobs/u });
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
    expect(shelfToggle()).toHaveAccessibleName("Background jobs Running Agent job: Draft the spring planting plan");
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
    const peer = screen.getByRole("group", { name: "PeerAgent background job succeeded" });
    expect(within(peer).getByText("Question pending")).toBeVisible();

    // The shelf's one clock re-evaluates at the deadline without any poll.
    for (let step = 0; step < 4; step += 1) act(() => { vi.advanceTimersByTime(30_000); });
    expect(announcement(view.container)).toHaveTextContent("Background jobs: 1 active, 1 finished.");
    expect(peer.closest(".process-job-stack-item")).toHaveAttribute("hidden");
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
    expect(toggle).toHaveAccessibleName(new RegExp(`^Background jobs ${word}, Question pending PeerAgent job: Ask the seed-bank agent about heirloom stock 1 question awaiting the agent`, "u"));
  });

  it("does not repeat the question chip when the lone row's state already is the question", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    render(<StackHarness threadId="thread" jobs={[entry(peerJob("2026-07-17T10:20:00.000Z"))]} />);
    const toggle = shelfToggle();
    expect(toggle.querySelector(".process-job-chip.is-question")).toBeNull();
    expect(toggle).toHaveAccessibleName("Background jobs Question pending PeerAgent job: Ask the seed-bank agent about heirloom stock");
  });

  it("keeps a failed peer job's outcome while its question is pending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    render(<StackHarness threadId="thread" jobs={[entry(peerJob("2026-07-17T10:20:00.000Z", { state: "failed", exitCode: 1 }))]} />);
    openShelf();
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
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  overrides: Partial<ProcessJobProjection> = {},
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

describe("ProcessJobStack", () => {
  it("shows active work and hides terminal outcomes until history is expanded", () => {
    const running = activeJob("thread", "running", { jobId: "running-job" });
    const succeeded = processJob({ jobId: "succeeded-job" });
    const failed = processJob({ jobId: "failed-job", state: "failed", exitCode: 1 });
    const view = render(<StackHarness
      threadId="thread"
      jobs={[entry(running), entry(succeeded), entry(failed)]}
    />);

    expect(screen.getByText("3 jobs · 1 active · 2 history")).toBeVisible();
    expect(screen.getByRole("group", { name: "Exec background job running" }))
      .toHaveClass("is-running");
    expect(screen.queryByRole("group", { name: "Exec background job succeeded" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Exec background job failed" })).toBeNull();
    expect(view.container.querySelectorAll(".process-job-stack-item[hidden]")).toHaveLength(2);

    const toggle = screen.getByRole("button", { name: "Show background job history" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toHaveClass("is-complete");
    expect(screen.getByRole("group", { name: "Exec background job failed" })).toHaveClass("is-failed");
    expect(toggle).toHaveAccessibleName("Hide background job history");
  });

  it.each(["queued", "starting", "running"] as const)(
    "keeps a %s job visible without an inert history control",
    (state) => {
      vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
      render(<StackHarness threadId="thread" jobs={[entry(activeJob("thread", state))]} />);

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

    expect(view.container.querySelectorAll(".process-job-stack-item[hidden]")).toHaveLength(states.length);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show background job history" }));
    expect(screen.getAllByRole("group")).toHaveLength(states.length);
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
    const item = view.container.querySelector<HTMLElement>(".process-job-stack-item")!;
    const row = item.querySelector<HTMLElement>(".activity-row.is-job")!;
    expect(item).not.toHaveAttribute("hidden");
    expect(screen.getByText("1 job · 1 active · 0 history")).toBeVisible();

    await act(async () => { finish(complete); });

    expect(item).toHaveAttribute("hidden");
    expect(item.querySelector(".activity-row.is-job")).toBe(row);
    expect(row).toHaveClass("is-complete");
    expect(screen.getByText("1 job · 0 active · 1 history")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Exec background job succeeded" })).toBeNull();
    act(() => vi.advanceTimersByTime(20_000));
    expect(api.threadJob).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Show background job history" }));
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toBe(row);
  });

  it("keeps bounded guidance inside the controlled history region even with active-only input", () => {
    render(<StackHarness
      threadId="thread"
      jobs={[entry(activeJob("thread"))]}
      historyIsBounded
    />);
    const toggle = screen.getByRole("button", { name: "Show background job history" });
    const controlled = document.getElementById(toggle.getAttribute("aria-controls")!);
    const guidance = screen.getByText(/Load earlier messages to reveal older jobs/u);
    expect(screen.getByText("1 loaded · 1 active · 0 history")).toBeVisible();
    expect(controlled).toContainElement(guidance);
    expect(guidance).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(guidance).toBeVisible();
  });

  it("shows new active work without opening terminal history", () => {
    const failed = processJob({ jobId: "failed-job", state: "failed", exitCode: 1 });
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const view = render(<StackHarness threadId="thread" jobs={[entry(failed)]} />);
    const toggle = screen.getByRole("button", { name: "Show background job history" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const running = activeJob("thread", "running", { jobId: "running-job" });
    view.rerender(<StackHarness threadId="thread" jobs={[entry(failed), entry(running)]} />);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.queryByRole("group", { name: "Exec background job failed" })).toBeNull();
    expect(screen.getByText("2 jobs · 1 active · 1 history")).toBeVisible();
  });

  it("keeps history preference and same-id card state isolated through keyed thread remounts", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Show background job history" }));
    expect(screen.getByRole("button", { name: "Hide background job history" }))
      .toHaveAttribute("aria-expanded", "true");

    view.rerender(<StackHarness threadId="thread-b" jobs={[entry(bTerminal)]} />);
    expect(aSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Show background job history" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Exec background job succeeded" })).toBeNull();

    view.rerender(<StackHarness
      threadId="thread-a"
      jobs={[entry(aRunning), entry(aHistory)]}
    />);
    expect(screen.getByRole("button", { name: "Hide background job history" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toHaveClass("is-complete");
  });

  it("renders no empty landmark when the loaded thread has no jobs", () => {
    render(<StackHarness threadId="thread" jobs={[]} />);
    expect(screen.queryByRole("region", { name: "Background jobs" })).toBeNull();
  });
});

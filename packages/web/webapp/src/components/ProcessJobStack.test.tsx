import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import {
  ProcessJobPresentationProvider,
  type ProcessJobPresentationEntry,
} from "../process-job-presentation";
import { processJob } from "../test/fixtures";
import type { ProcessJobProjection } from "../types";
import { ProcessJobStack } from "./ProcessJobStack";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const runningJob = (
  threadId: string,
  overrides: Partial<ProcessJobProjection> = {},
): ProcessJobProjection => {
  const complete = processJob();
  return processJob({
    state: "running",
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
  it("keeps a manual per-thread choice across A -> B -> A while aborting the old card", async () => {
    const a = runningJob("thread-a", { jobId: "same-job" });
    const b = processJob({
      jobId: "same-job",
      origin: { ...processJob().origin, conversationId: "web:thread-b", historyBoundary: "web:thread-b" },
    });
    let aSignal: AbortSignal | undefined;
    vi.spyOn(api, "threadJob").mockImplementation(async (threadId, _jobId, signal) => {
      if (threadId === "thread-a") aSignal = signal;
      return new Promise<ProcessJobProjection>(() => undefined);
    });

    const view = render(<StackHarness threadId="thread-a" jobs={[entry(a)]} />);
    const aToggle = screen.getByRole("button", { name: /Background jobs.*1 active/u });
    expect(aToggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(aSignal).toBeDefined());
    fireEvent.click(aToggle);
    expect(aToggle).toHaveAttribute("aria-expanded", "false");

    view.rerender(<StackHarness threadId="thread-b" jobs={[entry(b)]} />);
    expect(aSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: /Background jobs/u }))
      .toHaveAttribute("aria-expanded", "false");

    view.rerender(<StackHarness threadId="thread-a" jobs={[entry(a)]} />);
    expect(screen.getByRole("button", { name: /Background jobs/u }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("keeps collapsed cards mounted and updates counts when a running job settles", async () => {
    const running = runningJob("thread", { jobId: "live-job" });
    const complete = processJob({
      jobId: running.jobId,
      origin: running.origin,
    });
    let finish!: (job: ProcessJobProjection) => void;
    vi.spyOn(api, "threadJob").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<StackHarness threadId="thread" jobs={[entry(running)]} />);
    const toggle = screen.getByRole("button", { name: /1 active/u });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const body = view.container.querySelector(".process-job-stack-body")!;
    expect(body).toHaveAttribute("hidden");
    expect(body.querySelectorAll(".activity-row.is-job")).toHaveLength(1);

    await act(async () => { finish(complete); });

    await waitFor(() => expect(toggle).toHaveAccessibleName(/0 active · 0 needs attention/u));
    expect(body.querySelector(".activity-row.is-job")).toHaveClass("is-complete");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("labels bounded loaded history and exposes its existing pagination path", () => {
    render(<StackHarness
      threadId="thread"
      jobs={[entry(processJob())]}
      historyIsBounded
    />);
    const toggle = screen.getByRole("button", { name: /1 loaded · 0 active/u });
    expect(toggle).toHaveAttribute("aria-controls");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText(/Load earlier messages to reveal older jobs/u)).toBeVisible();
  });

  it("auto-opens an untouched terminal stack when new active work arrives", async () => {
    const failed = processJob({ jobId: "failed-job", state: "failed", exitCode: 1 });
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const view = render(<StackHarness threadId="thread" jobs={[entry(failed)]} />);
    const toggle = screen.getByRole("button", { name: /0 active · 1 needs attention/u });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const running = runningJob("thread", { jobId: "running-job" });
    view.rerender(<StackHarness threadId="thread" jobs={[entry(failed), entry(running)]} />);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    expect(toggle).toHaveAccessibleName(/2 jobs · 1 active · 1 needs attention/u);
  });

  it("renders no empty landmark when the loaded thread has no jobs", () => {
    render(<StackHarness threadId="thread" jobs={[]} />);
    expect(screen.queryByRole("region", { name: "Background jobs" })).toBeNull();
  });
});

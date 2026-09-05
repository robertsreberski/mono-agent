import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { processJob } from "../test/fixtures";
import type { ProcessJobState } from "../types";
import {
  ProcessJobPart,
  processJobExitLabel,
  processJobStatus,
  processJobThreadId,
  processJobTiming,
} from "./ProcessJob";

type ProcessJobProps = Parameters<typeof ProcessJobPart>[0];

// The component only reads `data`; assistant-ui supplies the rest of the part
// props, which this rendering never touches.
const part = (data: unknown) =>
  <ProcessJobPart {...({ data } as unknown as ProcessJobProps)} />;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("processJobStatus", () => {
  it.each<[ProcessJobState, string]>([
    ["queued", "running"],
    ["starting", "running"],
    ["running", "running"],
    ["succeeded", "complete"],
    ["failed", "failed"],
    ["timed_out", "failed"],
    ["cancelled", "failed"],
    ["spawn_failed", "failed"],
    ["queue_expired", "failed"],
    ["interrupted", "failed"],
  ])("maps %s to the %s dot", (state, status) => {
    expect(processJobStatus(state)).toBe(status);
  });
});

describe("processJobThreadId", () => {
  it("reads the web thread out of the origin and ignores the run suffix", () => {
    expect(processJobThreadId(processJob())).toBe("thread");
    expect(processJobThreadId(processJob({
      origin: { ...processJob().origin, conversationId: "web:thread#run-two" },
    }))).toBe("thread");
  });

  it("never polls for a job that is not bound to a retained web thread", () => {
    expect(processJobThreadId(processJob({
      origin: { ...processJob().origin, conversationId: "web:new" },
    }))).toBeUndefined();
    expect(processJobThreadId(processJob({
      origin: { ...processJob().origin, conversationId: "telegram:1" },
    }))).toBeUndefined();
  });
});

describe("processJobTiming", () => {
  it("prefers the reported duration over the completion stamp", () => {
    // completedAt is 2 s after start; durationMs says 1.5 s. The host's own
    // measurement wins so the frozen figure matches what the host recorded.
    expect(processJobTiming(processJob({ durationMs: 1_500 }))).toEqual({
      startedAt: Date.parse("2026-07-17T10:00:01.000Z"),
      finishedAt: Date.parse("2026-07-17T10:00:02.500Z"),
    });
  });

  it("falls back to the completion stamp, then leaves the window open", () => {
    expect(processJobTiming(processJob({ durationMs: null }))).toEqual({
      startedAt: Date.parse("2026-07-17T10:00:01.000Z"),
      finishedAt: Date.parse("2026-07-17T10:00:03.000Z"),
    });
    const running = processJob({
      state: "running",
      durationMs: null,
      timestamps: { ...processJob().timestamps, completedAt: null },
    });
    expect(processJobTiming(running)).toEqual({ startedAt: Date.parse("2026-07-17T10:00:01.000Z") });
  });

  it("counts a queued job from its admission", () => {
    const queued = processJob({
      state: "queued",
      durationMs: null,
      timestamps: { ...processJob().timestamps, startedAt: null, completedAt: null },
    });
    expect(processJobTiming(queued)).toEqual({ startedAt: Date.parse("2026-07-17T10:00:00.000Z") });
  });
});

describe("processJobExitLabel", () => {
  it("names the exit code and the signal, and nothing when neither is known", () => {
    expect(processJobExitLabel(processJob())).toBe("exit 0");
    expect(processJobExitLabel(processJob({ exitCode: 137, signal: "SIGKILL" }))).toBe("exit 137 · SIGKILL");
    expect(processJobExitLabel(processJob({ exitCode: null, signal: "SIGTERM" }))).toBe("SIGTERM");
    expect(processJobExitLabel(processJob({ exitCode: null, signal: null }))).toBeUndefined();
  });
});

describe("ProcessJobPart", () => {
  it("collapses a finished job to one row and keeps the details behind it", () => {
    render(part({ type: "process-job", job: processJob(), responseText: "Completed normally." }));

    const row = screen.getByRole("group", { name: "Exec background job succeeded" });
    expect(row).toHaveClass("activity-row", "is-job", "is-complete");
    expect(row.querySelector(".activity-dot")).not.toBeNull();
    expect(within(row).getByText("Exec job")).toHaveClass("activity-row-label");
    expect(within(row).getByText("node worker.js --safe-summary")).toHaveClass("activity-row-summary");
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("succeeded · 2s · exit 0");
    expect(row.querySelector(".failed-tag")).toBeNull();
    // Secondary detail is behind the disclosure.
    expect(row).not.toHaveAttribute("open");
    expect(screen.getByText("Completed normally.")).not.toBeVisible();
    expect(screen.getByText(/stdout\.log/u)).not.toBeVisible();

    fireEvent.click(within(row).getByText("Exec job").closest("summary")!);
    expect(screen.getByText("Completed normally.")).toBeVisible();
    expect(screen.getByText("done")).toBeVisible();
    expect(screen.getByText(/artifacts\/11111111-1111-4111-8111-111111111111\/stdout\.log/u)).toBeVisible();
    expect(screen.getByText(/artifacts\/11111111-1111-4111-8111-111111111111\/stderr\.log/u)).toBeVisible();
    expect(screen.getByText("delivered (1 attempt)")).toBeVisible();
    expect(screen.getByText("Output")).toBeVisible();
    expect(screen.queryByText("Output (truncated)")).toBeNull();
  });

  it.each<[ProcessJobState, string]>([
    ["failed", "failed"],
    ["timed_out", "timed out"],
    ["cancelled", "cancelled"],
    ["interrupted", "interrupted"],
    ["spawn_failed", "spawn failed"],
    ["queue_expired", "queue expired"],
  ])("tags a %s job in the row instead of spelling the state in the meta", (state, label) => {
    render(part({
      type: "process-job",
      job: processJob({ state, exitCode: null, signal: "SIGKILL", durationMs: 12_000 }),
    }));

    const row = screen.getByRole("group", { name: `Exec background job ${label}` });
    expect(row).toHaveClass("is-failed");
    // The payload's State fact repeats the word; the row's tag is the one on the summary line.
    expect(within(row.querySelector("summary")!).getByText(label)).toHaveClass("failed-tag");
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("12s · SIGKILL");
    expect(row.querySelector(".activity-row-time")?.textContent).not.toContain(label);
  });

  it("surfaces a failed wake on the row and its error in the payload", () => {
    render(part({
      type: "process-job",
      job: processJob({
        wake: { ...processJob().wake, state: "failed", attempts: 3 },
        lastError: { code: "process_job_wake_failed", message: "Process-job wake delivery failed." },
      }),
    }));

    const row = screen.getByRole("group", { name: "Exec background job succeeded" });
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("succeeded · 2s · exit 0 · wake failed");
    fireEvent.click(row.querySelector("summary")!);
    const error = screen.getByText(/Process-job wake delivery failed/u).closest(".activity-error");
    expect(error).not.toBeNull();
    expect(error).toHaveTextContent("process_job_wake_failed");
    expect(screen.getByText("failed (3 attempts)")).toBeVisible();
  });

  it("marks truncated output and shows the preview and refs it has", () => {
    render(part({
      type: "process-job",
      job: processJob({
        output: { ...processJob().output, truncated: true, preview: "partial", stderrRef: null },
      }),
    }));
    fireEvent.click(screen.getByRole("group", { name: "Exec background job succeeded" }).querySelector("summary")!);
    expect(screen.getByText("Output (truncated)")).toBeVisible();
    expect(screen.getByText("partial")).toBeVisible();
    expect(screen.getByText(/stdout\.log/u)).toBeVisible();
    expect(screen.queryByText(/stderr\.log/u)).toBeNull();
  });

  it("ticks a running job once a second in server time and stops on a terminal poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:17.000Z"));
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
      .mockResolvedValue(complete);
    render(part({ type: "process-job", job: running }));

    const time = () => screen.getByRole("group", { name: /Exec background job/u }).querySelector(".activity-row-time");
    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group", { name: "Exec background job running" })).toHaveClass("is-running");
    expect(time()).toHaveTextContent("running · 16s");
    act(() => { vi.advanceTimersByTime(999); });
    expect(time()).toHaveTextContent("running · 16s");
    act(() => { vi.advanceTimersByTime(1); });
    // The poll's first retry (1 s) also fires here and returns the terminal projection.
    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).toHaveClass("is-complete");
    expect(time()).toHaveTextContent("succeeded · 2s · exit 0");
    act(() => { vi.advanceTimersByTime(30_000); });
    // Frozen at the reported duration, and no further poll.
    expect(time()).toHaveTextContent("succeeded · 2s · exit 0");
    expect(threadJob).toHaveBeenCalledTimes(2);
  });

  it("renders nothing for a part without a projection", () => {
    const { container } = render(part({ type: "process-job" }));
    expect(container).toBeEmptyDOMElement();
  });
});

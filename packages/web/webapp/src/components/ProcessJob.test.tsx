import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { processJob } from "../test/fixtures";
import type { ProcessJobState } from "../types";
import {
  ProcessJobPart,
  processJobAdvances,
  processJobExitLabel,
  processJobStatus,
  processJobSupersedes,
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

describe("processJobAdvances", () => {
  it("orders the lifecycle queued < starting < running < terminal", () => {
    expect(processJobAdvances("queued", "starting")).toBe(true);
    expect(processJobAdvances("starting", "running")).toBe(true);
    expect(processJobAdvances("queued", "succeeded")).toBe(true);
    expect(processJobAdvances("running", "timed_out")).toBe(true);
    expect(processJobAdvances("running", "starting")).toBe(false);
    expect(processJobAdvances("starting", "queued")).toBe(false);
  });

  it("treats the same state, and one terminal state against another, as no advance", () => {
    expect(processJobAdvances("running", "running")).toBe(false);
    expect(processJobAdvances("succeeded", "failed")).toBe(false);
    expect(processJobAdvances("cancelled", "running")).toBe(false);
  });
});

describe("processJobSupersedes", () => {
  const base = processJob();
  const at = (state: ProcessJobState, startedAt: string | null) => processJob({
    state,
    exitCode: null,
    durationMs: null,
    timestamps: { ...base.timestamps, startedAt, completedAt: null },
  });

  it("follows the lifecycle rank across states", () => {
    expect(processJobSupersedes(at("starting", null), at("running", "2026-07-17T10:00:01.000Z"))).toBe(true);
    expect(processJobSupersedes(at("starting", null), base)).toBe(true);
    expect(processJobSupersedes(at("running", "2026-07-17T10:00:01.000Z"), at("starting", null))).toBe(false);
    expect(processJobSupersedes(base, processJob({ state: "failed" }))).toBe(false);
  });

  it("accepts the one same-state enrichment the row renders: a start stamp the job did not have", () => {
    // The producer persists `starting`, then records the process start while
    // still `starting`, and only then moves to `running`.
    expect(processJobSupersedes(at("starting", null), at("starting", "2026-07-17T10:00:01.000Z"))).toBe(true);
  });

  it("rejects a same-state answer that adds nothing or would forget a known start", () => {
    expect(processJobSupersedes(at("starting", null), at("starting", null))).toBe(false);
    expect(processJobSupersedes(at("starting", "2026-07-17T10:00:01.000Z"), at("starting", null))).toBe(false);
    expect(processJobSupersedes(
      at("starting", "2026-07-17T10:00:01.000Z"),
      at("starting", "2026-07-17T10:00:02.000Z"),
    )).toBe(false);
    expect(processJobSupersedes(at("running", "2026-07-17T10:00:01.000Z"), at("running", "2026-07-17T10:00:01.000Z"))).toBe(false);
    expect(processJobSupersedes(at("queued", null), at("queued", null))).toBe(false);
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
    // The token is its own element inside the time slot: the phone layout lets
    // the meta wrap and relies on this element never splitting or clipping.
    const alert = row.querySelector(".activity-row-time .activity-row-alert");
    expect(alert).toHaveTextContent("wake failed");
    fireEvent.click(row.querySelector("summary")!);
    const error = screen.getByText(/Process-job wake delivery failed/u).closest(".activity-error");
    expect(error).not.toBeNull();
    expect(error).toHaveTextContent("process_job_wake_failed");
    expect(screen.getByText("failed (3 attempts)")).toBeVisible();
  });

  it("keeps the summary's slot order the phone layout is written against", () => {
    // styles.css places a job's tag and meta on a second line with sibling
    // selectors (`.failed-tag ~ .activity-row-time`), so the order of the
    // summary's children is a contract: glyph, label, purpose, tag, time, chevron.
    render(part({
      type: "process-job",
      job: processJob({ state: "timed_out", exitCode: null, signal: "SIGKILL", durationMs: 12_000, wake: { ...processJob().wake, state: "failed" } }),
    }));
    const summary = screen.getByRole("group", { name: "Exec background job timed out" }).querySelector("summary")!;
    expect([...summary.children].map((child) => (child.getAttribute("class") ?? "").split(" ")[0])).toEqual([
      "activity-row-glyph",
      "activity-row-label",
      "activity-row-summary",
      "failed-tag",
      "activity-row-time",
      "activity-row-chevron",
    ]);
    expect(summary.querySelector(".activity-row-time .activity-row-alert")).toHaveTextContent("wake failed");
  });

  const handoffFixtures = () => {
    const base = processJob();
    const pending = { ...base.wake, state: "pending" as const, attempts: 0, lastAttemptAt: null };
    return {
      starting: processJob({
        state: "starting",
        exitCode: null,
        durationMs: null,
        timestamps: { ...base.timestamps, startedAt: null, completedAt: null },
        wake: pending,
      }),
      running: processJob({
        state: "running",
        exitCode: null,
        durationMs: null,
        timestamps: { ...base.timestamps, completedAt: null },
        wake: pending,
      }),
      succeeded: base,
    };
  };

  it("does not let a poll answer that was in flight overwrite a newer projection from the store, and keeps polling", async () => {
    vi.useFakeTimers();
    const { starting, running } = handoffFixtures();
    let answerFirstPoll: ((job: typeof starting) => void) | undefined;
    const threadJob = vi.spyOn(api, "threadJob").mockImplementation(() => new Promise((resolve) => {
      answerFirstPoll ??= resolve;
    }));
    const { rerender } = render(part({ type: "process-job", job: starting }));
    expect(screen.getByRole("group", { name: "Exec background job starting" })).toBeInTheDocument();

    // The store refreshes the card while the first poll is still out.
    rerender(part({ type: "process-job", job: running }));
    expect(screen.getByRole("group", { name: "Exec background job running" })).toBeInTheDocument();

    // The poll answers with what it read before that: older than the row already shows.
    await act(async () => {
      answerFirstPoll!(starting);
      await Promise.resolve();
    });
    expect(screen.getByRole("group", { name: "Exec background job running" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Exec background job starting" })).toBeNull();

    // A dropped answer settles nothing, so the fallback poll must go on.
    expect(threadJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
  });

  it("takes the process start from a same-state starting answer and never forgets it again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:17.000Z"));
    const base = processJob();
    const pending = { ...base.wake, state: "pending" as const, attempts: 0, lastAttemptAt: null };
    const startingAt = (startedAt: string | null) => processJob({
      state: "starting",
      exitCode: null,
      durationMs: null,
      timestamps: { ...base.timestamps, startedAt, completedAt: null },
      wake: pending,
    });
    const beforeAttestation = startingAt(null);
    const afterAttestation = startingAt("2026-07-17T10:00:01.000Z");
    const threadJob = vi.spyOn(api, "threadJob")
      .mockResolvedValueOnce(afterAttestation)
      // A slower answer read before the attestation: still `starting`, start unknown.
      .mockResolvedValue(beforeAttestation);
    render(part({ type: "process-job", job: beforeAttestation }));

    const time = () => screen.getByRole("group", { name: "Exec background job starting" }).querySelector(".activity-row-time");
    // Before the start is known the row counts from admission (10:00:00).
    expect(time()).toHaveTextContent("starting · 17s");
    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);
    // The same state with the start recorded corrects the window to the process start (10:00:01).
    expect(time()).toHaveTextContent("starting · 16s");

    // The next poll answers with the pre-attestation record: the known start must not go back to null.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
    expect(time()).toHaveTextContent("starting · 17s");
  });

  it("settles the row when the in-flight poll answers with a terminal state after a store handoff", async () => {
    vi.useFakeTimers();
    const { starting, running, succeeded } = handoffFixtures();
    let answerFirstPoll: ((job: typeof starting) => void) | undefined;
    const threadJob = vi.spyOn(api, "threadJob").mockImplementation(() => new Promise((resolve) => {
      answerFirstPoll ??= resolve;
    }));
    const { rerender } = render(part({ type: "process-job", job: starting }));
    rerender(part({ type: "process-job", job: running }));
    expect(screen.getByRole("group", { name: "Exec background job running" })).toBeInTheDocument();

    // The lifecycle only moves forward, so a terminal answer is progress even
    // though the store moved the card while the request was out.
    await act(async () => {
      answerFirstPoll!(succeeded);
      await Promise.resolve();
    });
    const row = screen.getByRole("group", { name: "Exec background job succeeded" });
    expect(row).toHaveClass("is-complete");
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("succeeded · 2s · exit 0");

    // Settled: nothing more to ask for.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(1);
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

  it("keeps polling when a re-read hands it the same job back under a new object", async () => {
    // Every conversation read rebuilds the message and its parts, so the card is
    // handed a NEW object carrying the same job roughly once a second during a
    // turn. Treating each of those as "the stream just answered" suppressed
    // every poll round for the length of the turn -- the card only looked fresh
    // because the read that rebuilt it happened to carry the state.
    vi.useFakeTimers();
    const complete = processJob();
    const running = processJob({
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      exitCode: null,
      durationMs: null,
    });
    const threadJob = vi.spyOn(api, "threadJob").mockResolvedValue(running);
    const { rerender } = render(part({ type: "process-job", job: running }));

    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(600); });
    // Structurally identical, deeply cloned: a re-read, not a state change.
    rerender(part({
      type: "process-job",
      job: JSON.parse(JSON.stringify(running)) as typeof running,
    }));
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(threadJob).toHaveBeenCalledTimes(2);
  });

  it("renders nothing for a part without a projection", () => {
    const { container } = render(part({ type: "process-job" }));
    expect(container).toBeEmptyDOMElement();
  });
});

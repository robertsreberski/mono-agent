import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { DATA_MODE_STORAGE_KEY } from "../data-mode";
import { backgroundSubagentJob } from "../test/background-subagent-fixtures";
import { Icon } from "./Icon";
import { processJob } from "../test/fixtures";
import { RouteCapabilitiesProvider } from "./route-capabilities";
import { ToolCallRepairProvider } from "./tool-call-repair";
import type { ProcessJobState } from "../types";
import {
  ProcessJobPart,
  ProcessJobActivityEventPart,
  mergeProcessJobProjection,
  processJobAdvances,
  processJobExitLabel,
  processJobStatus,
  processJobSupersedes,
  processJobThreadId,
  processJobTiming,
  projectionSignature,
} from "./ProcessJob";

type ProcessJobProps = Parameters<typeof ProcessJobPart>[0];

// The component only reads `data`; assistant-ui supplies the rest of the part
// props, which this rendering never touches.
const part = (data: unknown) =>
  <ProcessJobPart {...({ data } as unknown as ProcessJobProps)} />;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.removeItem(DATA_MODE_STORAGE_KEY);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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

  it("accepts monotonic same-state output and cancellation enrichment without allowing regression", () => {
    const running = at("running", "2026-07-17T10:00:01.000Z");
    const withTail = processJob({
      ...running,
      output: { ...running.output, stdoutBytes: 12, preview: "STDOUT:\nworking" },
    });
    const cancelling = processJob({ ...withTail, cancelRequested: true });
    expect(processJobSupersedes(running, withTail)).toBe(true);
    expect(processJobSupersedes(withTail, cancelling)).toBe(true);
    expect(processJobSupersedes(withTail, running)).toBe(false);
    expect(processJobSupersedes(cancelling, withTail)).toBe(false);
  });

  it("accepts same-terminal wake enrichment but not a different terminal outcome", () => {
    const pending = processJob({ wake: { ...processJob().wake, state: "pending", attempts: 0 } });
    expect(processJobSupersedes(pending, processJob())).toBe(true);
    expect(processJobSupersedes(processJob(), processJob({ state: "failed" }))).toBe(false);
  });

  it("monotonically merges same-state terminal evidence one field at a time", () => {
    const empty = processJob({
      timestamps: { ...processJob().timestamps, runtimeDeadlineAt: null, completedAt: null },
      durationMs: null,
      exitCode: null,
      signal: null,
    });
    const completed = processJob({ ...empty, timestamps: { ...empty.timestamps, completedAt: "2026-07-17T10:00:03.000Z" } });
    const duration = processJob({
      ...empty,
      timestamps: { ...empty.timestamps, runtimeDeadlineAt: "2026-07-17T10:30:01.000Z" },
      durationMs: 2_000,
      exitCode: 0,
      signal: "SIGTERM",
    });
    const first = mergeProcessJobProjection(empty, completed);
    const merged = mergeProcessJobProjection(first, duration);
    expect(merged.timestamps.completedAt).toBe("2026-07-17T10:00:03.000Z");
    expect(merged.durationMs).toBe(2_000);
    expect(merged.exitCode).toBe(0);
    expect(merged.signal).toBe("SIGTERM");
    expect(merged.timestamps.runtimeDeadlineAt).toBe("2026-07-17T10:30:01.000Z");
    expect(mergeProcessJobProjection(merged, empty)).toBe(merged);
    expect(projectionSignature(merged)).not.toBe(projectionSignature(first));
  });

  it("rejects immutable identity changes and preserves byte/wake evidence independently", () => {
    const current = processJob({
      output: { ...processJob().output, stdoutBytes: 10, preview: "ten bytes" },
      wake: { ...processJob().wake, attempts: 2 },
    });
    expect(mergeProcessJobProjection(current, processJob({ summary: "different" }))).toBe(current);
    const regressed = processJob({
      ...current,
      output: { ...current.output, stdoutBytes: 1, preview: "x" },
      wake: { ...current.wake, attempts: 1, state: "pending" },
      timestamps: { ...current.timestamps, completedAt: "2026-07-17T10:00:05.000Z" },
    });
    const merged = mergeProcessJobProjection(current, regressed);
    expect(merged.output).toBe(current.output);
    expect(merged.wake).toBe(current.wake);
    expect(merged.timestamps.completedAt).toBe(current.timestamps.completedAt);
  });
});

describe("ProcessJobActivityEventPart", () => {
  type EventProps = Parameters<typeof ProcessJobActivityEventPart>[0];
  const eventPart = (data: unknown) =>
    <ProcessJobActivityEventPart {...({ data } as unknown as EventProps)} />;

  it("renders a pure semantic start row", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(eventPart({
      schema: "mono-agent.process-job-activity-event.v1",
      id: "process-job:job-1:started",
      toolCallId: "launch-1",
      jobId: "job-1",
      tool: "Exec",
      summary: "Generate the report",
      phase: "started",
      state: "running",
      occurredAt: "2026-07-17T10:00:01.000Z",
    }));
    const row = screen.getByRole("group", { name: "Exec job started" });
    expect(row).toHaveClass("is-job", "is-complete");
    expect(row.querySelector(".activity-job-icon")).toBeInTheDocument();
    expect(row.querySelector(".activity-dot")).toBeNull();
    expect(row.querySelector("time")).toHaveAttribute("datetime", "2026-07-17T10:00:01.000Z");
    expect(fetch).not.toHaveBeenCalled();
  });

  // "AgentSend" is retained history: renamed to "AgentManage" with no alias,
  // and stored lifecycle rows must keep rendering as subagent work.
  it.each(["Agent", "AgentManage", "AgentSend", "Bash", "Exec"] as const)("uses the correct glyph for both %s lifecycle rows", (tool) => {
    const expected = render(<Icon name={tool === "Bash" || tool === "Exec" ? "terminal" : "agent"} />);
    const glyph = expected.container.querySelector("svg")!.innerHTML;
    for (const phase of ["started", "terminal"] as const) {
      const view = render(eventPart({
        schema: "mono-agent.process-job-activity-event.v1",
        id: `process-job:job-1:${phase}`,
        toolCallId: "launch-1",
        jobId: "job-1",
        tool,
        summary: "Synthetic lifecycle fixture",
        phase,
        state: phase === "started" ? "running" : "succeeded",
        occurredAt: "2026-09-13T10:00:01.000Z",
      }));
      const row = screen.getByRole("group", { name: `${tool} job ${phase === "started" ? "started" : "succeeded"}` });
      expect(row.querySelector(".activity-job-icon")?.innerHTML).toBe(glyph);
      view.unmount();
    }
  });

  it("renders abnormal terminal facts and rejects malformed data", () => {
    const { rerender } = render(eventPart({
      schema: "mono-agent.process-job-activity-event.v1",
      id: "process-job:job-1:terminal",
      toolCallId: "launch-1",
      jobId: "job-1",
      tool: "Bash",
      summary: "Build assets",
      phase: "terminal",
      state: "timed_out",
      durationMs: 12_000,
      exitCode: 137,
      signal: "SIGKILL",
    }));
    const row = screen.getByRole("group", { name: "Bash job timed out" });
    expect(row).toHaveClass("is-failed");
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("12.0s · exit 137 · SIGKILL");
    rerender(eventPart({ schema: "wrong" }));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows the folded launch arguments alongside the job facts", () => {
    render(eventPart({
      schema: "mono-agent.process-job-activity-event.v1",
      id: "process-job:job-1:started",
      toolCallId: "launch-1",
      jobId: "job-1",
      tool: "Agent",
      summary: "Review the change",
      phase: "started",
      state: "running",
      occurredAt: "2026-07-17T10:00:01.000Z",
      launchArgs: { prompt: "Review the change", description: "Review the change" },
    }));
    const row = screen.getByRole("group", { name: "Agent job started" });
    // The model-authored description names the row; the launch arguments wait
    // behind the same disclosure as the job facts.
    expect(within(row).getByText("Review the change")).toHaveClass("activity-row-summary");
    fireEvent.click(row.querySelector("summary")!);
    expect(screen.getByText("Input")).toBeVisible();
    // The launch arguments render as JSON behind the disclosure, next to the
    // job facts that were already there.
    expect(screen.getByText(/"prompt": "Review the change"/u)).toBeVisible();
    expect(within(row).getByText("Job")).toBeVisible();
    expect(within(row).getByText("job-1")).toBeVisible();
  });

  it("offers a repair for a truncated launch preview", () => {
    const repair = vi.fn(async () => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {eventPart({
          schema: "mono-agent.process-job-activity-event.v1",
          id: "process-job:job-1:started",
          toolCallId: "launch-1",
          jobId: "job-1",
          tool: "Agent",
          summary: "Review the change",
          phase: "started",
          state: "running",
          occurredAt: "2026-07-17T10:00:01.000Z",
          launchArgs: "HEAD-",
          launchArgsTruncated: true,
          launchArgsBytes: 20 * 1_024,
        })}
      </ToolCallRepairProvider>,
    );
    const row = screen.getByRole("group", { name: "Agent job started" });
    fireEvent.click(row.querySelector("summary")!);
    expect(screen.getByText(/Preview only/u)).toBeVisible();
    expect(screen.getByText(/20,480 chars/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    expect(repair).toHaveBeenCalledWith("launch-1");
  });

  it("keeps rendering retained events without launch arguments", () => {
    render(eventPart({
      schema: "mono-agent.process-job-activity-event.v1",
      id: "process-job:job-1:started",
      toolCallId: "launch-1",
      jobId: "job-1",
      tool: "Exec",
      summary: "Generate the report",
      phase: "started",
      state: "running",
      occurredAt: "2026-07-17T10:00:01.000Z",
    }));
    const row = screen.getByRole("group", { name: "Exec job started" });
    fireEvent.click(row.querySelector("summary")!);
    expect(screen.queryByText("Input")).toBeNull();
    expect(within(row).getByText("job-1")).toBeVisible();
  });

  it("rejects unknown keys and orphan launch truncation flags", () => {
    const base = {
      schema: "mono-agent.process-job-activity-event.v1",
      id: "process-job:job-1:started",
      toolCallId: "launch-1",
      jobId: "job-1",
      tool: "Exec",
      summary: "Generate the report",
      phase: "started",
      state: "running",
      occurredAt: "2026-07-17T10:00:01.000Z",
    };
    const { rerender } = render(eventPart({ ...base, launchArgs: { command: "run" }, extra: true }));
    expect(screen.queryByRole("group")).toBeNull();
    rerender(eventPart({ ...base, launchArgsTruncated: true }));
    expect(screen.queryByRole("group")).toBeNull();
    rerender(eventPart({ ...base, launchArgsBytes: 12 }));
    expect(screen.queryByRole("group")).toBeNull();
    rerender(eventPart({ ...base, launchArgs: { command: "run" }, launchArgsTruncated: true }));
    expect(screen.getByRole("group", { name: "Exec job started" })).toBeInTheDocument();
  });
});

describe("ProcessJobPart", () => {
  it("collapses a finished job to one row and keeps the details behind it", () => {
    render(part({ type: "process-job", job: processJob(), responseText: "Completed normally." }));

    const row = screen.getByRole("group", { name: "Exec background job succeeded" });
    expect(row).toHaveClass("activity-row", "is-job", "is-complete");
    expect(row.querySelector(".activity-job-icon")).toBeInTheDocument();
    expect(row.querySelector(".activity-dot")).toBeNull();
    expect(within(row).getByText("Exec job")).toHaveClass("activity-row-label");
    expect(within(row).getByText("node worker.js --safe-summary")).toHaveClass("activity-row-summary");
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("succeeded · 2s · exit 0");
    expect(row.querySelector(".failed-tag")).toBeNull();
    // Secondary detail is behind the disclosure.
    expect(row).not.toHaveAttribute("open");
    expect(screen.getByText("Completed normally.")).not.toBeVisible();

    fireEvent.click(within(row).getByText("Exec job").closest("summary")!);
    expect(screen.getByText("Completed normally.")).toBeVisible();
    expect(screen.getByText("done")).toBeVisible();
    // The card shows the job's output, never the host-local files it was spooled to.
    expect(screen.queryByText(/artifacts\/11111111-1111-4111-8111-111111111111\//u)).toBeNull();
    expect(row.querySelector(".process-job-live-meta")).toBeNull();
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
    // The row's tag is the one retained state label; the payload no longer repeats it.
    expect(within(row.querySelector("summary")!).getByText(label)).toHaveClass("failed-tag");
    expect(row.querySelector(".activity-row-time")).toHaveTextContent("12s · SIGKILL");
    expect(row.querySelector(".activity-row-time")?.textContent).not.toContain(label);
    expect(row.querySelector(".process-job-live-meta")).toHaveTextContent("SIGKILL");
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
    expect(row.querySelector(".process-job-live-meta")).toHaveTextContent("wake failed (3 attempts)");
  });

  it("shows receipt uncertainty without claiming a definite delivery failure", () => {
    render(part({ type: "process-job", job: processJob({
      wake: { ...processJob().wake, state: "unknown", attempts: 1 },
      lastError: { code: "process_job_wake_unknown", message: "Process-job wake delivery outcome is unknown; replay was suppressed." },
    }) }));
    const row = screen.getByRole("group", { name: "Exec background job succeeded" });
    expect(row.querySelector(".activity-row-alert")).toHaveTextContent("wake outcome unknown · replay suppressed");
    expect(row).not.toHaveTextContent("wake failed");
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

  it("marks truncated output and shows the preview it has without the spool paths", () => {
    render(part({
      type: "process-job",
      job: processJob({
        output: { ...processJob().output, truncated: true, preview: "partial", stderrRef: null },
      }),
    }));
    fireEvent.click(screen.getByRole("group", { name: "Exec background job succeeded" }).querySelector("summary")!);
    expect(screen.getByText("Output (truncated)")).toBeVisible();
    expect(screen.getByText("partial")).toBeVisible();
    expect(screen.queryByText("Artifacts")).toBeNull();
    expect(screen.queryByText(/stdout\.log/u)).toBeNull();
  });

  it("says a running job has no output yet instead of showing an empty card", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const complete = processJob();
    const view = render(part({
      type: "process-job",
      job: processJob({
        state: "running",
        timestamps: { ...complete.timestamps, completedAt: null },
        wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
        output: { ...complete.output, stdoutBytes: 0, stderrBytes: 0, preview: "" },
        exitCode: null,
        durationMs: null,
      }),
    }));
    fireEvent.click(screen.getByRole("group", { name: "Exec background job running" }).querySelector("summary")!);
    expect(screen.getByText("No output yet.")).toBeVisible();
    expect(view.container.querySelector(".process-job-output")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("says a settled job produced no output at all", () => {
    render(part({
      type: "process-job",
      job: processJob({ output: { ...processJob().output, stdoutBytes: 0, stderrBytes: 0, preview: "" } }),
    }));
    fireEvent.click(screen.getByRole("group", { name: "Exec background job succeeded" }).querySelector("summary")!);
    expect(screen.getByText("No output.")).toBeVisible();
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

  it("auto-opens on first live output, keeps one-second polling, and respects a manual collapse", async () => {
    vi.useFakeTimers();
    const complete = processJob();
    const running = processJob({
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      output: { ...complete.output, stdoutBytes: 0, stderrBytes: 0, preview: "" },
      exitCode: null,
      durationMs: null,
    });
    const firstTail = processJob({
      ...running,
      output: { ...running.output, stdoutBytes: 4, preview: "STDOUT:\none" },
    });
    const secondTail = processJob({
      ...running,
      output: { ...running.output, stdoutBytes: 8, preview: "STDOUT:\none\ntwo" },
    });
    const threadJob = vi.spyOn(api, "threadJob")
      .mockResolvedValueOnce(firstTail)
      .mockResolvedValueOnce(secondTail)
      .mockResolvedValue(complete);
    const { rerender } = render(part({ type: "process-job", job: running }));

    await act(async () => { await Promise.resolve(); });
    const row = screen.getByRole("group", { name: "Exec background job running" });
    expect(row).toHaveAttribute("open");
    expect(row.querySelector(".process-job-output")).toHaveTextContent("STDOUT: one");

    fireEvent.click(row.querySelector("summary")!);
    expect(row).not.toHaveAttribute("open");
    await act(async () => {
      vi.advanceTimersByTime(999);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
    expect(row).not.toHaveAttribute("open");

    // A delayed same-state card repair with empty output cannot erase the poll.
    rerender(part({ type: "process-job", job: running }));
    expect(row.querySelector(".process-job-output")).toHaveTextContent("STDOUT: one two");
    expect(row).not.toHaveAttribute("open");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("group", { name: "Exec background job succeeded" })).not.toHaveAttribute("open");
  });

  it("backs off queued and failed reads while preserving the retained row", async () => {
    vi.useFakeTimers();
    const complete = processJob();
    const queued = processJob({
      state: "queued",
      timestamps: { ...complete.timestamps, startedAt: null, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      output: { ...complete.output, stdoutBytes: 0, stderrBytes: 0, preview: "" },
      exitCode: null,
      durationMs: null,
    });
    const threadJob = vi.spyOn(api, "threadJob").mockRejectedValue(new Error("offline"));
    render(part({ type: "process-job", job: queued }));
    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("group", { name: "Exec background job queued" })).toBeInTheDocument();
  });

  it("follows a growing tail only while the operator remains near its bottom", async () => {
    const complete = processJob();
    const running = processJob({
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      output: { ...complete.output, stdoutBytes: 4, preview: "STDOUT:\none" },
      exitCode: null,
      durationMs: null,
    });
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const { rerender } = render(part({ type: "process-job", job: running }));
    const output = screen.getByRole("group", { name: "Exec background job running" })
      .querySelector<HTMLPreElement>(".process-job-output")!;
    Object.defineProperties(output, {
      scrollHeight: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(output);
    rerender(part({
      type: "process-job",
      job: processJob({
        ...running,
        output: { ...running.output, stdoutBytes: 8, preview: "STDOUT:\none\ntwo" },
      }),
    }));
    expect(output.scrollTop).toBe(0);

    output.scrollTop = 100;
    fireEvent.scroll(output);
    rerender(part({
      type: "process-job",
      job: processJob({
        ...running,
        output: { ...running.output, stdoutBytes: 12, preview: "STDOUT:\none\ntwo\nthree" },
      }),
    }));
    expect(output.scrollTop).toBe(200);
  });

  it("uses the lean running cadence instead of polling again after one second", async () => {
    vi.useFakeTimers();
    localStorage.setItem(DATA_MODE_STORAGE_KEY, "lean");
    const complete = processJob();
    const running = processJob({
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      exitCode: null,
      durationMs: null,
    });
    const threadJob = vi.spyOn(api, "threadJob").mockResolvedValue(running);
    render(part({ type: "process-job", job: running }));

    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
  });

  it("treats a store projection with more output bytes as fresh before re-arming the poll", async () => {
    vi.useFakeTimers();
    const complete = processJob();
    const running = processJob({
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      output: { ...complete.output, stdoutBytes: 0, stderrBytes: 0, preview: "" },
      exitCode: null,
      durationMs: null,
    });
    const threadJob = vi.spyOn(api, "threadJob").mockResolvedValue(running);
    const { rerender } = render(part({ type: "process-job", job: running }));

    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(600); });
    rerender(part({
      type: "process-job",
      job: processJob({
        ...running,
        output: { ...running.output, stdoutBytes: 4, preview: "STDOUT:\none" },
      }),
    }));
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(threadJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(2);
  });

  it("polls nothing while hidden and reads immediately whenever the document returns", async () => {
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
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    render(part({ type: "process-job", job: running }));

    await act(async () => { await Promise.resolve(); });
    expect(threadJob).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(threadJob).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await Promise.resolve(); });
    expect(threadJob).toHaveBeenCalledTimes(2);
  });

  it("renders nothing for a part without a projection", () => {
    const { container } = render(part({ type: "process-job" }));
    expect(container).toBeEmptyDOMElement();
  });
});

it.each(["queued", "starting", "running"] as const)("hides unresolved internal child ownership while %s", (state) => {
  vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
  const base = processJob();
  const job = processJob({ tool: "Agent", kind: "internal", instanceId: "helper", state, childStillBusy: true,
    timestamps: { ...base.timestamps, startedAt: state === "queued" ? null : base.timestamps.startedAt, completedAt: null },
    durationMs: null, exitCode: null, wake: { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null } });
  render(part({ type: "process-job", job }));
  const row = screen.getByRole("group", { name: `Agent background job ${state}` });
  expect(within(row).queryByText("child still busy · awaiting actual settlement")).toBeNull();
  expect(row.querySelector(".activity-row-alert")).toBeNull();
});

it.each(["succeeded", "failed", "timed_out", "cancelled", "spawn_failed", "queue_expired", "interrupted"] as const)(
  "shows unresolved internal child ownership after %s",
  (state) => {
    const job = processJob({ tool: "Agent", kind: "internal", instanceId: "helper", state, childStillBusy: true });
    render(part({ type: "process-job", job }));
    const row = screen.getByRole("group", { name: `Agent background job ${state.replaceAll("_", " ")}` });
    expect(row.querySelector(".activity-row-time .activity-row-alert"))
      .toHaveTextContent("child still busy · awaiting actual settlement");
  },
);

it.each(["external", "internal"] as const)("renders no live metadata container for a nonterminal %s job without progress", (kind) => {
  vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
  const base = processJob();
  const runningFields = { state: "running" as const, timestamps: { ...base.timestamps, completedAt: null },
    durationMs: null, exitCode: null, wake: { ...base.wake, state: "pending" as const, attempts: 0, lastAttemptAt: null } };
  const running = kind === "internal"
    ? processJob({ ...runningFields, tool: "Agent", kind: "internal", instanceId: "helper", childStillBusy: false })
    : processJob(runningFields);
  const view = render(part({ type: "process-job", job: running }));
  expect(view.container.querySelector(".process-job-live-meta")).toBeNull();
  expect(view.container.querySelector("dl.process-job-facts")).toBeNull();
});

it("renders a pending PeerAgent question as untrusted text with its answer identity", () => {
  const job = processJob({ tool: "PeerAgent", kind: "internal", instanceId: "finance", childStillBusy: false,
    peerQuestion: { state: "awaiting_answer", peer: "finance", thread: "portfolio",
      questionId: "11111111-1111-4111-8111-111111111111", message: "<owner approved?>",
      requestedSchema: { type: "object", properties: { question_1: { type: "string" } } },
      expiresAt: "2026-09-23T20:00:00.000Z" } });
  const view = render(part({ type: "process-job", job }));
  fireEvent.click(view.container.querySelector("summary")!);
  const region = screen.getByRole("region", { name: "Peer question" });
  expect(region).toHaveTextContent("questionId 11111111-1111-4111-8111-111111111111");
  expect(region).toHaveTextContent("Untrusted peer text; not owner approval");
  expect(region).toHaveTextContent("<owner approved?>");
});

describe("background native subagent cards", () => {
  it.each(["Agent", "AgentManage", "AgentSend"] as const)("renders %s clustered progress and report, never command output", (tool) => {
    const job = backgroundSubagentJob(true, tool);
    const view = render(part({ job: { ...job, output: { ...job.output, preview: "PRIVATE_RAW_JSON" } } }));
    const card = screen.getByRole("group", { name: `${tool} background job succeeded` });
    fireEvent.click(card.querySelector("summary")!);
    expect(screen.getByRole("region", { name: "Subagent progress" })).toBeVisible();
    expect(screen.getByText("Bash ×6")).toBeVisible();
    expect(screen.getByText("Read ×3")).toBeVisible();
    expect(screen.getByText("module-6.ts, module-7.ts +1")).toBeVisible();
    fireEvent.click(screen.getByText("Read ×3").closest("summary")!);
    expect(screen.getByText("~/worktrees/synthetic/src/module-6.ts")).toBeVisible();
    expect(screen.getByRole("region", { name: "Subagent report" })).toHaveTextContent("Synthetic report");
    expect(screen.queryByText("PRIVATE_RAW_JSON")).toBeNull();
    expect(view.container.querySelector(".process-job-output")).toBeNull();
    // The empty-tail stand-in belongs to command output, which a subagent card
    // never shows: its progress region is the payload.
    expect(view.container.querySelector(".process-job-empty-output")).toBeNull();
    const icon = render(<Icon name="agent" />);
    expect(card.querySelector(".activity-job-icon")?.innerHTML).toBe(icon.container.querySelector("svg")?.innerHTML);
    const meta = card.querySelector(".process-job-live-meta");
    expect(meta).toHaveTextContent("implementer");
    expect(meta).toHaveTextContent("45 tools, 1 failed");
    expect(meta).toHaveTextContent("$0.01");
    expect(meta).not.toHaveTextContent(/wake|exit|signal/iu);
    expect(meta?.querySelector("dt")).toBeNull();
    expect(screen.getByRole("img", { name: /Ran with anthropic:claude-sonnet-4\.5/u })).not.toHaveClass("is-requested");
  });

  it("shows requested route and one compact unlabelled metadata line while a child is running", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const view = render(part({ job: backgroundSubagentJob() }));
    const meta = view.container.querySelector(".process-job-live-meta");
    expect(meta).toHaveTextContent("implementer");
    expect(meta).toHaveTextContent("45 tools, 1 failed");
    expect(meta).not.toHaveTextContent("$");
    expect(meta?.querySelectorAll("dt")).toHaveLength(0);
    expect(meta?.querySelectorAll(".route-badge")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /requested, not a confirmed run/u })).toHaveClass("is-requested");
  });

  it("flags a fallback route and omits the route badge for legacy progress", () => {
    const job = backgroundSubagentJob(true);
    const fallback = { ...job, subagentProgress: { ...job.subagentProgress!, route: {
      requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
      executed: { model: "openai-codex:gpt-5.6-sol", effort: "xhigh", effectiveEffort: "max" },
      disposition: "fallback" as const,
    } } };
    const view = render(part({ job: fallback }));
    fireEvent.click(screen.getByRole("group", { name: "Agent background job succeeded" }).querySelector("summary")!);
    const badge = screen.getByRole("img", { name: /Fallback: anthropic:claude-sonnet-4\.5 → openai-codex:gpt-5\.6-sol/u });
    expect(badge).toHaveClass("is-fallback");
    expect(badge.querySelector(".route-badge-flag")).toHaveTextContent("!");

    const { route: _route, costUsd: _costUsd, ...legacyProgress } = job.subagentProgress!;
    view.unmount();
    const legacy = render(part({ job: { ...job, subagentProgress: legacyProgress } }));
    fireEvent.click(screen.getByRole("group", { name: "Agent background job succeeded" }).querySelector("summary")!);
    expect(legacy.container.querySelector(".route-badge")).toBeNull();
    expect(legacy.container.querySelector(".process-job-live-meta")).toHaveTextContent("implementer·45 tools, 1 failed");
    expect(legacy.container.querySelector(".process-job-live-meta")).not.toHaveTextContent("$");
  });

  it("normalizes a retained empty executed route back to requested-only", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const job = backgroundSubagentJob();
    render(part({ job: { ...job, subagentProgress: { ...job.subagentProgress!, route: {
      requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
      executed: {},
      disposition: "requested" as const,
    } } } }));
    const badge = screen.getByRole("img", { name: /requested, not a confirmed run/u });
    expect(badge).toHaveClass("is-requested");
    expect(badge).toHaveTextContent("Sonnet 4.5·high");
    expect(badge).not.toHaveTextContent("—");
  });

  it("renders effort bars when the owning catalog knows the model's ladder, with text as the unknown-catalog fallback", () => {
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const job = backgroundSubagentJob();
    const view = render(<RouteCapabilitiesProvider agent={null} catalogByProvider={{ anthropic: { models: [{
      id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic", providerLabel: "Anthropic",
      reasoning: true, effortLevels: ["low", "medium", "high"],
    }] } }}>{part({ job })}</RouteCapabilitiesProvider>);
    expect(view.container.querySelector(".effort-signal")).toHaveAttribute("data-levels", "3");
    expect(view.container.querySelector(".effort-signal")).toHaveAttribute("data-filled", "3");
    expect(view.container.querySelector(".route-badge-effort")).toBeNull();

    view.rerender(part({ job }));
    expect(view.container.querySelector(".effort-signal")).toBeNull();
    expect(view.container.querySelector(".route-badge-effort")).toHaveTextContent("high");
  });

  it("styles retained-progress notes separately from the empty state", () => {
    const job = backgroundSubagentJob(true);
    const extra = Array.from({ length: 5 }, (_, index) => ({
      ...job.subagentProgress!.recent[index]!,
      id: `extra-${String(index)}`,
    }));
    render(part({ job: { ...job, subagentProgress: { ...job.subagentProgress!, toolCalls: 60,
      recent: [...job.subagentProgress!.recent, ...extra] } } }));
    fireEvent.click(screen.getByRole("group", { name: "Agent background job succeeded" }).querySelector("summary")!);
    expect(screen.getByText("Showing the latest 50 of 60 calls.")).toHaveClass("process-job-subagent-note");
  });

  it("auto-opens on progress and preserves manual collapse and newer revisions", async () => {
    const job = backgroundSubagentJob();
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const view = render(part({ job }));
    const card = screen.getByRole("group", { name: "Agent background job running" });
    expect(card).toHaveAttribute("open");
    fireEvent.click(card.querySelector("summary")!);
    view.rerender(part({ job: backgroundSubagentJob(true) }));
    expect(card).not.toHaveAttribute("open");
    const stale = { ...job, subagentProgress: { ...job.subagentProgress!, revision: 1, toolCalls: 0, recent: [] } };
    expect(mergeProcessJobProjection(job, stale)).toEqual(job);
    const { subagentProgress: _progress, ...legacy } = job;
    expect(mergeProcessJobProjection(job, legacy)).toEqual(job);
  });
});

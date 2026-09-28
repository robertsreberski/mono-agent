import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../test/fixtures";
import { backgroundSubagentJob } from "../test/background-subagent-fixtures";
import type { ProcessJobProjection } from "../types";
import "../styles.css";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  api: { threadJob: vi.fn() },
}));

import { api } from "../api";
import { ProcessJobPresentationProvider } from "../process-job-presentation";
import { ProcessJobStack } from "./ProcessJobStack";

/**
 * Real-Chromium evidence for the shelf's interaction contracts: focus recovery
 * when a row leaves view, DOM identity and disclosure through settlement, and
 * the output tail / subagent rail reading position across a closed shelf.
 * Synthetic fixtures only.
 */
const base = processJob();
const startedAt = new Date(Date.now() - 4 * 60 * 1_000).toISOString();
const lines = (count: number) => `STDOUT:\n${Array.from({ length: count }, (_, index) => `watered bed ${String(index + 1)}`).join("\n")}`;
const running = (jobId: string, lineCount = 3, summary = `Purpose: Water ${jobId}`): ProcessJobProjection => processJob({
  jobId, state: "running", summary,
  timestamps: { ...base.timestamps, admittedAt: startedAt, startedAt, completedAt: null },
  wake: { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null },
  output: { ...base.output, stdoutBytes: lineCount * 16, preview: lines(lineCount) },
  exitCode: null, durationMs: null,
});
const settled = (job: ProcessJobProjection): ProcessJobProjection => processJob({
  ...job, state: "succeeded",
  timestamps: { ...job.timestamps, completedAt: new Date().toISOString() },
  wake: { ...base.wake }, exitCode: 0, durationMs: 4 * 60 * 1_000,
});

const shelf = (jobs: readonly ProcessJobProjection[], extra?: React.ReactNode) => (
  <main style={{ width: "100%", maxWidth: 880, margin: "0 auto" }}>
    {extra}
    <ProcessJobPresentationProvider threadId="thread" messages={[]} historyIsBounded={false}
      jobs={jobs.map((job) => ({ messageId: `message-${job.jobId}`, part: { type: "process-job" as const, job } }))}>
      <ProcessJobStack />
    </ProcessJobPresentationProvider>
  </main>
);

const frames = async (count = 2) => {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const shelfToggle = () => screen.getByRole("button", { name: /^Background jobs/u });
const historyToggle = () => screen.getByRole("button", { name: "Background job history" });
const card = (container: HTMLElement, jobId: string) =>
  [...container.querySelectorAll<HTMLElement>(".process-job-card")].find((node) =>
    node.querySelector(".process-job-title")?.getAttribute("title") === `Purpose: Water ${jobId}`)!;
const atBottom = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop <= 2;

beforeEach(async () => {
  vi.mocked(api.threadJob).mockImplementation(() => new Promise(() => undefined));
  await page.viewport(1280, 850);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("background jobs shelf interaction in Chromium", () => {
  it.each(["summary", "output"] as const)("hands focus from a settling row's %s to History, never leaving it on the page body", async (where) => {
    const job = running("north-bed", 40);
    const view = render(shelf([job, running("south-bed")]));
    fireEvent.click(shelfToggle());
    const row = card(view.container, "north-bed");
    fireEvent.click(row.querySelector("summary")!);
    await frames();
    const target = where === "summary" ? row.querySelector<HTMLElement>("summary")! : row.querySelector<HTMLElement>(".process-job-output")!;
    target.focus();
    expect(document.activeElement).toBe(target);

    view.rerender(shelf([settled(job), running("south-bed")]));
    await frames();

    expect(row.closest(".process-job-stack-item")).toHaveAttribute("hidden");
    expect(document.activeElement).toBe(historyToggle());
  });

  it("never moves focus that sits in the composer when a row settles", async () => {
    const job = running("north-bed");
    const composer = <textarea aria-label="Composer" />;
    const view = render(shelf([job], composer));
    fireEvent.click(shelfToggle());
    const textbox = screen.getByRole("textbox", { name: "Composer" });
    textbox.focus();
    view.rerender(shelf([settled(job)], composer));
    await frames();
    expect(document.activeElement).toBe(textbox);
  });

  it("hands focus to History when a focused question row reaches its deadline", async () => {
    const peer = processJob({
      jobId: "peer", tool: "PeerAgent", kind: "internal", instanceId: "seed-bank", childStillBusy: false,
      summary: "Ask the seed-bank agent", peerQuestion: {
        state: "awaiting_answer", questionId: "q-1", peer: "seed-bank", thread: "spring-orders",
        message: "Reserve the heirloom seeds now?", requestedSchema: {}, expiresAt: new Date(Date.now() + 1_200).toISOString(),
      },
    } as Parameters<typeof processJob>[0]);
    const view = render(shelf([peer]));
    fireEvent.click(shelfToggle());
    const summary = view.container.querySelector<HTMLElement>(".process-job-card > summary")!;
    summary.focus();
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await frames();
    expect(summary.closest(".process-job-stack-item")).toHaveAttribute("hidden");
    expect(document.activeElement).toBe(historyToggle());
  });

  it("keeps a settling row's node and disclosure, and a selection in another row, through the move", async () => {
    const north = running("north-bed");
    const south = running("south-bed");
    const view = render(shelf([north, south]));
    fireEvent.click(shelfToggle());
    const northCard = card(view.container, "north-bed");
    const northItem = northCard.closest(".process-job-stack-item")!;
    fireEvent.click(northCard.querySelector("summary")!);
    expect(northCard).toHaveAttribute("open");

    // The operator is selecting text in the row that keeps running.
    const southTitle = card(view.container, "south-bed").querySelector(".process-job-title")!;
    const range = document.createRange();
    range.selectNodeContents(southTitle);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("Water south-bed");

    view.rerender(shelf([settled(north), south]));
    await frames();

    expect(northItem).toHaveAttribute("hidden");
    expect(card(view.container, "north-bed")).toBe(northCard);
    expect(northCard.closest(".process-job-stack-item")).toBe(northItem);
    expect(northCard).toHaveAttribute("open");
    expect(window.getSelection()!.toString()).toBe("Water south-bed");

    fireEvent.click(historyToggle());
    expect(northItem).not.toHaveAttribute("hidden");
    expect(card(view.container, "north-bed")).toBe(northCard);
    expect(northCard).toHaveAttribute("open");
    expect(northCard).toHaveClass("is-complete");
  });

  it("shows a following tail's newest lines after output arrived behind a closed shelf", async () => {
    const view = render(shelf([running("north-bed", 20)]));
    fireEvent.click(shelfToggle());
    fireEvent.click(card(view.container, "north-bed").querySelector("summary")!);
    await frames();
    const output = card(view.container, "north-bed").querySelector<HTMLElement>(".process-job-output")!;
    expect(output.scrollHeight).toBeGreaterThan(output.clientHeight);
    expect(atBottom(output)).toBe(true);

    fireEvent.click(shelfToggle());
    view.rerender(shelf([running("north-bed", 60)]));
    await frames();
    fireEvent.click(shelfToggle());
    await frames();

    expect(output).toHaveTextContent("watered bed 60");
    expect(atBottom(output)).toBe(true);
  });

  it("keeps a reader's tail position after output arrived behind a closed shelf", async () => {
    const view = render(shelf([running("north-bed", 40)]));
    fireEvent.click(shelfToggle());
    fireEvent.click(card(view.container, "north-bed").querySelector("summary")!);
    await frames();
    const output = card(view.container, "north-bed").querySelector<HTMLElement>(".process-job-output")!;
    output.scrollTop = 60;
    fireEvent.scroll(output);
    await frames();

    fireEvent.click(shelfToggle());
    view.rerender(shelf([running("north-bed", 70)]));
    await frames();
    fireEvent.click(shelfToggle());
    await frames();

    expect(output.scrollTop).toBe(60);
  });

  it("keeps the subagent rail following, or at a reader's position, across a closed shelf and a report", async () => {
    const runningAgent = backgroundSubagentJob();
    const finishedAgent = backgroundSubagentJob(true);
    const agentCard = (container: HTMLElement) => container.querySelector<HTMLElement>(".process-job-card[data-kind='agent']")!;

    // Following: the report that arrives behind a closed shelf is what shows on reveal.
    const view = render(shelf([runningAgent]));
    fireEvent.click(shelfToggle());
    fireEvent.click(agentCard(view.container).querySelector("summary")!);
    await frames();
    const rail = agentCard(view.container).querySelector<HTMLElement>(".process-job-subagent-progress")!;
    expect(atBottom(rail)).toBe(true);
    fireEvent.click(shelfToggle());
    view.rerender(shelf([finishedAgent]));
    await frames();
    fireEvent.click(shelfToggle());
    fireEvent.click(historyToggle());
    await frames();
    expect(agentCard(view.container)).toHaveAttribute("open");
    expect(atBottom(rail)).toBe(true);
    const report = rail.querySelector<HTMLElement>(".process-job-subagent-report")!;
    expect(report.getBoundingClientRect().bottom).toBeLessThanOrEqual(rail.getBoundingClientRect().bottom + 1);
    cleanup();

    // Reading: a scrolled-up position survives the same sequence.
    const reading = render(shelf([runningAgent]));
    fireEvent.click(shelfToggle());
    fireEvent.click(agentCard(reading.container).querySelector("summary")!);
    await frames();
    const readerRail = agentCard(reading.container).querySelector<HTMLElement>(".process-job-subagent-progress")!;
    readerRail.scrollTop = 30;
    fireEvent.scroll(readerRail);
    await frames();
    fireEvent.click(shelfToggle());
    reading.rerender(shelf([finishedAgent]));
    await frames();
    fireEvent.click(shelfToggle());
    fireEvent.click(historyToggle());
    await frames();
    expect(readerRail.scrollTop).toBe(30);
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
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

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    emulateColorScheme(colorScheme: "light" | "dark" | null): Promise<void>;
    emulateReducedMotion(reducedMotion: "reduce" | "no-preference" | null): Promise<void>;
  }
}

/**
 * Screenshot evidence is opt-in, like the other job suites:
 * `VITE_JOB_STACK_SHOTS=<absolute dir>` writes the shots; CI runs the same
 * layout assertions without writing anything.
 */
const shotDirectory = import.meta.env.VITE_JOB_STACK_SHOTS as string | undefined;
const capture = async (name: string, element: Element): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.elementLocator(element).screenshot({ path: `${shotDirectory}/${name}.png` });
};

/** Synthetic fixtures: hand-written purposes and states, no recorded session. */
const base = processJob();
const startedAt = new Date(Date.now() - 4 * 60 * 1_000).toISOString();
const running = (jobId: string, summary = "Purpose: Run the planting-calendar test suite"): ProcessJobProjection => processJob({
  jobId, state: "running", summary,
  timestamps: { ...base.timestamps, admittedAt: startedAt, startedAt, completedAt: null },
  wake: { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null },
  output: { ...base.output, stdoutBytes: 64, preview: "STDOUT:\n✓ beds/north.test.ts (12 tests)\nrunning calendar/frost-dates.test.ts" },
  exitCode: null, durationMs: null,
});
const busy = { ...backgroundSubagentJob(true), jobId: "agent-busy", state: "cancelled" as const, childStillBusy: true, exitCode: null,
  wake: { ...base.wake, state: "unknown" as const } };
const failed = processJob({ jobId: "failed", state: "failed", exitCode: 1, summary: "Purpose: Lint the seed catalog",
  wake: { ...base.wake, state: "failed" } });
const mixed = [running("one"), running("two"), backgroundSubagentJob(), busy, failed, processJob({ jobId: "done" })];

const shelf = (jobs: readonly ProcessJobProjection[]) => (
  <main style={{ width: "100%", maxWidth: 880, margin: "0 auto", padding: "0 8px", boxSizing: "border-box" }}>
    <ProcessJobPresentationProvider threadId="thread" messages={[]} historyIsBounded={false}
      jobs={jobs.map((job) => ({ messageId: `message-${job.jobId}`, part: { type: "process-job" as const, job } }))}>
      <ProcessJobStack />
    </ProcessJobPresentationProvider>
  </main>
);

const noOverflow = (element: Element) => expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);

beforeEach(async () => {
  vi.mocked(api.threadJob).mockImplementation(() => new Promise(() => undefined));
});

afterEach(async () => {
  cleanup();
  await commands.emulateColorScheme(null);
  await commands.emulateReducedMotion(null);
  vi.restoreAllMocks();
});

describe("the background jobs shelf in Chromium", () => {
  it.each([
    { name: "desktop", width: 1280, height: 850, barMax: 48 },
    { name: "phone", width: 390, height: 844, barMax: 48 },
    { name: "narrow", width: 320, height: 720, barMax: 48 },
  ])("keeps one closed line and an open shelf within its cap at $name", async ({ name, width, height, barMax }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.viewport(width, height);
      await commands.emulateColorScheme(scheme);
      const view = render(shelf(mixed));
      const stack = view.container.querySelector<HTMLElement>(".process-job-stack")!;
      const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;

      // Glance: one line at normal text size, counts never pushed out.
      expect(stack.getBoundingClientRect().height).toBeLessThanOrEqual(barMax);
      noOverflow(toggle);
      noOverflow(stack);
      for (const chip of toggle.querySelectorAll(".process-job-chip")) {
        expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(toggle.getBoundingClientRect().right + 1);
      }
      await capture(`job-stack-glance-${name}-${scheme}`, stack);

      // Inspect and History: capped, every status line wraps inside its row.
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole("button", { name: "Background job history" }));
      const cap = Math.min(height * 0.4, width <= 560 ? 300 : 360);
      expect(stack.getBoundingClientRect().height).toBeLessThanOrEqual(cap + 1);
      for (const meta of view.container.querySelectorAll(".process-job-stack-item:not([hidden]) .process-job-meta")) {
        noOverflow(meta);
        const row = meta.closest(".process-job-card")!.getBoundingClientRect();
        for (const alert of meta.querySelectorAll(".process-job-alert")) {
          const box = alert.getBoundingClientRect();
          expect(box.right).toBeLessThanOrEqual(row.right + 1);
          expect(box.left).toBeGreaterThanOrEqual(row.left - 1);
        }
      }
      noOverflow(stack);
      await capture(`job-stack-open-${name}-${scheme}`, stack);
      cleanup();
    }
  });

  it("keeps three-digit counts and a quiet idle bar on one 320 px line", async () => {
    await page.viewport(320, 720);
    const many = Array.from({ length: 128 }, (_, index) => running(`job-${String(index)}`));
    const view = render(shelf([...many, failed]));
    const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;
    expect(toggle.querySelector(".process-job-chip-count")).toHaveTextContent("128");
    expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(46);
    noOverflow(toggle);
    cleanup();

    const idle = render(shelf([processJob({ jobId: "done" })]));
    const quiet = idle.container.querySelector<HTMLElement>(".process-job-stack")!;
    expect(quiet).toHaveClass("is-quiet");
    expect(quiet.getBoundingClientRect().height).toBeLessThanOrEqual(40);
    noOverflow(quiet);
  });

  it("truncates a single job's purpose before it hides any count", async () => {
    await page.viewport(320, 720);
    const view = render(shelf([running("solo", "Purpose: Regenerate every raised-bed planting map for the community garden"), failed]));
    const purpose = view.container.querySelector<HTMLElement>(".process-job-stack-purpose")!;
    const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;
    expect(purpose.scrollWidth).toBeGreaterThan(purpose.clientWidth);
    const chip = toggle.querySelector<HTMLElement>(".process-job-chip")!;
    expect(chip.getBoundingClientRect().width).toBeGreaterThan(16);
    expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(toggle.getBoundingClientRect().right + 1);
  });

  it("stops the running cue after a few turns and never animates under reduced motion", async () => {
    await page.viewport(1280, 850);
    const view = render(shelf([running("one"), running("two")]));
    const ring = view.container.querySelector<HTMLElement>(".process-job-chip .process-job-ring")!;
    const style = getComputedStyle(ring);
    expect(style.animationName).toBe("process-job-spin");
    expect(style.animationIterationCount).toBe("4");
    // Rows never spin: only the one bar cue does.
    fireEvent.click(view.container.querySelector(".process-job-stack-toggle")!);
    for (const rowRing of view.container.querySelectorAll(".process-job-card .process-job-ring")) {
      expect(getComputedStyle(rowRing).animationName).toBe("none");
    }
    cleanup();

    await commands.emulateReducedMotion("reduce");
    const reduced = render(shelf([running("one"), running("two")]));
    expect(getComputedStyle(reduced.container.querySelector(".process-job-chip .process-job-ring")!).animationName).toBe("none");
  });

  it("scrolls only the shelf body, never the page, when a row opens", async () => {
    await page.viewport(390, 600);
    const view = render(<div style={{ height: 1200 }}>{shelf([running("one"), running("two"), running("three"), backgroundSubagentJob(), running("four")])}</div>);
    window.scrollTo(0, 0);
    fireEvent.click(view.container.querySelector(".process-job-stack-toggle")!);
    const rows = view.container.querySelectorAll<HTMLElement>(".process-job-card > summary");
    const before = window.scrollY;
    fireEvent.click(rows[rows.length - 1]!);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(window.scrollY).toBe(before);
    const body = view.container.querySelector<HTMLElement>(".process-job-stack-body")!;
    const opened = rows[rows.length - 1]!.closest(".process-job-card")!.getBoundingClientRect();
    expect(opened.top).toBeGreaterThanOrEqual(body.getBoundingClientRect().top - 1);
  });
});

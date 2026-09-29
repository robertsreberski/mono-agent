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
        // A job row, or an agent group's own header.
        const row = meta.closest(".process-job-card, .process-job-group")!.getBoundingClientRect();
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

  it("spins only the closed bar's indicator, for as long as work runs, and nothing under reduced motion", async () => {
    await page.viewport(1280, 850);
    const pair = [running("one"), running("two")];
    const view = render(shelf(pair));
    const stack = view.container.querySelector<HTMLElement>(".process-job-stack")!;
    const spinner = view.container.querySelector<HTMLElement>(".process-job-chip .process-job-glyph.is-spinner")!;
    const style = getComputedStyle(spinner);
    expect(style.animationName).toBe("spin");
    // Continuous while work runs: never a bounded start-up cue that stops after
    // a few seconds (the computed count says so without waiting 5 s).
    expect(style.animationIterationCount).toBe("infinite");
    const [animation] = spinner.getAnimations();
    expect(animation).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const before = Number(animation!.currentTime);
    // A poll hands the shelf new projection objects: the same element keeps
    // the same running animation, never restarted from zero.
    view.rerender(shelf(pair.map((job) => JSON.parse(JSON.stringify(job)) as ProcessJobProjection)));
    expect(view.container.querySelector(".process-job-chip .is-spinner")).toBe(spinner);
    expect(spinner.getAnimations()[0]).toBe(animation);
    expect(Number(animation!.currentTime)).toBeGreaterThanOrEqual(before);

    // Rows never spin: each shows a still, half-filled ring.
    fireEvent.click(view.container.querySelector(".process-job-stack-toggle")!);
    const rows = [...view.container.querySelectorAll<SVGElement>(".process-job-card .process-job-glyph")];
    expect(rows).toHaveLength(2);
    for (const glyph of rows) {
      expect(glyph).toHaveClass("is-half");
      expect(getComputedStyle(glyph).animationName).toBe("none");
      expect(glyph.getAnimations({ subtree: true })).toHaveLength(0);
    }
    // Open, the header says the counts in words and the spinner goes with the
    // chips: nothing in the open shelf animates (the chevron only eases
    // through its transition).
    expect(stack.getAnimations({ subtree: true }).filter((moving) => moving instanceof CSSAnimation)).toEqual([]);
    cleanup();

    // One current job: its own bar glyph is the spinner.
    const single = render(shelf([running("solo")]));
    const solo = single.container.querySelector<HTMLElement>(".process-job-stack-single .process-job-glyph")!;
    expect(solo).toHaveClass("is-spinner");
    expect(getComputedStyle(solo).animationName).toBe("spin");
    expect(getComputedStyle(solo).animationIterationCount).toBe("infinite");
    cleanup();

    await commands.emulateReducedMotion("reduce");
    const reduced = render(shelf([running("one"), running("two")]));
    const still = reduced.container.querySelector<HTMLElement>(".process-job-chip .is-spinner")!;
    expect(getComputedStyle(still).animationName).toBe("none");
    // At rest it is the rows' half-filled ring, never a frozen arc.
    expect(getComputedStyle(still.querySelector(".process-job-spinner-arc")!).display).toBe("none");
    expect(getComputedStyle(still.querySelector(".process-job-spinner-rest")!).display).not.toBe("none");
    expect(getComputedStyle(still.querySelector(".process-job-spinner-track")!).opacity).toBe("1");
    fireEvent.click(reduced.container.querySelector(".process-job-stack-toggle")!);
    expect(reduced.container.querySelector(".process-job-stack")!.getAnimations({ subtree: true })
      .filter((moving) => moving instanceof CSSAnimation)).toHaveLength(0);
  });

  it("keeps in progress yellow and done green in every console theme, never the accent", async () => {
    await page.viewport(1280, 850);
    const colours = (theme: string | undefined) => {
      if (theme === undefined) delete document.documentElement.dataset.consoleTheme;
      else document.documentElement.dataset.consoleTheme = theme;
      const view = render(shelf([running("one"), processJob({ jobId: "done" })]));
      fireEvent.click(view.container.querySelector(".process-job-stack-toggle")!);
      fireEvent.click(screen.getByRole("button", { name: "Background job history" }));
      const card = (state: string) => view.container.querySelector<HTMLElement>(`.process-job-card[data-state='${state}']`)!;
      const read = (element: Element) => getComputedStyle(element).color;
      const result = {
        progressGlyph: read(card("running").querySelector(".process-job-glyph")!),
        progressWord: read(card("running").querySelector(".process-job-state")!),
        doneGlyph: read(card("succeeded").querySelector(".process-job-glyph")!),
        doneWord: read(card("succeeded").querySelector(".process-job-state")!),
        accent: getComputedStyle(view.container.querySelector(".process-job-stack")!).getPropertyValue("--accent").trim(),
      };
      cleanup();
      return result;
    };
    try {
      for (const scheme of ["light", "dark"] as const) {
        await commands.emulateColorScheme(scheme);
        const evergreen = colours(undefined);
        const probe = document.createElement("i");
        probe.style.color = "var(--success)";
        document.body.append(probe);
        const success = getComputedStyle(probe).color;
        probe.remove();
        expect(evergreen.doneGlyph).toBe(success);
        for (const theme of ["ocean", "plum", "terracotta"]) {
          const themed = colours(theme);
          expect(themed.accent).not.toBe(evergreen.accent);
          expect({ ...themed, accent: "" }).toEqual({ ...evergreen, accent: "" });
        }
      }
    } finally {
      delete document.documentElement.dataset.consoleTheme;
    }
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

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentTurn } from "../test/agent-group-fixtures";
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
const times = (count: number, make: (index: number) => ProcessJobProjection) => Array.from({ length: count }, (_, index) => make(index));
const asking = processJob({
  jobId: "peer-asking", tool: "PeerAgent", kind: "internal", instanceId: "seed-bank", childStillBusy: false,
  summary: "Ask the seed-bank agent about heirloom stock",
  peerQuestion: { state: "awaiting_answer", questionId: "q-asking", peer: "seed-bank", thread: "spring-orders",
    message: "Reserve the heirloom tomato seeds now?", requestedSchema: {}, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() },
});
/** Every bucket at once, most with two-digit counts: the widest bar a normal day produces. */
const settledMany = [
  ...times(14, (index) => processJob({ jobId: `failed-${String(index)}`, state: "failed", exitCode: 1 })),
  ...times(11, (index) => processJob({ jobId: `cancelled-${String(index)}`, state: "cancelled", exitCode: null, cancelRequested: true })),
  ...times(23, (index) => processJob({ jobId: `done-${String(index)}` })),
];
const everyCount = [asking, ...times(12, (index) => running(`running-${String(index)}`)), ...settledMany];
const agent = (id: string, minute: number) => agentTurn(`agent-${id}`, id, minute, { summary: `Plan the ${id} work` });
/** Seven current rows (a question, agents and commands) beside two settled ones. */
const sevenCurrent = [asking, agent("garden-helper", 1), agent("soil-analyst", 2), running("cmd-1"), running("cmd-2"), agent("compost-steward", 3), running("cmd-3"), failed, processJob({ jobId: "done" })];
const sevenOrder = ["seed-bank", "garden-helper", "soil-analyst", "Exec", "Exec", "compost-steward", "Exec"];
/** The named list as shown: entries, "+n", and the ruler's natural widths. */
const namedList = (toggle: HTMLElement) => {
  const list = toggle.querySelector<HTMLElement>(".process-job-stack-current")!;
  const entries = [...list.querySelectorAll<HTMLElement>(".process-job-stack-entries > .process-job-stack-entry")];
  const more = list.querySelector<HTMLElement>(".process-job-stack-entries > .process-job-stack-more");
  const rest = more === null ? 0 : Number(/\+(\d+)$/u.exec(more.textContent ?? "")![1]);
  const ruler = [...list.querySelectorAll<HTMLElement>(".process-job-stack-ruler > .process-job-stack-entry")].map((node) => node.getBoundingClientRect().width);
  const moreWidth = list.querySelector<HTMLElement>(".process-job-stack-ruler > .process-job-stack-more")!.getBoundingClientRect().width;
  return { list, entries, more, rest, ruler, moreWidth, names: entries.map((entry) => entry.querySelector(".process-job-stack-entry-name")!.textContent) };
};
/** Whole entries only, all inside the bar, and not one more would have fit. */
const expectBestFit = (toggle: HTMLElement, total: number) => {
  const { list, entries, more, rest, ruler, moreWidth } = namedList(toggle);
  const box = list.getBoundingClientRect();
  expect(entries.length + rest).toBe(total);
  expect(entries.length).toBeGreaterThanOrEqual(1);
  for (const entry of [...entries, ...(more === null ? [] : [more])]) expect(entry.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 1);
  if (entries.length > 1) {
    for (const entry of entries) {
      const name = entry.querySelector<HTMLElement>(".process-job-stack-entry-name")!;
      expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
    }
  }
  if (rest > 0) {
    // One more entry (and the "+n" still needed after it) would not fit.
    const next = ruler.slice(0, entries.length + 1).reduce((sum, width) => sum + width, 0) + (rest > 1 ? moreWidth : 0);
    expect(next).toBeGreaterThan(box.width + 0.5);
  }
};

const shelf = (jobs: readonly ProcessJobProjection[]) => (
  <main style={{ width: "100%", maxWidth: 880, margin: "0 auto", padding: "0 8px", boxSizing: "border-box" }}>
    <ProcessJobPresentationProvider threadId="thread" messages={[]} historyIsBounded={false}
      jobs={jobs.map((job) => ({ messageId: `message-${job.jobId}`, part: { type: "process-job" as const, job } }))}>
      <ProcessJobStack />
    </ProcessJobPresentationProvider>
  </main>
);

const noOverflow = (element: Element) => expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
const frames = async (count = 3) => {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

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
    // Closed, the rows are named and the rest is a three-digit "+n".
    expect(namedList(toggle).rest).toBeGreaterThanOrEqual(100);
    expectBestFit(toggle, 128);
    expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(46);
    noOverflow(toggle);
    // Open, the count chip carries the three digits.
    fireEvent.click(toggle);
    expect(toggle.querySelector(".process-job-chip.is-running .process-job-chip-count")).toHaveTextContent("128");
    expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(46);
    noOverflow(toggle);
    cleanup();

    const idle = render(shelf([processJob({ jobId: "done" })]));
    const quiet = idle.container.querySelector<HTMLElement>(".process-job-stack")!;
    expect(quiet).toHaveClass("is-quiet");
    expect(quiet.getBoundingClientRect().height).toBeLessThanOrEqual(40);
    noOverflow(quiet);
  });

  it("keeps the named list and settled chips, then all five two-digit chips, on one 320 px line", async () => {
    for (const scheme of ["light", "dark"] as const) {
      await page.viewport(320, 720);
      await commands.emulateColorScheme(scheme);
      const view = render(shelf(everyCount));
      const stack = view.container.querySelector<HTMLElement>(".process-job-stack")!;
      const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;
      const oneLine = (counts: readonly string[], tones: readonly string[]) => {
        const chips = [...toggle.querySelectorAll<HTMLElement>(".process-job-chip")];
        expect(chips.map((chip) => chip.querySelector(".process-job-chip-count")?.textContent)).toEqual(counts);
        expect(chips.map((chip) => [...chip.classList].find((name) => name.startsWith("is-")))).toEqual(tones);
        expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(46);
        noOverflow(toggle);
        noOverflow(stack);
        const bar = toggle.getBoundingClientRect();
        const chevron = toggle.querySelector(":scope > .process-job-stack-chevron")!.getBoundingClientRect();
        const top = chips[0]!.getBoundingClientRect().top;
        for (const chip of chips) {
          const box = chip.getBoundingClientRect();
          expect(Math.abs(box.top - top)).toBeLessThanOrEqual(1);
          expect(box.left).toBeGreaterThanOrEqual(bar.left - 1);
          expect(box.right).toBeLessThanOrEqual(chevron.left + 1);
          // Glyph and number only: no words on screen.
          expect(chip.getBoundingClientRect().width).toBeLessThan(60);
        }
      };
      // Closed: the question and the running rows are named (the question first), the settled rows counted.
      oneLine(["14", "11", "23"], ["is-danger", "is-neutral", "is-success"]);
      expectBestFit(toggle, 13);
      expect(namedList(toggle).names[0]).toBe("seed-bank");
      await capture(`job-stack-counts-closed-narrow-${scheme}`, stack);
      fireEvent.click(toggle);
      // Open: every bucket as a chip, left-aligned; the chevron ends the bar.
      oneLine(["1", "12", "14", "11", "23"], ["is-question", "is-running", "is-danger", "is-neutral", "is-success"]);
      const first = toggle.querySelector<HTMLElement>(".process-job-chip")!;
      expect(first.getBoundingClientRect().left - toggle.getBoundingClientRect().left).toBeLessThanOrEqual(14);
      await capture(`job-stack-counts-open-narrow-${scheme}`, stack);
      cleanup();
    }

    // One current row beside three settled chips: the purpose yields, never a chip or its own glyph.
    const view = render(shelf([running("solo", "Purpose: Regenerate every raised-bed planting map for the community garden"), ...settledMany]));
    const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;
    const single = toggle.querySelector<HTMLElement>(".process-job-stack-single")!;
    const chips = [...toggle.querySelectorAll<HTMLElement>(".process-job-chip")];
    expect(chips).toHaveLength(3);
    expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(46);
    noOverflow(toggle);
    const purpose = single.querySelector<HTMLElement>(".process-job-stack-purpose")!;
    expect(purpose.scrollWidth).toBeGreaterThan(purpose.clientWidth);
    const kind = single.querySelector(".process-job-stack-kind")!.getBoundingClientRect();
    expect(kind.right).toBeLessThanOrEqual(chips[0]!.getBoundingClientRect().left);
    expect(chips.at(-1)!.getBoundingClientRect().right).toBeLessThanOrEqual(toggle.getBoundingClientRect().right + 1);
    await capture("job-stack-counts-single-narrow", view.container.querySelector(".process-job-stack")!);
  });

  it.each([
    { name: "desktop", width: 1280, height: 850 },
    { name: "phone", width: 390, height: 844 },
    { name: "narrow", width: 320, height: 720 },
  ])("names as many whole current rows as fit at $name and says \"+n\" for the rest", async ({ width, height }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.viewport(width, height);
      await commands.emulateColorScheme(scheme);
      const view = render(shelf(sevenCurrent));
      const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;
      expectBestFit(toggle, 7);
      const { names, rest } = namedList(toggle);
      // The question first, then work in progress in shelf order: a prefix of the full order.
      expect(names).toEqual(sevenOrder.slice(0, names.length));
      expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(46);
      noOverflow(toggle);
      // The settled rows' chips stay right of the list, before the chevron.
      const list = toggle.querySelector(".process-job-stack-current")!.getBoundingClientRect();
      const chips = [...toggle.querySelectorAll<HTMLElement>(".process-job-chip")];
      expect(chips.map((chip) => chip.className)).toEqual(["process-job-chip is-danger", "process-job-chip is-success"]);
      expect(chips[0]!.getBoundingClientRect().left).toBeGreaterThanOrEqual(list.right - 1);
      // Spoken: what is shown, then how many more, then the counts.
      const words = [
        ...names.map((name, index) => `${name!} ${index === 0 ? "question pending" : "running"}`),
        ...(rest > 0 ? [`${String(rest)} more`] : []),
      ].join(", ");
      expect(toggle).toHaveAccessibleName(`Background jobs ${words}, 1 issue 1 done`);
      if (width === 1280) expect(names.length).toBeGreaterThanOrEqual(5);
      // Narrow, the "+n" branch (and its best-fit check) certainly runs.
      if (width === 320) expect(rest).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("re-measures the named list when the bar narrows and when the rows change", async () => {
    await page.viewport(1280, 850);
    const view = render(shelf(sevenCurrent));
    const toggle = view.container.querySelector<HTMLElement>(".process-job-stack-toggle")!;
    const wide = namedList(toggle).entries.length;
    await page.viewport(320, 720);
    await frames();
    expectBestFit(toggle, 7);
    expect(namedList(toggle).entries.length).toBeLessThan(wide);
    // Fewer rows: measured again before paint, and "+n" goes once everything fits.
    view.rerender(shelf([asking, agent("garden-helper", 1), failed]));
    expectBestFit(toggle, 2);
    await page.viewport(1280, 850);
    await frames();
    expect(namedList(toggle).names).toEqual(["seed-bank", "garden-helper"]);
    expect(namedList(toggle).more).toBeNull();
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

  it("uses the same static half-filled glyph for every running mark, closed and open", async () => {
    await page.viewport(1280, 850);
    const assertStill = async (container: HTMLElement, selector: string, count: number) => {
      const stack = container.querySelector<HTMLElement>(".process-job-stack")!;
      const glyphs = [...stack.querySelectorAll<SVGElement>(selector)];
      expect(glyphs).toHaveLength(count);
      for (const glyph of glyphs) {
        expect(glyph).toHaveClass("is-running", "is-half");
        expect(getComputedStyle(glyph).animationName).toBe("none");
      }
      // Give opening transitions time to settle; no CSS animation remains anywhere in the shelf.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(stack.getAnimations({ subtree: true })).toHaveLength(0);
    };

    // Test normal motion preferences, not only reduced motion.
    await commands.emulateReducedMotion("no-preference");
    const pair = [running("one"), running("two")];
    const view = render(shelf(pair));
    await assertStill(view.container, ".process-job-stack-entries .process-job-glyph", 2);
    view.rerender(shelf(pair.map((job) => JSON.parse(JSON.stringify(job)) as ProcessJobProjection)));
    await assertStill(view.container, ".process-job-stack-entries .process-job-glyph", 2);
    fireEvent.click(view.container.querySelector(".process-job-stack-toggle")!);
    await assertStill(view.container, ".process-job-chip.is-running .process-job-glyph, .process-job-card .process-job-glyph", 3);
    cleanup();

    const single = render(shelf([running("solo")]));
    await assertStill(single.container, ".process-job-stack-single .process-job-glyph", 1);
    fireEvent.click(single.container.querySelector(".process-job-stack-toggle")!);
    await assertStill(single.container, ".process-job-chip.is-running .process-job-glyph, .process-job-card .process-job-glyph", 2);
    cleanup();

    const four = render(shelf([running("one"), running("two"), running("three"), running("four")]));
    await assertStill(four.container, ".process-job-stack-entries .process-job-glyph", 4);
    cleanup();

    await commands.emulateReducedMotion("reduce");
    const reduced = render(shelf(pair));
    await assertStill(reduced.container, ".process-job-stack-entries .process-job-glyph", 2);
    fireEvent.click(reduced.container.querySelector(".process-job-stack-toggle")!);
    await assertStill(reduced.container, ".process-job-chip.is-running .process-job-glyph, .process-job-card .process-job-glyph", 3);
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

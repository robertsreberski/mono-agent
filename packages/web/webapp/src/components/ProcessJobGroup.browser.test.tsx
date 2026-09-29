import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectProcessJobParentCalls, type ProcessJobParentCall } from "../process-job-presentation";
import { agentTurn, launchCall, manageCall, parentMessage } from "../test/agent-group-fixtures";
import { processJob } from "../test/fixtures";
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
  }
}

/**
 * Real-Chromium evidence for agent groups: a group's identity and disclosure
 * through its newest turn settling, an open timeline inside the shelf's height
 * cap at desktop and phone widths, and a closed bar with no visible title.
 * Synthetic fixtures only; `VITE_JOB_GROUP_SHOTS=<absolute dir>` writes shots.
 */
const shotDirectory = import.meta.env.VITE_JOB_GROUP_SHOTS as string | undefined;
const capture = async (name: string, element: Element): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.elementLocator(element).screenshot({ path: `${shotDirectory}/${name}.png` });
};

const minutesAgo = (value: number) => (Date.now() - Date.parse("2026-07-17T09:00:00.000Z")) / 60_000 - value;
const brief = agentTurn("t1", "researcher-1", minutesAgo(40), { durationMinutes: 6, summary: "Research frost dates for the allotment" });
const compare = agentTurn("t2", "researcher-1", minutesAgo(25), { tool: "AgentManage", durationMinutes: 4, summary: "Compare frost dates with five years of weather" });
const windows = agentTurn("t3", "researcher-1", minutesAgo(2), { tool: "AgentManage", summary: "Summarise the safest sowing windows" });
const settled = (job: ProcessJobProjection): ProcessJobProjection => ({ ...job, state: "succeeded", exitCode: 0, durationMs: 120_000,
  timestamps: { ...job.timestamps, completedAt: new Date().toISOString() } });
const calls: readonly ProcessJobParentCall[] = collectProcessJobParentCalls([
  parentMessage("m1", minutesAgo(40), [launchCall(brief, { prompt: "Find the average last-frost and first-frost dates for a zone 7b allotment near the river, cite each source and answer with a short table.", persist: true, background: true })]),
  parentMessage("m2", minutesAgo(30), [{ type: "subagent", toolCallId: "fg", name: "researcher", status: "complete", calls: [],
    args: { id: "researcher-1", message: "Which of the two sources do you trust more for the April dates, and why?" } }]),
  parentMessage("m3", minutesAgo(25), [launchCall(compare, { id: "researcher-1", message: "Also compare those dates with the last five years of local weather records and flag any late year.", background: true })]),
  parentMessage("m4", minutesAgo(2), [launchCall(windows, { id: "researcher-1", message: "Summarise the three safest sowing windows for peas, broad beans and squash as a one-page table.", background: true })]),
  parentMessage("m5", minutesAgo(1), [manageCall("steer", { id: "researcher-1", steer: "Keep it to one printed page with large type." }, { jobId: "t3", status: "applied" })]),
], "thread");
const command = processJob({
  jobId: "cmd", state: "running", summary: "Purpose: Run the planting-calendar test suite",
  timestamps: { ...processJob().timestamps, completedAt: null }, exitCode: null, durationMs: null,
  wake: { ...processJob().wake, state: "pending", attempts: 0, lastAttemptAt: null },
});

const shelf = (jobs: readonly ProcessJobProjection[]) => (
  <main style={{ width: "100%", maxWidth: 880, margin: "0 auto", padding: "0 8px", boxSizing: "border-box" }}>
    <ProcessJobPresentationProvider threadId="thread" messages={[]} historyIsBounded={false} parentCalls={calls}
      jobs={jobs.map((job) => ({ messageId: `message-${job.jobId}`, part: { type: "process-job" as const, job } }))}>
      <ProcessJobStack />
    </ProcessJobPresentationProvider>
  </main>
);
const frames = async (count = 2) => {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const noOverflow = (element: Element) => expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
const shelfToggle = () => screen.getByRole("button", { name: /^Background jobs/u });
const group = (id: string) => screen.getByRole("group", { name: new RegExp(`^${id} agent,`, "u"), hidden: true });

beforeEach(async () => {
  vi.mocked(api.threadJob).mockImplementation(() => new Promise(() => undefined));
  await page.viewport(1280, 850);
});

afterEach(async () => {
  cleanup();
  await commands.emulateColorScheme(null);
  vi.restoreAllMocks();
});

describe("agent groups in Chromium", () => {
  it("keeps a group, its disclosure and its turn rows mounted while its newest turn settles into History", async () => {
    const view = render(shelf([brief, compare, command, windows]));
    fireEvent.click(shelfToggle());
    const researcher = group("researcher-1");
    fireEvent.click(researcher.querySelector(":scope > summary")!);
    await frames();
    expect(researcher).toHaveAttribute("open");
    const turn = within(researcher).getByRole("group", { name: "AgentManage background job running" });
    fireEvent.click(turn.querySelector("summary")!);
    expect(turn).toHaveAttribute("open");
    const item = researcher.closest(".process-job-stack-item")!;

    view.rerender(shelf([brief, compare, command, settled(windows)]));
    await frames();

    expect(item).toHaveAttribute("hidden");
    expect(group("researcher-1")).toBe(researcher);
    fireEvent.click(screen.getByRole("button", { name: "Background job history" }));
    await frames();
    expect(item).not.toHaveAttribute("hidden");
    expect(researcher).toHaveAttribute("open");
    // The same turn row, now settled, still open inside the same group.
    expect(researcher).toContainElement(turn);
    expect(turn).toHaveAccessibleName("AgentManage background job succeeded");
    expect(turn).toHaveAttribute("open");
  });

  it.each([
    { name: "desktop", width: 1280, height: 850 },
    { name: "phone", width: 390, height: 844 },
    { name: "narrow", width: 320, height: 720 },
  ])("keeps an open timeline inside the shelf's cap, revealed and without sideways overflow, at $name", async ({ name, width, height }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.viewport(width, height);
      await commands.emulateColorScheme(scheme);
      const view = render(shelf([brief, compare, command, windows]));
      const stack = view.container.querySelector<HTMLElement>(".process-job-stack")!;
      fireEvent.click(shelfToggle());
      const researcher = group("researcher-1");
      fireEvent.click(researcher.querySelector(":scope > summary")!);
      await frames(3);

      const cap = Math.min(height * 0.4, width <= 560 ? 300 : 360);
      expect(stack.getBoundingClientRect().height).toBeLessThanOrEqual(cap + 1);
      const body = view.container.querySelector<HTMLElement>(".process-job-stack-body")!;
      // The timeline scrolls inside the shelf body, never the page.
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(researcher.getBoundingClientRect().top).toBeGreaterThanOrEqual(body.getBoundingClientRect().top - 1);
      noOverflow(stack);
      noOverflow(body);
      const timeline = within(researcher).getByRole("list", { name: "researcher-1 timeline" });
      noOverflow(timeline);
      for (const row of timeline.querySelectorAll<HTMLElement>(".process-job-call-head, .process-job-card > summary, .process-job-ask")) {
        noOverflow(row);
        expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(stack.getBoundingClientRect().right + 1);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      // Every parent call is readable: the message on its row, the whole of it behind the row.
      const rows = within(timeline).getAllByRole("button", { name: /^From the parent agent:/u });
      // The brief, a foreground message, two messages and a steer.
      expect(rows).toHaveLength(5);
      fireEvent.click(rows[0]!);
      const full = document.getElementById(rows[0]!.getAttribute("aria-controls")!)!.querySelector<HTMLElement>(".process-job-call-full")!;
      expect(full).toBeVisible();
      expect(full.getBoundingClientRect().height).toBeLessThanOrEqual(222);
      noOverflow(timeline);
      await capture(`job-group-open-${name}-${scheme}`, stack);
      cleanup();
    }
  });

  it.each([
    { name: "running", jobs: [brief, compare, command, windows] },
    { name: "single agent", jobs: [brief, compare, windows] },
    { name: "idle", jobs: [brief, settled(compare)] },
    { name: "idle with an issue", jobs: [brief, { ...compare, state: "failed" as const, exitCode: 1, durationMs: 60_000 }] },
  ])("shows a closed $name bar without a visible title, one line at 320 px, named Background jobs", async ({ name, jobs }) => {
    await page.viewport(320, 720);
    const view = render(shelf(jobs));
    const stack = view.container.querySelector<HTMLElement>(".process-job-stack")!;
    const toggle = shelfToggle();
    const title = within(toggle).getByText("Background jobs");
    expect(title.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(screen.getByRole("region", { name: "Background jobs" })).toBe(stack);
    expect(stack.getBoundingClientRect().height).toBeLessThanOrEqual(48);
    noOverflow(toggle);
    noOverflow(stack);
    // Something besides the chevron always says what the bar holds.
    const visible = [...toggle.querySelectorAll<HTMLElement>(".process-job-stack-single, .process-job-chip")];
    expect(visible.length).toBeGreaterThan(0);
    for (const element of visible) expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(toggle.getBoundingClientRect().right + 1);
    await capture(`job-group-closed-${name.replaceAll(" ", "-")}`, stack);
  });
});

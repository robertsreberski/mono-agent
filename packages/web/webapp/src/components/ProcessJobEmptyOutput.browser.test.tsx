import { cleanup, render, screen } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../test/fixtures";
import type { ProcessJobProjection } from "../types";
import "../styles.css";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  api: { threadJob: vi.fn() },
}));

import { api } from "../api";
import { ProcessJobPart } from "./ProcessJob";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    emulateColorScheme(colorScheme: "light" | "dark" | null): Promise<void>;
  }
}

/**
 * Screenshot evidence is opt-in, like the route-badge and run-attribution
 * suites: `VITE_JOB_EMPTY_OUTPUT_SHOTS=<absolute dir>` writes the card shots and
 * CI runs the same DOM assertions without writing anything.
 */
const shotDirectory = import.meta.env.VITE_JOB_EMPTY_OUTPUT_SHOTS as string | undefined;

const capture = async (name: string, element: Element): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.elementLocator(element).screenshot({ path: `${shotDirectory}/${name}.png` });
};

type ProcessJobProps = Parameters<typeof ProcessJobPart>[0];

/** The dock's own chrome, so a card is measured in the box it actually sits in. */
const dock = (job: ProcessJobProjection) => (
  <section className="process-job-stack">
    <div className="process-job-stack-header">
      <div className="process-job-stack-heading">
        <span className="process-job-stack-title">Background jobs</span>
        <span className="process-job-stack-counts">1 job · 1 active · 0 history</span>
      </div>
    </div>
    <div className="process-job-stack-body">
      <div className="process-job-stack-list">
        <div className="process-job-stack-item">
          <ProcessJobPart {...({ data: { job } } as unknown as ProcessJobProps)} />
        </div>
      </div>
    </div>
  </section>
);

const base = processJob();
/**
 * Synthetic fixtures, not a recorded session: the commands, timings and the
 * absent output are hand-written. Stamps hang off the current clock so the
 * card's elapsed figure reads like a job that started a quarter of an hour ago.
 */
const startedAt = new Date(Date.now() - 17 * 60 * 1_000).toISOString();
const silent = {
  output: { ...base.output, stdoutBytes: 0, stderrBytes: 0, preview: "" },
} as const;

const running = processJob({
  ...silent,
  state: "running",
  summary: "python3 scrape.py --out pages/ | tail -40",
  timestamps: { ...base.timestamps, admittedAt: startedAt, startedAt, completedAt: null },
  wake: { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null },
  exitCode: null,
  durationMs: null,
});

const settled = processJob({ ...silent, summary: "python3 scrape.py --out pages/ | tail -40" });

beforeEach(async () => {
  vi.mocked(api.threadJob).mockImplementation(() => new Promise(() => undefined));
  document.documentElement.dataset.consoleTheme = "terracotta";
  await commands.emulateColorScheme("dark");
  await page.viewport(1_440, 1_000);
});

afterEach(async () => {
  cleanup();
  delete document.documentElement.dataset.consoleTheme;
  await commands.emulateColorScheme(null);
  vi.restoreAllMocks();
});

describe("a background job card with an empty output tail", () => {
  it.each([
    { name: "desktop", width: 1_440, height: 1_000 },
    { name: "mobile", width: 390, height: 844 },
  ])("names the empty tail on $name instead of leaving the payload blank", async ({ name, width, height }) => {
    await page.viewport(width, height);
    const view = render(dock(running));
    const card = screen.getByRole("group", { name: "Exec background job running" });
    card.setAttribute("open", "");
    await expect.element(page.getByText("No output yet.")).toBeVisible();
    expect(view.container.querySelector(".process-job-output")).toBeNull();
    await capture(`job-empty-output-running-${name}`, view.container.querySelector(".process-job-stack")!);

    cleanup();
    const settledView = render(dock(settled));
    screen.getByRole("group", { name: "Exec background job succeeded" }).setAttribute("open", "");
    await expect.element(page.getByText("No output.")).toBeVisible();
    await capture(`job-empty-output-settled-${name}`, settledView.container.querySelector(".process-job-stack")!);
  });

  it("keeps showing the tail a job does have", async () => {
    const view = render(dock(processJob({
      state: "running",
      timestamps: { ...base.timestamps, admittedAt: startedAt, startedAt, completedAt: null },
      wake: { ...base.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      output: { ...base.output, stdoutBytes: 48, preview: "STDOUT:\nfetched 41/573\nfetched 42/573\nfetched 43/573" },
      exitCode: null,
      durationMs: null,
    })));
    screen.getByRole("group", { name: "Exec background job running" }).setAttribute("open", "");
    await expect.element(page.getByText("fetched 43/573", { exact: false })).toBeVisible();
    expect(view.container.querySelector(".process-job-empty-output")).toBeNull();
    await capture("job-live-tail-desktop", view.container.querySelector(".process-job-stack")!);
  });
});

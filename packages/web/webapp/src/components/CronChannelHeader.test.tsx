import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { useConsoleStore } from "../console-store";
import type { CronJob, CronOverview, CronRun } from "../types";
import { CronChannelHeader } from "./CronChannelHeader";

vi.mock("../api", () => ({
  api: {
    cronRunNow: vi.fn(),
    cronSetEnabled: vi.fn(),
    cronConfigView: vi.fn(),
  },
}));

vi.mock("../console-store", () => ({ useConsoleStore: vi.fn() }));

const job: CronJob = {
  jobId: "daily:report",
  expression: "*/5 * * * *",
  timezone: "Europe/Amsterdam",
  conversationId: "cron:daily:report",
  configured: true,
  declaredEnabled: true,
  effectiveEnabled: true,
  health: "healthy",
  threadId: "cron-thread",
};

const overview: CronOverview = {
  generatedAt: "2026-08-14T10:00:00.000Z",
  actionsEnabled: true,
  jobs: [job],
};

const run: CronRun = {
  projection: "summary",
  runId: "cron:daily%3Areport:2026-08-14T10:00:00.000Z:m1",
  jobId: job.jobId,
  scheduledAt: "2026-08-14T10:00:00.000Z",
  orderedAt: "2026-08-14T10:00:00.000Z",
  sequence: 1,
  trigger: "manual",
  status: "admitted",
  eventCount: 0,
};

const store = (overrides: Record<string, unknown> = {}) => ({
  selectedAgent: {
    sourceId: "alpha",
    label: "Alpha",
    status: "online",
    cron: { read: true, actions: true },
  },
  selectedThread: {
    id: "cron-thread",
    sourceId: "alpha",
    trigger: { kind: "cron", jobId: job.jobId, configured: true },
  },
  cronOverview: overview,
  cronLoading: false,
  cronError: null,
  connection: "live",
  refreshCron: vi.fn().mockResolvedValue(undefined),
  ...overrides,
}) as unknown as ReturnType<typeof useConsoleStore>;

/**
 * The overview is collapsed by default; anything below the summary needs this.
 *
 * Through the summary an operator can actually reach, not by assigning `open`:
 * a control nobody can get to is not a control, and every action case below
 * lives under this disclosure.
 */
const expandOverview = (): void => {
  const summary = document.querySelector<HTMLElement>("details.cron-channel-overview > summary");
  if (summary === null) throw new Error("Expected one cron overview disclosure");
  fireEvent.click(summary);
};

describe("CronChannelHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConsoleStore).mockReturnValue(store());
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens collapsed, on one line of the three facts an operator reads first", () => {
    render(<CronChannelHeader />);

    const overviewDisclosure = document.querySelector("details.cron-channel-overview");
    expect(overviewDisclosure).not.toBeNull();
    expect(overviewDisclosure).not.toHaveAttribute("open");
    expect(screen.getByText("*/5 * * * * · Enabled · Next Unknown")).toBeVisible();
    // Everything the six facts and the three controls say is still here, and
    // none of it is taking the screen.
    expect(screen.getByRole("group", { name: "Cron controls" })).not.toBeVisible();
    expect(screen.getByText("Schedule")).not.toBeVisible();
  });

  it("expands to the whole overview through the native disclosure", () => {
    render(<CronChannelHeader />);
    const overviewDisclosure = document.querySelector("details.cron-channel-overview")!;

    fireEvent.click(screen.getByText("*/5 * * * * · Enabled · Next Unknown"));

    expect(overviewDisclosure).toHaveAttribute("open");
    expect(screen.getByRole("group", { name: "Cron controls" })).toBeVisible();
    expect(screen.getByText("Schedule")).toBeVisible();
  });

  it("opens the next cron channel collapsed, however the last one was left", () => {
    const { rerender } = render(<CronChannelHeader />);
    expandOverview();
    expect(document.querySelector("details.cron-channel-overview")).toHaveAttribute("open");

    // A direct cron-to-cron switch: the header is never unmounted, so the
    // element the browser put `open` on is the element the next job gets.
    const nextJob: CronJob = { ...job, jobId: "hourly:sweep", threadId: "other-cron-thread" };
    vi.mocked(useConsoleStore).mockReturnValue(store({
      cronOverview: { ...overview, jobs: [nextJob] },
      selectedThread: {
        id: "other-cron-thread",
        sourceId: "alpha",
        trigger: { kind: "cron", jobId: nextJob.jobId, configured: true },
      },
    }));
    rerender(<CronChannelHeader />);

    expect(document.querySelector("details.cron-channel-overview")).not.toHaveAttribute("open");
    expect(screen.getByRole("group", { name: "Cron controls" })).not.toBeVisible();
    // And the same job on the same agent is the same channel: a re-render for
    // any other reason must not shut the disclosure under the operator.
    expandOverview();
    rerender(<CronChannelHeader />);
    expect(document.querySelector("details.cron-channel-overview")).toHaveAttribute("open");
  });

  it("renders an agent-unknown next run without deriving it from the expression", () => {
    render(<CronChannelHeader />);
    expandOverview();

    expect(screen.getByRole("group", { name: "Cron controls" })).toBeVisible();
    expect(document.querySelector(".cron-channel-facts")?.tagName).toBe("DL");
    expect(screen.queryByText(/^Session\b/u)).toBeNull();
    const nextRun = screen.getByText("Next run").parentElement;
    expect(nextRun).not.toBeNull();
    expect(within(nextRun!).getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("*/5 * * * *")).toBeInTheDocument();
  });

  it("reuses the same idempotency key and the agent-issued confirmation token", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
    vi.mocked(api.cronRunNow)
      .mockResolvedValueOnce({
        kind: "confirmation_required",
        confirmation: {
          token: "agent-token",
          expiresAt: "2026-08-14T10:01:00.000Z",
          message: "A scheduled firing during this manual run will be recorded as skipped_overlap.",
        },
      })
      .mockResolvedValueOnce({ kind: "completed", value: { run }, replayed: false });

    render(<CronChannelHeader />);
    expandOverview();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText(/scheduled firing during this manual run/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(api.cronRunNow).toHaveBeenCalledTimes(2));
    expect(api.cronRunNow).toHaveBeenNthCalledWith(
      1,
      "alpha",
      job.jobId,
      idempotencyKey,
      undefined,
    );
    expect(api.cronRunNow).toHaveBeenNthCalledWith(
      2,
      "alpha",
      job.jobId,
      idempotencyKey,
      "agent-token",
    );
  });

  it("keeps actions unavailable without capability while retaining the redacted config view", async () => {
    vi.mocked(useConsoleStore).mockReturnValue(store({
      selectedAgent: {
        sourceId: "alpha",
        label: "Alpha",
        status: "online",
        cron: { read: true, actions: false },
      },
      cronOverview: { ...overview, actionsEnabled: false },
    }));
    vi.mocked(api.cronConfigView).mockResolvedValue({
      id: "cron",
      label: "Cron",
      status: "active",
      fields: [{ id: "prompt", label: "Prompt", value: "[redacted]", source: "json", redacted: true }],
    });

    render(<CronChannelHeader />);
    expandOverview();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "View config" }));

    const configDialog = await screen.findByRole("dialog", { name: "Cron configuration" });
    expect(configDialog).toHaveClass("agent-settings-dialog", "cron-dialog");
    expect(configDialog.querySelector(".cron-config-fields")?.tagName).toBe("DL");
    await waitFor(() => expect(configDialog).toHaveFocus());
    expect(screen.getByText("[redacted]")).toBeInTheDocument();
    expect(screen.getByText("json · redacted")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("returns focus to the control that opened the dialog, not to whatever a re-render saw", async () => {
    vi.mocked(useConsoleStore).mockReturnValue(store({
      selectedAgent: {
        sourceId: "alpha",
        label: "Alpha",
        status: "online",
        cron: { read: true, actions: false },
      },
      cronOverview: { ...overview, actionsEnabled: false },
    }));
    vi.mocked(api.cronConfigView).mockResolvedValue({
      id: "cron",
      label: "Cron",
      status: "active",
      fields: [{ id: "prompt", label: "Prompt", value: "[redacted]", source: "json", redacted: true }],
    });

    render(<CronChannelHeader />);
    expandOverview();
    const opener = screen.getByRole("button", { name: "View config" });
    opener.focus();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Cron configuration" });
    await waitFor(() => expect(dialog).toHaveFocus());

    // Closing must return focus to the control that opened the dialog.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("ties both disabled actions to a focusable missing-key explanation without relying on title", () => {
    vi.mocked(useConsoleStore).mockReturnValue(store({
      selectedAgent: {
        sourceId: "alpha",
        label: "Alpha",
        status: "online",
        cron: { read: true, actions: false },
      },
    }));

    render(<CronChannelHeader />);
    expandOverview();
    const reason = screen.getByText(/operator api key/iu);
    expect(reason).toHaveAttribute("role", "status");
    reason.focus();
    expect(reason).toHaveFocus();
    expect(screen.getByRole("button", { name: "Run now" })).toHaveAttribute("aria-describedby", reason.id);
    expect(screen.getByRole("button", { name: "Disable" })).toHaveAttribute("aria-describedby", reason.id);
    expect(screen.getByRole("button", { name: "Run now" })).not.toHaveAttribute("title");
  });

  it("uses the authoritative degraded reason for actions and exposes offline configuration help", () => {
    const degradedReason = "Cron control state failed its integrity check.";
    vi.mocked(useConsoleStore).mockReturnValue(store({
      connection: "stale",
      cronOverview: { ...overview, degradedReason },
    }));

    render(<CronChannelHeader />);
    expandOverview();
    const run = screen.getByRole("button", { name: "Run now" });
    const toggle = screen.getByRole("button", { name: "Disable" });
    const configuration = screen.getByRole("button", { name: "View config" });
    expect(run).toBeDisabled();
    expect(toggle).toBeDisabled();
    expect(configuration).toBeDisabled();
    const actionReasonId = run.getAttribute("aria-describedby");
    const actionReason = actionReasonId === null ? null : document.getElementById(actionReasonId);
    expect(actionReason).not.toBeNull();
    expect(actionReason).toHaveTextContent(degradedReason);
    const configReason = screen.getByText("Cron configuration is unavailable while the agent is offline.");
    expect(run).toHaveAttribute("aria-describedby", actionReason!.id);
    expect(toggle).toHaveAttribute("aria-describedby", actionReason!.id);
    expect(configuration).toHaveAttribute("aria-describedby", configReason.id);
    configReason.focus();
    expect(configReason).toHaveFocus();
  });
});

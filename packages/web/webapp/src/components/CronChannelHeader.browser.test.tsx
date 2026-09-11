import { render, screen } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConsoleStore } from "../console-store";
import type { CronJob, CronOverview } from "../types";
import { CronChannelHeader } from "./CronChannelHeader";
import "../styles.css";

vi.mock("../api", () => ({
  api: { cronRunNow: vi.fn(), cronSetEnabled: vi.fn(), cronConfigView: vi.fn() },
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

const disclosure = (): HTMLDetailsElement => {
  const found = document.querySelector<HTMLDetailsElement>("details.cron-channel-overview");
  if (found === null) throw new Error("Expected one cron overview disclosure");
  return found;
};

beforeEach(() => {
  vi.mocked(useConsoleStore).mockReturnValue({
    selectedAgent: { sourceId: "alpha", label: "Alpha", status: "online", cron: { read: true, actions: true } },
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
  } as unknown as ReturnType<typeof useConsoleStore>);
});

describe("the cron overview disclosure in a browser", () => {
  it("is reached and toggled from the keyboard alone, by the browser itself", async () => {
    render(<CronChannelHeader />);
    expect(disclosure().open).toBe(false);

    // Tab reaches the summary because it is a native one: nothing here adds a
    // tabindex, a role, or a key handler of its own.
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(disclosure().querySelector("summary"));

    await userEvent.keyboard("{Enter}");
    expect(disclosure().open).toBe(true);
    expect(screen.getByRole("group", { name: "Cron controls" })).toBeVisible();

    await userEvent.keyboard("{Enter}");
    expect(disclosure().open).toBe(false);
    expect(screen.getByRole("group", { name: "Cron controls" })).not.toBeVisible();
  });
});

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConsoleStore } from "../console-store";
import type { CronJob, CronOverview } from "../types";
import styles from "../styles.css?raw";
import { CronChannelHeader } from "./CronChannelHeader";

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

const nextRunAt = "2026-09-07T14:30:00.000Z";
const withJob = (overrides: Partial<CronJob> = {}) => store({
  cronOverview: { ...overview, jobs: [{ ...job, nextRunAt, ...overrides }] },
});

describe("CronChannelHeader", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T12:00:00.000Z"));
    vi.mocked(useConsoleStore).mockReturnValue(withJob());
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders only cadence and an agent-authored absolute time in the viewer timezone", () => {
    const NativeFormatter = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((_locale, options) =>
      new NativeFormatter("en-GB", { ...options, timeZone: "America/New_York" }));
    vi.mocked(useConsoleStore).mockReturnValue(withJob({ expression: "30 16 * * *" }));
    render(<CronChannelHeader />);
    const section = screen.getByRole("region", { name: "Cron schedule" });
    expect(section).toHaveTextContent("Every day at 16:30 (Europe/Amsterdam)");
    const time = section.querySelector("time");
    expect(time).toHaveAttribute("datetime", nextRunAt);
    expect(time).toHaveAttribute("title", "Your timezone: America/New_York");
    expect(time).toHaveTextContent("7 Sept, 10:30");
    expect(section.querySelectorAll("button, a, dialog, [role=dialog], [role=status], [role=alert]"))
      .toHaveLength(0);
    expect(section).not.toHaveTextContent(/healthy|last run|session|configuration|daily:report/iu);
  });

  it.each([undefined, "bad", "2099", "2099-01-01", "2099-02-30T12:00:00Z",
    "2099-01-01T24:00:00Z", "2099-01-01T12:00:00+99:00",
    "2026-09-05T12:00:00Z", "2026-09-06T12:00:00Z"])("rejects unavailable next instant %s", (value) => {
    vi.mocked(useConsoleStore).mockReturnValue(withJob({ nextRunAt: value }));
    render(<CronChannelHeader />);
    expect(screen.getByText("Next run unavailable")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });

  it.each([
    { connection: "reconnecting" }, { connection: "offline" }, { cronError: "Unavailable" },
    { selectedAgent: { sourceId: "alpha", status: "offline", cron: { read: true } } },
    { selectedAgent: { sourceId: "beta", status: "online", cron: { read: true } } },
    { selectedAgent: { sourceId: "alpha", status: "online", cron: { read: false } } },
    { cronOverview: { ...overview, degradedReason: "Unavailable", jobs: [{ ...job, nextRunAt }] } },
    { cronOverview: { ...overview, jobs: [{ ...job, nextRunAt, threadId: "other-thread" }] } },
    { cronOverview: null },
  ])("does not advertise a future prediction with stale or unavailable authority: %j", (overrides) => {
    vi.mocked(useConsoleStore).mockReturnValue({ ...withJob(), ...overrides } as ReturnType<typeof useConsoleStore>);
    render(<CronChannelHeader />);
    expect(screen.getByText("Next run unavailable")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });

  it("prefers removed to disabled and unavailable", () => {
    vi.mocked(useConsoleStore).mockReturnValue({ ...withJob({ configured: false, effectiveEnabled: false }), connection: "reconnecting" });
    render(<CronChannelHeader />);
    expect(screen.getByText("Job removed")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });

  it("uses effective enabled state rather than declared state", () => {
    vi.mocked(useConsoleStore).mockReturnValue(withJob({ effectiveEnabled: false }));
    const { rerender } = render(<CronChannelHeader />);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    vi.mocked(useConsoleStore).mockReturnValue(withJob({ declaredEnabled: false, effectiveEnabled: true }));
    rerender(<CronChannelHeader />);
    expect(document.querySelector("time")).not.toBeNull();
  });

  it("retains the thread's removed state when the job is absent from the overview", () => {
    const removed = store({ cronOverview: { ...overview, jobs: [] } });
    vi.mocked(useConsoleStore).mockReturnValue({ ...removed, selectedThread: {
      ...removed.selectedThread!, trigger: { kind: "cron", jobId: job.jobId, configured: false },
    } });
    render(<CronChannelHeader />);
    expect(screen.getByText("Job removed")).toBeInTheDocument();
    expect(screen.getByText("Schedule unavailable")).toBeInTheDocument();
  });

  it("allows narrow layouts to wrap cadence and next state without clipped text or controls", () => {
    vi.mocked(useConsoleStore).mockReturnValue(withJob({ expression: "0,30 9 * * MON,WED,FRI" }));
    render(<CronChannelHeader />);
    const section = screen.getByRole("region", { name: "Cron schedule" });
    expect(section).toHaveClass("cron-channel-header");
    expect(section.querySelectorAll(":scope > span")).toHaveLength(3);
    const headerStyle = styles.match(/\.cron-channel-header \{([^}]+)\}/u)?.[1];
    expect(headerStyle).toMatch(/flex-wrap: wrap/u);
    expect(headerStyle).toMatch(/min-width: 0/u);
    expect(headerStyle).toMatch(/color: var\(--text-muted\)/u);
    const textStyle = styles.match(/\.cron-channel-header > span \{([^}]+)\}/u)?.[1];
    expect(textStyle).toMatch(/overflow-wrap: anywhere/u);
    expect(textStyle).not.toMatch(/nowrap|hidden|ellipsis/u);
  });

  it("does not render for a non-cron conversation", () => {
    vi.mocked(useConsoleStore).mockReturnValue(store({ selectedThread: { trigger: { kind: "monitor" } } }));
    const { container } = render(<CronChannelHeader />);
    expect(container).toBeEmptyDOMElement();
  });
});

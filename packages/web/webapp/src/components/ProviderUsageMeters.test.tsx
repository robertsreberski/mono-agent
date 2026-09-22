import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../test/fixtures";
import type { AgentSummary, ProviderUsage, ProviderUsageSnapshot } from "../types";
const mocks = vi.hoisted(() => ({ providerUsage: vi.fn(), refreshProviderUsage: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { ProviderUsageMeters, useProviderUsage } from "./ProviderUsageMeters";
const snapshot: ProviderUsageSnapshot = { schema: "mono-agent.provider-usage.v1", providers: [{ providerId: "opencode-go", label: "OpenCode Go", plan: "Go", fetchedAt: "2026-09-14T12:00:00Z", stale: false, windows: [{ kind: "session", label: "Session", usedPercent: 0, periodMs: 18000000, resetsAt: "2026-09-14T13:00:00Z" }] }] };
function Loader({ selected }: { selected: AgentSummary }) {
  const { snapshot: usage, refresh, refreshing, feedback } = useProviderUsage(selected);
  return <><button onClick={() => void refresh()} disabled={refreshing}>Refresh</button><p role="status">{feedback}</p>{usage?.providers.map((item) => <ProviderUsageMeters key={item.providerId} usage={item} />)}</>;
}
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("usage rows and lifecycle", () => {
  it("omits absent credentials without placeholders and renders fixed errors with last-good", () => {
    const view = render(<ProviderUsageMeters />);
    expect(view.container.textContent).toBe("");
    view.rerender(<ProviderUsageMeters usage={{ ...snapshot.providers[0]!, stale: true, error: { code: "not_entitled", message: "No Go subscription." } }} />);
    expect(screen.getByText("Usage unavailable — No Go subscription.")).toBeInTheDocument();
    expect(screen.getByText("Last known usage")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
  });
  it("loads only capable online agents and discards a closed owner's response", async () => {
    let finish!: (snapshot: ProviderUsageSnapshot) => void;
    mocks.providerUsage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<Loader selected={agent("alpha", { supportsProviderUsage: true })} />);
    await waitFor(() => expect(mocks.providerUsage).toHaveBeenCalledTimes(1));
    const signal = mocks.providerUsage.mock.calls[0]![1] as AbortSignal;
    view.rerender(<Loader selected={agent("beta")} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(snapshot));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(mocks.providerUsage).toHaveBeenCalledTimes(1);
  });
  it("awaits manual meter changes, coalesces clicks and retains fetchedAt on failure", async () => {
    mocks.providerUsage.mockResolvedValue(snapshot);
    let finish!: (value: ProviderUsageSnapshot) => void;
    mocks.refreshProviderUsage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<Loader selected={agent("alpha", { supportsProviderUsage: true, supportsProviderUsageRefresh: true })} />);
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText("Refreshing usage…")).toBeInTheDocument();
    expect(mocks.refreshProviderUsage).toHaveBeenCalledTimes(1);
    const next = { ...snapshot, providers: [{ ...snapshot.providers[0]!, fetchedAt: "2026-09-14T12:01:00Z", windows: [{ ...snapshot.providers[0]!.windows[0]!, usedPercent: 54 }] }] };
    await act(async () => finish(next));
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "54");
    expect(screen.getByText(/Usage refreshed. Last fetched/)).toHaveTextContent(new Date(next.providers[0]!.fetchedAt).toLocaleString());
    mocks.refreshProviderUsage.mockRejectedValueOnce(new Error("RAW_SECRET"));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText(/Usage refresh failed/);
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "54");
    expect(screen.getByText("Last known usage")).toHaveAttribute("title", `Fetched ${new Date(next.providers[0]!.fetchedAt).toLocaleString()}`);
    expect(document.body.textContent).not.toContain("RAW_SECRET");
  });
  it.each(["close", "switch", "generation"])("fences a pending manual response on %s", async (change) => {
    mocks.providerUsage.mockResolvedValue(snapshot);
    let finish!: (value: ProviderUsageSnapshot) => void;
    mocks.refreshProviderUsage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const selected = agent("alpha", { supportsProviderUsage: true, supportsProviderUsageRefresh: true });
    const view = render(<Loader selected={selected} />);
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button"));
    const signal = mocks.refreshProviderUsage.mock.calls[0]![1] as AbortSignal;
    if (change === "close") view.unmount();
    else {
      mocks.providerUsage.mockResolvedValue({ schema: snapshot.schema, providers: [] });
      view.rerender(<Loader selected={change === "switch" ? agent("beta", { supportsProviderUsage: true }) : { ...selected, generation: "new-generation" }} />);
    }
    expect(signal.aborted).toBe(true);
    await act(async () => finish(snapshot));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Usage refreshed/)).toBeNull();
  });
  it("does not let an older automatic response overwrite a newer manual result", async () => {
    let automatic!: (value: ProviderUsageSnapshot) => void;
    mocks.providerUsage.mockReturnValueOnce(new Promise((resolve) => { automatic = resolve; }));
    mocks.refreshProviderUsage.mockResolvedValue({ ...snapshot, providers: [{ ...snapshot.providers[0]!, windows: [{ ...snapshot.providers[0]!.windows[0]!, usedPercent: 72 }] }] });
    render(<Loader selected={agent("alpha", { supportsProviderUsage: true, supportsProviderUsageRefresh: true })} />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("progressbar");
    await act(async () => automatic(snapshot));
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "72");
  });
  it("reports partial or backoff-suppressed refresh honestly without a made-up update", async () => {
    mocks.providerUsage.mockResolvedValue(snapshot);
    mocks.refreshProviderUsage.mockResolvedValue({ ...snapshot, providers: [{ ...snapshot.providers[0]!, stale: true, error: { code: "rate_limited", message: "Rate limited; retrying after backoff." } }] });
    render(<Loader selected={agent("alpha", { supportsProviderUsage: true, supportsProviderUsageRefresh: true })} />);
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText(/Some usage could not be refreshed/);
    expect(screen.queryByText(/Usage refreshed/)).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
  });
  it("polls at five minutes, updates countdown, and stops on unmount", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    mocks.providerUsage.mockResolvedValue(snapshot);
    const view = render(<Loader selected={agent("alpha", { supportsProviderUsage: true })} />);
    await act(async () => {});
    expect(screen.getByText("Resets in 1h 0m")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(mocks.providerUsage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Resets in 55m")).toBeInTheDocument();
    view.unmount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mocks.providerUsage).toHaveBeenCalledTimes(2);
  });
});
const weekMs = 604800000;
const weekReset = "2026-09-26T08:10:22.000Z";
function codexUsage(usedPercent: number, stale = false): ProviderUsage {
  return { providerId: "openai-codex", label: "Codex", plan: "Pro 20x", fetchedAt: "2026-09-22T09:35:00.000Z", stale,
    windows: [{ kind: "weekly", label: "Weekly", usedPercent, periodMs: weekMs, resetsAt: weekReset }] };
}
describe("burn-pace projection lines", () => {
  it("renders healthy windows exactly as before, with no projection line", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    // 25 % at half the window: pace 0.5, on track.
    render(<ProviderUsageMeters usage={{ ...codexUsage(25), fetchedAt: "2026-09-22T20:10:22.000Z" }} />);
    expect(screen.queryByText(/empty/)).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("Codex Weekly used");
  });
  it("marks ahead and unsustainable tiers with distinct classes and accessible names", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const view = render(<ProviderUsageMeters usage={codexUsage(55)} />);
    const ahead = screen.getByText(/empty/);
    expect(ahead).toHaveClass("provider-usage-projection", "is-ahead");
    expect(ahead.textContent).toMatch(/\(.+ before reset\)/);
    expect(ahead.getAttribute("title")).toMatch(/Projected to run out .* at current pace 1\.26x/);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toMatch(/projected to run out before reset \(ahead\)/);
    view.rerender(<ProviderUsageMeters usage={codexUsage(96)} />);
    const exhausted = screen.getByText(/empty/);
    expect(exhausted).toHaveClass("provider-usage-projection", "is-unsustainable");
    expect(exhausted.textContent).toMatch(/\(.+ before reset\)/);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toMatch(/projected to run out before reset \(unsustainable\)/);
    expect(exhausted).not.toHaveClass("is-ahead");
  });
  it("keeps the anchored projection on stale snapshots and reads empty once the run-out passes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    render(<ProviderUsageMeters usage={codexUsage(96, true)} />);
    expect(screen.getByText("Last known usage")).toBeInTheDocument();
    expect(screen.getByText(/empty/)).toBeInTheDocument();
    // Same measurement, later wall-clock: the anchor does not move, so the run-out is now past.
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText(/Projected empty \(.+ before reset\)/)).toBeInTheDocument();
  });
});

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../test/fixtures";
import type { AgentSummary, ProviderUsageSnapshot } from "../types";
const mocks = vi.hoisted(() => ({ providerUsage: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { ProviderUsageMeters, useProviderUsage } from "./ProviderUsageMeters";
const snapshot: ProviderUsageSnapshot = { schema: "mono-agent.provider-usage.v1", providers: [{ providerId: "opencode-go", label: "OpenCode Go", plan: "Go", fetchedAt: "2026-09-14T12:00:00Z", stale: false, windows: [{ kind: "session", label: "Session", usedPercent: 0, periodMs: 18000000, resetsAt: "2026-09-14T13:00:00Z" }] }] };
function Loader({ selected }: { selected: AgentSummary }) {
  const usage = useProviderUsage(selected);
  return <>{usage?.providers.map((item) => <ProviderUsageMeters key={item.providerId} usage={item} />)}</>;
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

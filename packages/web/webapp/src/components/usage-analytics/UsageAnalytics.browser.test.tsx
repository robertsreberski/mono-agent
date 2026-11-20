import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import { jitteredQuotaHistoryFixture, usageAnalyticsFixture } from "../../test/usage-analytics-fixtures";
import "../../styles.css";

const store = vi.hoisted(() => ({ selectedAgent: null as ReturnType<typeof agent> | null, selectThread: vi.fn() }));
const api = vi.hoisted(() => ({ usageAnalytics: vi.fn(), providerUsageHistory: vi.fn(), providerUsage: vi.fn(), refreshProviderUsage: vi.fn(), clearProviderUsageHistory: vi.fn() }));
vi.mock("../../console-store", () => ({ useConsoleStore: () => store }));
vi.mock("../../api", () => ({ api }));
import { UsageAnalyticsScreen } from "./UsageAnalyticsScreen";
import { UsageAnalyticsView } from "./UsageAnalyticsView";
declare module "@vitest/browser/context" { interface BrowserCommands { prepareUsageAnalyticsScreenshots: () => Promise<void> } }
const quotaShots = import.meta.env.VITE_USAGE_QUOTA_LINES_SHOTS as string | undefined;
const shots = import.meta.env.VITE_USAGE_ANALYTICS_SHOTS as string | undefined;
const actions = { onRange: vi.fn(), onRefresh: vi.fn(), onClose: vi.fn(), onVendorRefresh: vi.fn(), onClear: vi.fn(async () => undefined), onOpenConversation: vi.fn(), onOpenProject: vi.fn() };
function show(partial = false, stale = false) { return render(<div style={{ height: "100dvh" }}><UsageAnalyticsView {...usageAnalyticsFixture(partial, stale)} {...actions} agentLabel="Fictional sample agent · synthetic data" range="24h" /></div>); }
beforeEach(() => {
  vi.clearAllMocks(); const fixture = usageAnalyticsFixture();
  store.selectedAgent = agent("fictional-agent", { supportsProviderUsageHistory: true, supportsProviderUsageHistoryClear: true, supportsProviderUsageRefresh: true });
  api.usageAnalytics.mockImplementation(async (sourceId: string) => ({ ...fixture.data, sourceId })); api.providerUsageHistory.mockResolvedValue(fixture.history);
  api.refreshProviderUsage.mockResolvedValue({ schema: "mono-agent.provider-usage.v1", providers: [] }); api.clearProviderUsageHistory.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("usage analytics", () => {
  it.each([1440, 390])("renders accessible fictional charts, account boundary and table alternatives at %spx", async width => {
    await commands.prepareUsageAnalyticsScreenshots(); await page.viewport(width, width === 390 ? 1900 : 1700);
    show();
    expect(screen.getByRole("heading", { name: "Usage analytics" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Codex Session quota history" })).toBeVisible();
    expect(screen.getAllByText(/Account changed/).length).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const plot = document.querySelector(".usage-chart-plot")!.getBoundingClientRect();
    expect(plot.height).toBe(width === 390 ? 100 : 116);
    const ticks = document.querySelectorAll<HTMLElement>(".usage-chart-y-tick");
    expect(getComputedStyle(ticks[0]!).fontSize).toBe("11px");
    expect(getComputedStyle(document.querySelector(".usage-chart-x-axis")!).fontSize).toBe("11px");
    expect(ticks[0]!.getBoundingClientRect().top - ticks[2]!.getBoundingClientRect().top)
      .toBeGreaterThanOrEqual(width === 390 ? 89 : 104);
    expect(document.querySelector(".usage-chart text")).toBeNull();
    const costCard = screen.getByRole("heading", { name: "Tokens and spend" }).closest(".usage-card")!;
    expect(getComputedStyle(costCard.querySelector(".usage-chart-y-tick")!).fontSize).toBe("11px");
    expect(costCard.querySelector(".usage-chart-plot")!.getBoundingClientRect().height)
      .toBe(width === 390 ? 200 : 232);
    const toolbar = document.querySelector(".usage-toolbar")!.getBoundingClientRect();
    expect(screen.getByRole("button", { name: "Refresh analytics" }).getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(document.querySelector(".usage-toolbar + p")!.getBoundingClientRect().top).toBeGreaterThanOrEqual(toolbar.bottom);
    document.querySelector(".usage-content")!.scrollTop = 0;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (shots) await page.screenshot({ path: `${shots}/usage-analytics-fictional-${width}-account-boundary.png` });
    if (shots && width === 1440) {
      await page.viewport(1440, 1000);
      document.querySelector(".usage-rankings")!.scrollIntoView({ block: "start" });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(screen.getByRole("heading", { name: "Top conversations" })).toBeVisible();
      expect(screen.getByRole("heading", { name: "Top projects" })).toBeVisible();
      await page.screenshot({ path: `${shots}/usage-analytics-fictional-1440-top-rankings.png` });
      await page.viewport(1440, 1700);
      document.querySelector(".usage-content")!.scrollTop = 0;
    }
    const tokens = screen.getByRole("button", { name: "Tokens" }); tokens.focus(); await userEvent.keyboard("{Enter}"); expect(tokens).toHaveAttribute("aria-pressed", "true");
    if (shots && width === 390) {
      await page.viewport(390, 1600);
      costCard.scrollIntoView({ block: "start" });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await page.screenshot({ path: `${shots}/usage-analytics-fictional-390-tokens-rankings.png` });
      await page.viewport(390, 1900);
      document.querySelector(".usage-content")!.scrollTop = 0;
    }
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Inspect bucket" }), "12");
    expect(screen.getByRole("table", { name: /Model breakdown/ })).toBeVisible();
    const codex = screen.getByRole("article", { name: "Codex quota history" });
    await userEvent.click(within(codex).getByText("Quota observations and account boundaries"));
    expect(within(codex).getByRole("table")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "7d" })); expect(actions.onRange).toHaveBeenCalledWith("7d");
  });
  it.each([[1440, "dark"], [390, "dark"], [1440, "light"]] as const)(
    "shows each window as a line for jittered reset times at %spx in %s mode",
    async (width, scheme) => {
      await commands.prepareUsageAnalyticsScreenshots();
      const height = width === 390 ? 1800 : 1080;
      await page.viewport(width, height);
      await commands.emulateColorScheme(scheme);
      try {
        render(
          <div style={{ height: "100dvh" }}>
            <UsageAnalyticsView
              {...actions} agentLabel="Fictional sample agent · synthetic data" range="7d"
              data={null} history={jitteredQuotaHistoryFixture()}
            />
          </div>,
        );
        expect(matchMedia("(prefers-color-scheme: dark)").matches).toBe(scheme === "dark");
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        for (const [label, windows] of [["Claude", ["Session", "Weekly", "Fable"]], ["Codex", ["Session", "Weekly"]]] as const) {
          const card = screen.getByRole("article", { name: `${label} quota history` });
          expect(card.querySelectorAll(".usage-chart-x-axis")).toHaveLength(1);
          expect(card.getBoundingClientRect().bottom).toBeLessThan(height);
          for (const window of windows) {
            const plot = within(card).getByRole("img", { name: `${label} ${window} quota history` });
            expect(plot).toBeVisible();
            expect(plot).toHaveAccessibleDescription(expect.stringContaining("dashed segments show inferred resets"));
            const row = plot.closest<HTMLElement>(".usage-quota-window")!;
            expect(within(row).getByText(/% used/)).toBeVisible();
            expect(within(row).getByText(/× pace/)).toBeVisible();
            expect(within(row).getByText(/^Resets/)).toBeVisible();
            expect(plot.getBoundingClientRect().height).toBe(width === 390 ? 100 : 116);
            const line = plot.querySelector<SVGPathElement>(".usage-quota-line:not(.usage-quota-inferred)")!;
            const inferred = plot.querySelector<SVGPathElement>(".usage-quota-inferred")!;
            expect(line.getTotalLength()).toBeGreaterThan(0);
            expect(inferred.getTotalLength()).toBeGreaterThan(0);
            expect(getComputedStyle(inferred).stroke).toBe(getComputedStyle(line).stroke);
            expect(getComputedStyle(inferred).strokeWidth).toBe("2px");
            expect(parseFloat(getComputedStyle(inferred).strokeDasharray)).toBeGreaterThanOrEqual(6);
            expect(getComputedStyle(plot.querySelector(".usage-sample-dots")!).strokeWidth).toBe("3px");
            expect(plot.querySelector(".usage-reset")!.getAttribute("d")?.match(/M/g))
              .toHaveLength(window === "Session" ? 10 : 1);
          }
        }
        if (quotaShots) {
          document.querySelector(".usage-content")!.scrollTop = 0;
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          await page.screenshot({ path: `${quotaShots}/fictional-quota-lines-${width}-${scheme}.png` });
        }
      } finally {
        await commands.emulateColorScheme(null);
      }
    },
  );
  it.each([1440, 390])("shows partial/stale accounting without claiming unknown spend is free at %spx", async width => {
    await commands.prepareUsageAnalyticsScreenshots(); await page.viewport(width, width === 390 ? 1900 : 1700);
    show(true, true);
    expect(screen.getByRole("heading", { name: "Known spend" })).toBeVisible(); expect(screen.getByText("Total cost is incomplete.")).toBeVisible();
    expect(screen.getAllByText(/Last known usage/)).toHaveLength(2);
    document.querySelector(".usage-content")!.scrollTop = 0;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (shots) await page.screenshot({ path: `${shots}/usage-analytics-fictional-${width}-partial-stale.png` });
  });
  it("requires confirmed clear and keeps empty/storage/older-agent states explicit", async () => {
    await page.viewport(1000, 900); const view = show();
    await userEvent.click(screen.getByRole("button", { name: "Clear quota history" }));
    expect(screen.getByRole("dialog", { name: "Clear quota history?" })).toBeVisible(); expect(actions.onClear).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear quota history" })); await userEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(actions.onClear).toHaveBeenCalledTimes(1));
    const fixture = usageAnalyticsFixture();
    view.rerender(<UsageAnalyticsView {...fixture} {...actions} agentLabel="Fictional" range="24h" history={{ ...fixture.history, storage: "unavailable", providers: [] }} />);
    expect(screen.getByText(/Quota history storage is unavailable/)).toBeVisible();
    view.rerender(<UsageAnalyticsView {...actions} agentLabel="Fictional" range="24h" data={null} history={null} historyError="This agent version does not support quota history." />);
    expect(screen.getByText(/does not support quota history/)).toBeVisible();
  });
  it("shows empty accounting and offers a working shorter range for budget errors", async () => {
    const fixture = usageAnalyticsFixture(), empty = { ...fixture.data, total: {}, topConversations: [], topProjects: [], coverage: { ...fixture.data.coverage, messages: 0 } };
    render(<UsageAnalyticsView {...actions} agentLabel="Fictional" range="24h" data={empty} history={{ ...fixture.history, providers: [] }} dataError="This usage range is too large. Choose a shorter range." />);
    expect(screen.getByText(/No retained usage observations/)).toBeVisible();
    expect(screen.getByText(/No activated provider history/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Use 6h range" })); expect(actions.onRange).toHaveBeenCalledWith("6h");
  });
  it("shows unknown prices without known-zero summaries, rankings, tables or bars", async () => {
    await commands.prepareUsageAnalyticsScreenshots(); await page.viewport(390, 1900);
    const fixture = usageAnalyticsFixture();
    const unknown = { ...fixture.data, total: { ...fixture.data.total, costUsd: null }, coverage: { ...fixture.data.coverage, costPartial: true },
      buckets: fixture.data.buckets.map(b => ({ ...b, total: { ...b.total, costUsd: null }, models: b.models.map(m => ({ ...m, costUsd: null })) })),
      topConversations: fixture.data.topConversations.map(c => ({ ...c, usage: { costUsd: null } })),
      topProjects: fixture.data.topProjects.map(p => ({ ...p, usage: { costUsd: null }, projectSummaryUsage: { costUsd: null } })),
    };
    render(<UsageAnalyticsView {...actions} agentLabel="Fictional unknown prices · synthetic data" range="24h" data={unknown} history={null} />);
    expect(screen.getByText("No known prices to plot. Cost is unknown.")).toBeVisible();
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(3);
    expect(document.body.textContent).not.toContain("$0.00");
    expect(screen.queryByRole("img", { name: /Known cost by model/ })).not.toBeInTheDocument();
    if (shots) await page.screenshot({ path: `${shots}/usage-analytics-fictional-390-unknown-price.png` });
    await userEvent.click(screen.getByText("All bucket totals"));
    expect(screen.getByRole("region", { name: "All usage bucket totals" })).toBeVisible();
    const names = [...document.querySelectorAll(".usage-table-scroll[role=region]")].map(region => region.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    await userEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByRole("img", { name: /Reported tokens by model/ })).toBeVisible();
  });
  it("treats an aborted clear as interrupted and refreshes rather than claiming failure", async () => {
    actions.onClear.mockRejectedValueOnce(new DOMException("Owner changed", "AbortError"));
    show();
    await userEvent.click(screen.getByRole("button", { name: "Clear quota history" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(/Could not clear history/)).not.toBeInTheDocument();
    expect(actions.onRefresh).toHaveBeenCalledTimes(1);
  });
  it("only reads local queries on open/range changes; vendor refresh is explicit", async () => {
    await page.viewport(1000, 1000);
    render(<UsageAnalyticsScreen onClose={actions.onClose} onOpenConversation={actions.onClose} onOpenProject={actions.onOpenProject} />);
    await waitFor(() => expect(api.usageAnalytics).toHaveBeenCalledTimes(1)); await waitFor(() => expect(screen.getByText("Usage analytics loaded.")).toBeVisible());
    expect(api.providerUsage).not.toHaveBeenCalled(); expect(api.refreshProviderUsage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "7d" })); await waitFor(() => expect(api.usageAnalytics).toHaveBeenCalledTimes(2));
    expect(api.usageAnalytics.mock.calls[1]?.[1]).toMatchObject({ bucket: "day", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(api.refreshProviderUsage).toHaveBeenCalledTimes(1)); await waitFor(() => expect(api.providerUsageHistory).toHaveBeenCalledTimes(3));
    expect(api.providerUsage).not.toHaveBeenCalled();
  });
  it("refetches the new owner after an interrupted clear without reporting a failed DELETE", async () => {
    api.clearProviderUsageHistory.mockImplementationOnce((_source: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Owner changed", "AbortError")), { once: true });
    }));
    const view = render(<UsageAnalyticsScreen onClose={actions.onClose} onOpenConversation={actions.onClose} onOpenProject={actions.onOpenProject} />);
    await waitFor(() => expect(screen.getByText("Usage analytics loaded.")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Clear quota history" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(api.clearProviderUsageHistory).toHaveBeenCalledTimes(1));
    store.selectedAgent = agent("other", { supportsProviderUsageHistory: true });
    view.rerender(<UsageAnalyticsScreen onClose={actions.onClose} onOpenConversation={actions.onClose} onOpenProject={actions.onOpenProject} />);
    await waitFor(() => expect(screen.getByText("Usage analytics loaded.")).toBeVisible());
    expect(api.providerUsageHistory).toHaveBeenLastCalledWith("other", expect.anything(), expect.anything());
    expect(api.usageAnalytics).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not clear history|Clear was not confirmed/)).not.toBeInTheDocument();
  });
  it("discards old source responses and leaves local accounting available offline", async () => {
    const fixture = usageAnalyticsFixture(); let finish!: (history: typeof fixture.history) => void;
    api.providerUsageHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<UsageAnalyticsScreen onClose={actions.onClose} onOpenConversation={actions.onClose} onOpenProject={actions.onOpenProject} />);
    await waitFor(() => expect(api.providerUsageHistory).toHaveBeenCalledTimes(1));
    store.selectedAgent = agent("other", { status: "offline" });
    view.rerender(<UsageAnalyticsScreen onClose={actions.onClose} onOpenConversation={actions.onClose} onOpenProject={actions.onOpenProject} />);
    await act(async () => { finish(fixture.history); });
    await waitFor(() => expect(screen.getByText(/Quota history needs a live agent connection/)).toBeVisible());
    expect(screen.queryByRole("article", { name: "Codex quota history" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tokens and spend" })).toBeVisible();
  });
});

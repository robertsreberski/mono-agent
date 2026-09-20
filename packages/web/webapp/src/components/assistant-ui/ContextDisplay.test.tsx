import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import type { ProviderUsageSnapshot } from "../../types";

const apiMock = vi.hoisted(() => ({ providerUsage: vi.fn(), refreshProviderUsage: vi.fn() }));
vi.mock("../../api", () => ({ api: apiMock }));
import { ContextDisplay } from "./ContextDisplay";

const codexSnapshot: ProviderUsageSnapshot = {
  schema: "mono-agent.provider-usage.v1",
  providers: [{
    providerId: "openai-codex",
    label: "Codex",
    plan: "Pro",
    fetchedAt: "2026-09-15T12:00:00Z",
    stale: false,
    windows: [{
      kind: "weekly",
      label: "Weekly",
      usedPercent: 42,
      periodMs: 604_800_000,
      resetsAt: "2026-09-16T12:00:00Z",
    }],
  }],
};

afterEach(() => { vi.clearAllMocks(); });

describe("ContextDisplay", () => {
  it("renders exact current context and last-turn work as separate sections", async () => {
    const { container } = render(
      <ContextDisplay
        className="compact-context"
        context={{
          status: "current",
          usage: {
            input: 1_000,
            cachedInput: 200,
            cacheCreation: 100,
            output: 50,
            total: 1_350,
            contextWindow: 2_700,
          },
        }}
        processed={{ input: 4_000, cachedInput: 8_000, output: 500, reasoning: 250 }}
        conversationCost={0.0042}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Context usage: 1.4k tokens, 50%, $0.0042",
    });
    expect(trigger).toHaveClass("context-display-trigger", "compact-context");
    // The chip is one glanceable number; tokens and cost stay in the popup.
    expect(trigger).toHaveTextContent("50%");
    expect(trigger).not.toHaveTextContent("1.4k");
    expect(trigger).not.toHaveTextContent("$0.0042");
    fireEvent.click(trigger);

    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(container).not.toContainElement(popover);
    const current = within(popover).getByRole("region", { name: "Current context" });
    expect(within(current).getByText("Cache read").nextElementSibling).toHaveTextContent("200");
    expect(within(current).getByText("Total").nextElementSibling).toHaveTextContent("1.4k");
    const processed = within(popover).getByRole("region", { name: "Last turn processed" });
    expect(within(processed).getByText("Processed total").nextElementSibling).toHaveTextContent("12.5k");
    expect(within(popover).getByText("Conversation cost").nextElementSibling).toHaveTextContent("$0.0042");
  });

  it("uses the reported total and window for exact post-compaction progress", async () => {
    render(<ContextDisplay context={{
      status: "current",
      usage: { input: 900_000, total: 20_000, contextWindow: 100_000 },
    }} />);

    const trigger = screen.getByRole("button", { name: "Context usage: 20k tokens, 20%" });
    fireEvent.click(trigger);
    const progress = await screen.findByRole("progressbar", { name: "Context window used" });
    expect(progress).toHaveAttribute("aria-valuenow", "20");
    expect(progress).toHaveAttribute("aria-valuetext", "20k of 100k tokens (20%)");
  });

  it("labels legacy aggregate telemetry unavailable and never invents a percentage", async () => {
    render(
      <ContextDisplay
        context={{
          status: "unavailable",
          reason: "Exact context usage has not been reported for this conversation.",
        }}
        processed={{ input: 429_128, cachedInput: 4_970_496, output: 15_773 }}
        conversationCost={5.104078}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Context usage: unavailable, $5.10" });
    expect(trigger).toHaveTextContent("—");
    expect(trigger).not.toHaveTextContent("100%");
    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).getByText("Exact context usage has not been reported for this conversation.")).toBeVisible();
    expect(within(popover).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(popover).getByText("Processed total").nextElementSibling).toHaveTextContent("5.4M");
  });

  it("omits unknown and zero-value segments", async () => {
    render(<ContextDisplay context={{
      status: "current",
      usage: { input: 12, cachedInput: 0, output: Number.NaN, total: 12 },
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 12 tokens" }));
    const current = await screen.findByRole("region", { name: "Current context" });
    expect(within(current).getByText("Input")).toBeVisible();
    expect(within(current).queryByText("Cache read")).not.toBeInTheDocument();
    expect(within(current).queryByText("Output")).not.toBeInTheDocument();
  });

  it("labels an in-flight exact snapshot as updating instead of current", async () => {
    render(<ContextDisplay context={{
      status: "updating",
      usage: { total: 42_000, contextWindow: 100_000, model: "pi:p:m" },
      measuredModel: "pi:p:m",
      reason: "The provider measurement is exact, but the current turn is still updating context.",
    }} />);

    const trigger = screen.getByRole("button", {
      name: "Context usage: 42k tokens, updating, 42%",
    });
    // The word moved into the popup; the chip carries the state as colour.
    expect(trigger).not.toHaveTextContent("Updating");
    expect(trigger).toHaveAttribute("data-state", "updating");
    fireEvent.click(trigger);
    expect(await screen.findByText("Updating")).toBeVisible();
    const latest = await screen.findByRole("region", { name: "Latest provider measurement" });
    expect(within(latest).getByText("Measured model").nextElementSibling).toHaveTextContent("pi:p:m");
    expect(within(latest).queryByRole("region", { name: "Current context" })).not.toBeInTheDocument();
  });

  it("uses an updating placeholder before the current turn reports an exact snapshot", async () => {
    render(<ContextDisplay context={{
      status: "updating",
      reason: "The current turn has not reported an exact provider measurement yet.",
    }} />);

    const trigger = screen.getByRole("button", { name: "Context usage: updating" });
    expect(trigger).toHaveTextContent("—");
    expect(trigger).not.toHaveTextContent("%");
    fireEvent.click(trigger);
    expect(await screen.findByText("The current turn has not reported an exact provider measurement yet.")).toBeVisible();
  });

  it("makes stale model measurements explicit and shows their measured model", async () => {
    render(<ContextDisplay context={{
      status: "last_measured",
      usage: { total: 12_000, contextWindow: 100_000, model: "pi:p:old" },
      measuredModel: "pi:p:old",
      reason: "This measurement belongs to pi:p:old; the next turn is set to pi:p:new.",
    }} />);

    const trigger = screen.getByRole("button", {
      name: "Context usage: 12k tokens, last measured, 12%",
    });
    expect(trigger).toHaveTextContent("12%");
    expect(trigger).toHaveAttribute("data-state", "last_measured");
    fireEvent.click(trigger);
    const last = await screen.findByRole("region", { name: "Last measured" });
    expect(within(last).getByText("pi:p:old")).toBeVisible();
    expect(within(last).getByText(/next turn is set to pi:p:new/u)).toBeVisible();
  });

  it("suppresses a stale pre-compaction number while awaiting measurement", async () => {
    render(<ContextDisplay context={{
      status: "awaiting_measurement",
      reason: "Context changed during compaction; waiting for the next exact provider measurement.",
    }} />);

    const trigger = screen.getByRole("button", {
      name: "Context usage: awaiting provider measurement",
    });
    expect(trigger).toHaveTextContent("—");
    expect(trigger).toHaveAttribute("data-state", "awaiting_measurement");
    expect(trigger).not.toHaveTextContent("%");
    fireEvent.click(trigger);
    expect(await screen.findByText("Awaiting")).toBeVisible();
  });

  it("loads and renders only the active provider after the popover opens", async () => {
    let finish!: (snapshot: ProviderUsageSnapshot) => void;
    apiMock.providerUsage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(
      <ContextDisplay
        context={{ status: "current", usage: { total: 20_000, contextWindow: 100_000 } }}
        providerUsage={{
          agent: agent("alpha", { supportsProviderUsage: true }),
          providerId: "openai-codex",
        }}
      />,
    );

    expect(apiMock.providerUsage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Context usage: 20k tokens, 20%" }));
    const loading = await screen.findByRole("region", { name: "Codex usage" });
    expect(within(loading).getByText("Loading usage…")).toHaveRole("status");
    expect(apiMock.providerUsage).toHaveBeenCalledExactlyOnceWith("alpha", expect.any(AbortSignal));

    await act(async () => finish(codexSnapshot));
    const provider = screen.getByRole("region", { name: "Codex usage" });
    expect(within(provider).getByRole("heading", { name: "Codex usage" })).toBeVisible();
    expect(within(provider).getByText("Pro")).toHaveClass("provider-usage-plan");
    expect(within(provider).getByRole("progressbar", { name: "Codex Weekly used" })).toHaveAttribute("value", "42");
  });

  it.each([
    ["an agent without usage support", agent("alpha"), "openai-codex"],
    ["an unknown usage provider", agent("alpha", { supportsProviderUsage: true }), "pi"],
  ])("omits provider usage for %s", async (_case, selectedAgent, providerId) => {
    render(
      <ContextDisplay
        context={{ status: "current", usage: { total: 20_000, contextWindow: 100_000 } }}
        providerUsage={{ agent: selectedAgent, providerId }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 20k tokens, 20%" }));
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).queryByRole("region", { name: /usage$/u })).toBeNull();
    expect(apiMock.providerUsage).not.toHaveBeenCalled();
  });

  it("keeps context visible when active-provider usage is stale and errored", async () => {
    apiMock.providerUsage.mockResolvedValue({
      ...codexSnapshot,
      providers: [{
        ...codexSnapshot.providers[0]!,
        stale: true,
        error: { code: "unavailable", message: "Provider usage is unavailable." },
      }],
    });
    render(
      <ContextDisplay
        context={{ status: "current", usage: { total: 20_000, contextWindow: 100_000 } }}
        providerUsage={{
          agent: agent("alpha", { supportsProviderUsage: true }),
          providerId: "openai-codex",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 20k tokens, 20%" }));
    expect(await screen.findByText("Last known usage")).toBeVisible();
    expect(screen.getByText("Usage unavailable — Provider usage is unavailable.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Context window used" })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Codex Weekly used" })).toBeVisible();
  });
});

import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebThreadUsage } from "../../../../src/contracts.js";
import { agent } from "../../test/fixtures";
import type { ProviderUsageSnapshot } from "../../types";

const apiMock = vi.hoisted(() => ({ providerUsage: vi.fn(), refreshProviderUsage: vi.fn(), compactThread: vi.fn(), threadUsage: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), api: apiMock }));
import { ContextDisplay } from "./ContextDisplay";
import { ApiError } from "../../api";

const context = { status: "current" as const, measuredModel: "atlas/standard", usage: { total: 84_210, contextWindow: 200_000 } };
const typical: WebThreadUsage = { total: { tokens: { input: 12_000, cacheWrite: 100, cacheRead: 5_000, output: 2_000 }, costUsd: 2.24 },
  byModel: [{ model: "atlas/standard", costUsd: 2.24 }], computedAt: "2026-01-01T00:00:00Z" };
const mixed: WebThreadUsage = { total: { tokens: { input: 20_000, cacheWrite: 300, cacheRead: 9_000, output: 4_000 }, tokensPartial: true, costUsd: 4.18, costPartial: true },
  subagents: { runs: 2, costUsd: 1.12, tokensPartial: true },
  byModel: [{ model: "atlas/standard", costUsd: 3.06 }, { model: "grove/fast", costUsd: 1.12 }], computedAt: "2026-01-01T00:00:00Z" };
const codexSnapshot: ProviderUsageSnapshot = {
  schema: "mono-agent.provider-usage.v1",
  providers: [{ providerId: "openai-codex", label: "Codex", plan: "Pro", fetchedAt: "2026-09-15T12:00:00Z",
    stale: false, windows: [{ kind: "weekly", label: "Weekly", usedPercent: 42, periodMs: 604_800_000, resetsAt: "2026-09-16T12:00:00Z" }] }],
};
const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: /^Context usage:/ }));
  return await screen.findByRole("dialog", { name: "Context usage" });
};
const plan = { agent: agent("alpha", { supportsProviderUsage: true }), providerId: "openai-codex" };
afterEach(() => { vi.clearAllMocks(); });

describe("ContextDisplay", () => {
  it("renders ordered named sections, a token table and a cost definition list without old diagnostics", async () => {
    render(<ContextDisplay context={context} totals={typical} compactThreadId="thread-one" />);
    const popup = await open();
    expect(within(popup).getAllByRole("region").map((node) => node.getAttribute("aria-labelledby") && node.querySelector("h3")?.textContent))
      .toEqual(["Context window", "Tokens processed", "Estimated cost"]);
    expect(within(popup).getByRole("row", { name: /Total/ })).toHaveTextContent("12.1k");
    expect(within(popup).getByRole("columnheader", { name: "Cached" })).toHaveAttribute("title", "Input read from the provider's prompt cache");
    expect(within(popup).queryByText(/Cache hit ratio|Last turn processed|Measured model|Reasoning/)).not.toBeInTheDocument();
    expect(within(popup).queryByText("incl. subagents")).not.toBeInTheDocument();
    expect(within(popup).queryByText("atlas/standard")).not.toBeInTheDocument();
    expect(within(popup).getByText("Summarizes earlier turns to free space.")).toBeVisible();
  });
  it("uses the full-thread endpoint rather than the loaded message page", async () => {
    apiMock.threadUsage.mockResolvedValue({ total: { costUsd: 0.9, tokens: { input: 900, cacheWrite: 0, cacheRead: 0, output: 90 } },
      byModel: [{ model: "atlas/standard", costUsd: 0.9 }], computedAt: typical.computedAt });
    render(<ContextDisplay threadId="thread-long" detail={null} context={context} />);
    expect(apiMock.threadUsage).not.toHaveBeenCalled();
    const popup = await open();
    await waitFor(() => expect(within(popup).getByRole("row", { name: /Total/ })).toHaveTextContent("900"));
    expect(within(popup).getByRole("region", { name: "Estimated cost" })).toHaveTextContent("$0.90");
    expect(apiMock.threadUsage).toHaveBeenCalledWith("thread-long", expect.any(AbortSignal));
  });
  it("shows lower bounds, subagent report gaps, cost shares, and sorted model rows", async () => {
    render(<ContextDisplay context={context} totals={mixed} />);
    const popup = await open();
    expect(within(popup).getByRole("row", { name: /Total/ })).toHaveTextContent("≥20.3k");
    expect(within(popup).getByRole("row", { name: /incl. subagents/ })).toHaveTextContent("not reported");
    expect(within(popup).getByRole("region", { name: /Estimated cost/ })).toHaveTextContent("≥$4.18");
    expect(within(popup).getAllByText("incl. subagents")).toHaveLength(2);
    expect(within(popup).getAllByText("$1.12")).toHaveLength(2);
    expect(within(popup).getByText("$3.06")).toBeVisible();
  });
  it.each([[79.9, "normal"], [80, "warning"], [94.9, "warning"], [95, "danger"]] as const)("applies unrounded level at %s", (percent, level) => {
    const trigger = render(<ContextDisplay context={{ status: "current", usage: { total: percent * 1_000, contextWindow: 100_000 } }} />).container.querySelector(".context-display-trigger");
    expect(trigger).toHaveAttribute("data-level", level);
  });
  it("names exact, updating, estimated, old, missing and sub-one-percent context without rounding away meaning", async () => {
    const { rerender } = render(<ContextDisplay context={context} totals={typical} />);
    expect(screen.getByRole("button", { name: "Context usage: 84,210 of 200,000 tokens (42%). Estimated cost $2.24." })).toHaveTextContent("42%");
    rerender(<ContextDisplay context={{ ...context, status: "updating" }} totals={typical} running />);
    expect(screen.getByRole("button", { name: /84,210 of 200,000 tokens \(42%\), updating/ })).toBeVisible();
    await open();
    expect(screen.getByText("Updating")).toBeVisible();
    rerender(<ContextDisplay context={{ status: "awaiting_measurement", usage: { total: 41_300, contextWindow: 200_000 }, compaction: { running: false }, reason: "Estimated after compaction. Measured exactly on the next turn." }} totals={typical} />);
    expect(screen.getByRole("button", { name: /about 41,300 of 200,000 tokens \(about 21%\) after compaction/ })).toHaveTextContent("≈21%");
    expect(screen.getByRole("progressbar", { name: "Context window used" })).toHaveAttribute("aria-valuetext", "About 41,300 of 200,000 tokens, 21%");
    rerender(<ContextDisplay context={{ ...context, status: "last_measured" }} totals={typical} />);
    expect(screen.getByRole("button", { name: /last measured 84,210/ })).toBeVisible();
    rerender(<ContextDisplay context={{ status: "unavailable" }} />);
    expect(screen.getByRole("button", { name: /context size not reported/ })).toHaveTextContent("—");
    rerender(<ContextDisplay context={{ status: "current", usage: { total: 1, contextWindow: 100_000 } }} />);
    expect(screen.getByRole("button", { name: /<1%/ })).toHaveTextContent("<1%");
  });
  it("keeps initial focus away from Compact and makes blocked action focusable and inert", async () => {
    render(<ContextDisplay context={context} totals={typical} compactThreadId="thread-one" compactBlocked />);
    const popup = await open();
    const button = within(popup).getByRole("button", { name: "Compact" });
    await waitFor(() => expect(popup).toHaveFocus());
    expect(button).not.toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-describedby");
    fireEvent.click(button);
    expect(apiMock.compactThread).not.toHaveBeenCalled();
    expect(within(popup).getByText("Available when this turn finishes.")).toBeVisible();
  });
  it("shows nearly-full emphasis and all compaction outcomes, clearing results on close", async () => {
    apiMock.compactThread.mockResolvedValueOnce({ status: "succeeded", operationId: "one", trigger: "manual", tokensBefore: 183_400, tokensAfter: 41_300 });
    apiMock.compactThread.mockResolvedValueOnce({ status: "skipped", operationId: "two", trigger: "manual" });
    apiMock.compactThread.mockResolvedValueOnce({ status: "skipped", operationId: "three", trigger: "manual", reason: "model_changed" });
    apiMock.compactThread.mockResolvedValueOnce({ status: "failed", operationId: "four", trigger: "manual" });
    apiMock.compactThread.mockRejectedValueOnce(new ApiError("Wait for the current turn.", 409));
    apiMock.compactThread.mockRejectedValueOnce(new TypeError("offline"));
    render(<ContextDisplay context={{ ...context, usage: { total: 184_000, contextWindow: 200_000 } }} compactThreadId="thread-one" />);
    const popup = await open();
    const button = within(popup).getByRole("button", { name: "Compact" });
    expect(button).toHaveAttribute("data-emphasis");
    expect(within(popup).getByText("Context is nearly full.")).toBeVisible();
    for (const expected of ["Compacted · 183.4k → ≈41.3k", "Nothing to compact yet.",
      "Switch back to atlas/standard to compact this session.", "Compaction failed.",
      "Wait for the current turn.", "Connection lost — the outcome is unknown. Refresh this conversation."]) {
      fireEvent.click(button);
      await waitFor(() => expect(within(popup).getByText(expected)).toBeVisible());
    }
    fireEvent.keyDown(popup, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument());
    await open();
    expect(screen.queryByText("Connection lost — the outcome is unknown. Refresh this conversation.")).not.toBeInTheDocument();
  });
  it("shows a reported zero, merges first-turn placeholders, and uses exact success without estimate", async () => {
    const zero: WebThreadUsage = { total: { costUsd: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } }, byModel: [], computedAt: typical.computedAt };
    const { rerender } = render(<ContextDisplay context={context} totals={zero} compactThreadId="one" />);
    const popup = await open();
    expect(within(popup).getByRole("region", { name: "Estimated cost" })).toHaveTextContent("$0.00");
    rerender(<ContextDisplay context={{ status: "updating" }} totals={{ total: {}, byModel: [], computedAt: typical.computedAt }} compactThreadId="one" compactBlocked />);
    expect(within(popup).getByRole("region", { name: "Tokens & cost" })).toHaveTextContent("Totals appear when the first turn finishes.");
    expect(within(popup).queryByRole("region", { name: "Estimated cost" })).not.toBeInTheDocument();
    apiMock.compactThread.mockResolvedValueOnce({ status: "succeeded", operationId: "exact", trigger: "manual", tokensBefore: 100_000, tokensAfter: 20_000, tokenCountsExact: true });
    rerender(<ContextDisplay context={context} totals={zero} compactThreadId="one" />);
    fireEvent.click(within(popup).getByRole("button", { name: "Compact" }));
    expect(await within(popup).findByText("Compacted · 100k → 20k")).toBeVisible();
  });
  it("keeps the plan gate and loads the active provider only on open with compact rows", async () => {
    let finish!: (value: ProviderUsageSnapshot) => void;
    apiMock.providerUsage.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ContextDisplay context={context} totals={typical} providerUsage={plan} compactThreadId="thread-one" />);
    expect(apiMock.providerUsage).not.toHaveBeenCalled();
    const popup = await open();
    expect(within(popup).getAllByRole("region").map((region) => region.querySelector("h3")?.textContent)).toEqual([
      "Context window", "Tokens processed", "Estimated cost", "Codex plan",
    ]);
    expect(within(popup).getByRole("status", { name: "" })).toHaveTextContent("Loading usage…");
    await act(async () => finish(codexSnapshot));
    const region = within(popup).getByRole("region", { name: "Codex plan" });
    expect(within(region).getByText("Pro")).toBeVisible();
    expect(within(region).getByRole("progressbar", { name: /Codex Weekly used/ })).toHaveAttribute("value", "42");
    expect(within(region).getByText(/Resets |Reset due/)).toBeVisible();
    expect(within(region).queryByText("Last known usage")).not.toBeInTheDocument();
  });
  it("keeps context on stale/error and hides unsupported plan capability", async () => {
    apiMock.providerUsage.mockResolvedValue({ ...codexSnapshot, providers: [{ ...codexSnapshot.providers[0]!, stale: true,
      error: { code: "unavailable", message: "Credential rejected." } }] });
    const { rerender } = render(<ContextDisplay context={context} providerUsage={plan} />);
    const popup = await open();
    expect(await within(popup).findByText("Last known")).toBeVisible();
    expect(within(popup).getByText("Usage unavailable — Credential rejected.")).toBeVisible();
    expect(within(popup).getByRole("progressbar", { name: "Context window used" })).toBeVisible();
    rerender(<ContextDisplay context={context} providerUsage={{ agent: agent("alpha"), providerId: "openai-codex" }} />);
    expect(within(popup).queryByRole("region", { name: "Codex plan" })).not.toBeInTheDocument();
  });
});

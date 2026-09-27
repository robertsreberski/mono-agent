import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import type { ProviderUsageSnapshot } from "../../types";
import type { WebThreadUsage } from "../../../../src/contracts.js";
import "../../styles.css";

const apiMock = vi.hoisted(() => ({ providerUsage: vi.fn(), refreshProviderUsage: vi.fn(), compactThread: vi.fn(), threadUsage: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), api: apiMock }));
import { ContextDisplay } from "./ContextDisplay";
import { ApiError } from "../../api";

const snapshot: ProviderUsageSnapshot = { schema: "mono-agent.provider-usage.v1", providers: [{ providerId: "opencode-go",
  label: "OpenCode Go", plan: "Go", fetchedAt: new Date().toISOString(), stale: false, windows: [
    { kind: "session", label: "Session", usedPercent: 12, periodMs: 18_000_000, resetsAt: "2026-09-20T00:00:00Z" },
    { kind: "weekly", label: "Weekly", usedPercent: 34, periodMs: 604_800_000, resetsAt: "2026-09-22T00:00:00Z" },
    { kind: "monthly", label: "Monthly", usedPercent: 56, periodMs: 2_592_000_000, resetsAt: "2026-10-21T00:00:00Z" },
  ] }] };
const totals: WebThreadUsage = { total: { tokens: { input: 100_000, cacheRead: 62_000, cacheWrite: 3_000, output: 18_000 }, costUsd: 4.18 },
  subagents: { runs: 2, costUsd: 1.12, tokensPartial: true }, byModel: [
    { model: "atlas/standard", costUsd: 3.06 }, { model: "grove/fast", costUsd: 1.12 },
  ], computedAt: "2026-09-19T00:00:00Z" };
const context = { status: "current" as const, usage: { total: 132_000, contextWindow: 200_000, model: "atlas/standard" } };
const plan = { agent: agent("alpha", { supportsProviderUsage: true }), providerId: "opencode-go" };
const show = async (data = totals) => {
  apiMock.providerUsage.mockResolvedValue(snapshot);
  render(<div style={{ position: "fixed", bottom: 70, right: 16 }}>
    <ContextDisplay context={context} totals={data} compactThreadId="one" providerUsage={plan} />
  </div>);
  const trigger = screen.getByRole("button", { name: /^Context usage:/ });
  fireEvent.click(trigger);
  const region = await screen.findByRole("region", { name: "OpenCode Go plan" });
  return { trigger, dialog: screen.getByRole("dialog", { name: "Context usage" }), region };
};
afterEach(async () => { vi.clearAllMocks(); await page.viewport(1440, 1000); });

describe("Context usage layout", () => {
  it("renders three bounded single-column provider rows and fits the 390 × 844 sheet", async () => {
    await page.viewport(390, 844);
    const { dialog, region } = await show();
    expect(within(region).getAllByRole("progressbar")).toHaveLength(3);
    expect(within(region).getByText("Go")).toBeVisible();
    expect(region.querySelectorAll(".context-display-plan-window")).toHaveLength(3);
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    expect(dialog.getBoundingClientRect().height).toBeLessThanOrEqual(844 * .82);
    expect(dialog.scrollHeight).toBeLessThanOrEqual(dialog.clientHeight);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(within(dialog).getByRole("button", { name: "Close" }).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(within(dialog).getByRole("button", { name: "Compact" }).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });
  it("keeps the sticky footer visible in the shorter 390 × 667 sheet", async () => {
    await page.viewport(390, 667);
    const { dialog } = await show();
    dialog.scrollTop = dialog.scrollHeight;
    const footer = dialog.querySelector<HTMLElement>(".context-display-compact")!;
    await waitFor(() => expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(667));
    expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(dialog.getBoundingClientRect().top);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  });
  it("dims the focusable blocked Compact action without disabling keyboard focus", async () => {
    await page.viewport(390, 844);
    render(<ContextDisplay context={context} totals={totals} compactThreadId="one" compactBlocked />);
    fireEvent.click(screen.getByRole("button", { name: /^Context usage:/ }));
    const button = within(await screen.findByRole("dialog", { name: "Context usage" })).getByRole("button", { name: "Compact" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(Number(getComputedStyle(button).opacity)).toBeLessThan(1);
  });
  it("opens above its desktop toolbar trigger and fits 320 × 600", async () => {
    await page.viewport(1440, 1000);
    const { trigger, dialog } = await show();
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(320);
    expect(dialog.getBoundingClientRect().height).toBeLessThanOrEqual(600);
    expect(dialog).toHaveAttribute("data-side", "top");
    await waitFor(() => expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top));
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  });
  it.each([[390, 667], [1440, 1000]])("keeps compaction feedback visible at %ipx", async (width, height) => {
    await page.viewport(width, height);
    const shots = import.meta.env.VITE_CONTEXT_COMPACT_SHOTS as string | undefined;
    const shot = async (state: string) => { if (shots) await page.screenshot({ path: `${shots}/context-compact-${state}-${width}x${height}.png` }); };
    let finish!: (result: unknown) => void;
    apiMock.compactThread.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ status: "skipped", trigger: "manual", operationId: "second" })
      .mockRejectedValueOnce(new ApiError("This conversation is busy.", 409))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { dialog } = await show();
    const button = within(dialog).getByRole("button", { name: "Compact" });
    fireEvent.click(button);
    expect(within(dialog).getByRole("button", { name: "Compacting…" })).toBeDisabled();
    const status = () => dialog.querySelector(".context-display-compact-status");
    expect(status()).toHaveTextContent("Summarizing earlier turns…");
    await shot("pending");
    finish({ status: "succeeded", trigger: "manual", operationId: "first", tokensBefore: 60_000, tokensAfter: 20_000 });
    await waitFor(() => expect(status()).toHaveTextContent("Compacted · 60k → ≈20k"));
    await shot("success");
    fireEvent.click(button);
    await waitFor(() => expect(status()).toHaveTextContent("Nothing to compact yet."));
    await shot("skipped");
    fireEvent.click(button);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("busy");
    await shot("busy");
    fireEvent.click(button);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("outcome is unknown");
    await shot("unknown-outcome");
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  });
});

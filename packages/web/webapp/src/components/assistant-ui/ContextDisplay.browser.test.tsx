import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import type { ProviderUsageSnapshot } from "../../types";
import "../../styles.css";

const apiMock = vi.hoisted(() => ({ providerUsage: vi.fn(), refreshProviderUsage: vi.fn(), compactThread: vi.fn() }));
vi.mock("../../api", () => ({ api: apiMock }));
import { ContextDisplay } from "./ContextDisplay";

const snapshot: ProviderUsageSnapshot = {
  schema: "mono-agent.provider-usage.v1",
  providers: [{
    providerId: "opencode-go",
    label: "OpenCode Go",
    plan: "Go",
    fetchedAt: new Date().toISOString(),
    stale: false,
    windows: [
      { kind: "session", label: "Session", usedPercent: 12, periodMs: 18_000_000 },
      { kind: "weekly", label: "Weekly", usedPercent: 34, periodMs: 604_800_000 },
      { kind: "monthly", label: "Monthly", usedPercent: 56, periodMs: 2_592_000_000 },
    ],
  }],
};

afterEach(async () => {
  vi.clearAllMocks();
  await page.viewport(1440, 1000);
});

describe("Context usage provider meters", () => {
  it("keeps the active provider section bounded and readable on a narrow viewport", async () => {
    await page.viewport(390, 640);
    apiMock.providerUsage.mockResolvedValue(snapshot);
    render(
      <ContextDisplay
        context={{
          status: "current",
          measuredModel: "opencode-go:kimi-k2.5",
          usage: { model: "opencode-go:kimi-k2.5", total: 50_000, contextWindow: 100_000 },
        }}
        processed={{ input: 12_000, cachedInput: 8_000, output: 1_000 }}
        conversationCost={1.23}
        providerUsage={{
          agent: agent("alpha", { supportsProviderUsage: true }),
          providerId: "opencode-go",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 50k tokens, 50%, $1.23" }));
    const provider = await screen.findByRole("region", { name: "OpenCode Go usage" });
    expect(within(provider).getAllByRole("progressbar")).toHaveLength(3);
    expect(within(provider).getByText("Go")).toBeVisible();

    const dialog = screen.getByRole("dialog", { name: "Context usage" });
    const meters = provider.querySelector(".provider-usage")!;
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(366);
    expect(dialog.getBoundingClientRect().height).toBeLessThanOrEqual(616);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(getComputedStyle(meters).gridTemplateColumns.split(" ")).toHaveLength(1);
  });

  it.each([[390, 640], [1440, 1000]])("keeps manual progress, success, skip and errors visible at %ipx", async (width, height) => {
    await page.viewport(width, height);
    // Opt-in evidence: VITE_CONTEXT_COMPACT_SHOTS=<absolute dir>.
    const shots = import.meta.env.VITE_CONTEXT_COMPACT_SHOTS as string | undefined;
    const shot = async (state: string) => {
      if (shots) await page.screenshot({ path: `${shots}/context-compact-${state}-${width}x${height}.png` });
    };
    let finish!: (result: unknown) => void;
    apiMock.compactThread.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ status: "skipped", trigger: "manual", operationId: "second" })
      .mockRejectedValueOnce(new Error("This conversation is busy."))
      .mockRejectedValueOnce(new Error("Context compaction failed."));
    const context = { status: "current" as const, usage: { total: 50_000, contextWindow: 100_000 } };
    const { rerender } = render(<ContextDisplay context={context} />);
    fireEvent.click(screen.getByRole("button", { name: /context usage/i }));
    // Absent capability: no action at all.
    expect(within(screen.getByRole("dialog", { name: "Context usage" })).queryByRole("button", { name: "Compact" })).toBeNull();
    // A running turn blocks the action without calling the API.
    rerender(<ContextDisplay compactThreadId="one" compactBlocked context={context} />);
    expect(within(screen.getByRole("dialog", { name: "Context usage" })).getByRole("button", { name: "Compact" })).toBeDisabled();
    const hint = screen.getByText("Available when the current turn finishes.");
    hint.scrollIntoView({ block: "nearest" });
    await waitFor(() => { expect(hint).toBeVisible(); });
    await shot("blocked");
    rerender(<ContextDisplay compactThreadId="one" context={context} />);
    const dialog = screen.getByRole("dialog", { name: "Context usage" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Compact" }));
    expect(within(dialog).getByRole("button", { name: "Compacting…" })).toBeDisabled();
    await waitFor(() => { expect(dialog).toBeVisible(); });
    within(dialog).getByText("Compacting conversation context…").scrollIntoView({ block: "nearest" });
    expect(within(dialog).getByText("Compacting conversation context…")).toBeVisible();
    await shot("pending");
    finish({ status: "succeeded", trigger: "manual", operationId: "first", tokensBefore: 60_000, tokensAfter: 20_000 });
    expect(await within(dialog).findByText(/~60k → ~20k tokens/u)).toBeVisible();
    await shot("success");
    fireEvent.click(within(dialog).getByRole("button", { name: "Compact" }));
    expect(await within(dialog).findByText("Nothing to compact")).toBeVisible();
    await shot("skipped");
    fireEvent.click(within(dialog).getByRole("button", { name: "Compact" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("busy");
    await shot("busy");
    fireEvent.click(within(dialog).getByRole("button", { name: "Compact" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Context compaction failed.");
    await shot("error");
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(apiMock.compactThread).toHaveBeenCalledTimes(4);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  });
});

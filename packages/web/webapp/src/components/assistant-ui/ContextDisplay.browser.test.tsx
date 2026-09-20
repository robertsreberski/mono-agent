import { fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import type { ProviderUsageSnapshot } from "../../types";
import "../../styles.css";

const apiMock = vi.hoisted(() => ({ providerUsage: vi.fn(), refreshProviderUsage: vi.fn() }));
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
});

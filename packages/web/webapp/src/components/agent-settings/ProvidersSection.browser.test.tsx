import { render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import type { AgentSummary } from "../../types";
import "../../styles.css";

const store = vi.hoisted(() => ({ selectedAgent: null as AgentSummary | null, activeThreads: null, catalogByProvider: {}, ensureProviderCatalog: vi.fn(), setAgentPinned: vi.fn(), setAgentRunDefaults: vi.fn(), clearAgentRunDefaults: vi.fn() }));
const mocks = vi.hoisted(() => ({ providerAuthStatus: vi.fn(), providerUsage: vi.fn(), latestAgentRestart: vi.fn() }));
vi.mock("../../console-store", () => ({ useConsoleStore: () => store }));
vi.mock("../../api", async (original) => ({ ...await original<typeof import("../../api")>(), api: mocks }));
import { AgentSettingsScreen } from "./AgentSettingsScreen";

beforeEach(() => {
  vi.clearAllMocks();
  store.selectedAgent = agent("atlas", { label: "Atlas", supportsProviderAuth: true, supportsProviderUsage: true, supportsProviderUsageRefresh: true, supportsProviderAuthChecks: true });
  mocks.latestAgentRestart.mockResolvedValue(null);
  mocks.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: [
    { providerId: "anthropic", label: "Claude", state: "missing", verification: "not_verified", methods: [{ authType: "oauth", strategy: "paste_back", label: "Sign in", recommended: true }] },
    { providerId: "openai-codex", label: "Codex", state: "present", verification: "verified_by_live_request", methods: [{ authType: "oauth", strategy: "paste_back", label: "Sign in", recommended: true }] },
  ] });
  mocks.providerUsage.mockResolvedValue({ schema: "mono-agent.provider-usage.v1", providers: [{ providerId: "openai-codex", label: "Codex", fetchedAt: new Date(Date.now() - 7_200_000).toISOString(), stale: true, windows: [{ kind: "weekly", label: "Weekly", usedPercent: 50, periodMs: 604800000, resetsAt: new Date(Date.now() + 300000000).toISOString() }] }] });
});
const touch = inject("providerUsageTouch");
describe("settings provider density", () => {
  it("keeps 28px compact visuals within 44px touch slots and labels stale usage", async () => {
    const width = touch ? 390 : 1200;
    await page.viewport(width, 844);
    render(<AgentSettingsScreen section="providers" layout={touch ? "stacked" : "split"} onSection={() => undefined} onBack={() => undefined} onClose={() => undefined} onNotice={() => undefined} />);
    await screen.findByRole("progressbar", { name: /Codex Weekly used/ });
    expect(screen.getByText(/Last known ·/)).toBeVisible();
    expect(screen.getByText("Check access may use quota")).toBeVisible();
    const buttons = [screen.getByRole("button", { name: "Refresh usage" }), screen.getByRole("button", { name: "Check access" }), screen.getByRole("button", { name: "Authenticate Claude" })];
    for (const button of buttons) {
      expect(button.getBoundingClientRect().height).toBe(28);
      expect(getComputedStyle(button).fontSize).toBe("10px");
      const slot = button.closest(".settings-hit")!;
      expect(slot.getBoundingClientRect().height).toBeGreaterThanOrEqual(touch ? 44 : 28);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (touch) {
      const close = screen.getByRole("button", { name: /Atlas settings/ });
      expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await page.viewport(320, 720);
      await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320));
    }
  });
});

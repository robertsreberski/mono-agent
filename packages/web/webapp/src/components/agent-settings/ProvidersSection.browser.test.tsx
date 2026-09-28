import { render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { agent } from "../../test/fixtures";
import { discardSettingsDraft, setSettingsDraft } from "../../settings-drafts";
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
    expect(screen.getByRole("button", { name: "Check access" }).getAttribute("aria-describedby")).toBe("settings-provider-disclosure");
    expect(document.getElementById("settings-provider-disclosure")!.textContent).toContain("one small model request");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (touch) {
      for (const button of buttons) {
        button.scrollIntoView({ block: "center" });
        const rect = button.closest(".settings-hit")!.getBoundingClientRect();
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        for (const dx of [-20, 20]) for (const dy of [-20, 20]) {
          expect(button.closest(".settings-hit")!.contains(document.elementFromPoint(cx + dx, cy + dy))).toBe(true);
        }
      }
      const close = screen.getByRole("button", { name: /Atlas settings/ });
      expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await page.viewport(320, 720);
      document.documentElement.style.fontSize = "125%";
      try { await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)); }
      finally { document.documentElement.style.fontSize = ""; }
    }
  });  it("keeps save, discard and back controls in 44px coarse-pointer hitboxes", async () => {
    if (!touch) return;
    await page.viewport(360, 780);
    setSettingsDraft("atlas", { model: "grove/fast", effort: "low" });
    try {
      render(<AgentSettingsScreen section="new-conversations" layout="stacked" onSection={() => undefined} onBack={() => undefined} onClose={() => undefined} onNotice={() => undefined} />);
      for (const button of [screen.getByRole("button", { name: "Discard" }), screen.getByRole("button", { name: "Save for new conversations" }), screen.getByRole("button", { name: /Atlas settings/ })]) {
        const bounds = button.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        for (const dx of [-20, 20]) for (const dy of [-20, 20]) {
          expect(button.contains(document.elementFromPoint((bounds.left + bounds.right) / 2 + dx, (bounds.top + bounds.bottom) / 2 + dy))).toBe(true);
        }
      }
    } finally { discardSettingsDraft("atlas"); }
  });

});

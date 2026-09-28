import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    render(<AgentSettingsScreen section="providers" layout={touch ? "stacked" : "split"} onClose={() => undefined} onNotice={() => undefined} />);
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
      const close = screen.getByRole("button", { name: "Back from agent settings" });
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
      render(<AgentSettingsScreen section="new-conversations" layout="stacked" onClose={() => undefined} onNotice={() => undefined} />);
      for (const button of [screen.getByRole("button", { name: "Discard" }), screen.getByRole("button", { name: "Save for new conversations" }), screen.getByRole("button", { name: "Back from agent settings" })]) {
        const bounds = button.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        for (const dx of [-20, 20]) for (const dy of [-20, 20]) {
          expect(button.contains(document.elementFromPoint((bounds.left + bounds.right) / 2 + dx, (bounds.top + bounds.bottom) / 2 + dy))).toBe(true);
        }
      }
    } finally { discardSettingsDraft("atlas"); }
  });
  it("stacks phone Agent fact labels above left-aligned values without changing desktop rows", async () => {
    await page.viewport(touch ? 360 : 1200, 780);
    store.selectedAgent = agent("atlas", { label: "Atlas", restart: { supported: true } });
    render(<AgentSettingsScreen section="agent" layout={touch ? "stacked" : "split"} onClose={() => undefined} onNotice={() => undefined} />);
    await screen.findByText("No recent restart");
    const rows = [...document.querySelectorAll(".settings-agent-fact-row")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const label = row.querySelector(".settings-row-title")!.getBoundingClientRect();
      const value = row.querySelector(".settings-row-value")!.getBoundingClientRect();
      if (touch) {
        expect(label.bottom).toBeLessThanOrEqual(value.top);
        expect(Math.abs(label.left - value.left)).toBeLessThanOrEqual(1);
      } else expect(Math.abs((label.top + label.bottom) / 2 - (value.top + value.bottom) / 2)).toBeLessThanOrEqual(2);
    }
  });

  it("holds an initial Restart target through a delayed dense provider response without stealing user scroll", async () => {
    await page.viewport(390, 720);
    let resolve!: (value: unknown) => void;
    mocks.providerAuthStatus.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    store.selectedAgent = agent("atlas", { label: "Atlas", supportsProviderAuth: true, restart: { supported: true } });
    render(<AgentSettingsScreen section="agent" layout="stacked" onClose={() => undefined} onNotice={() => undefined} />);
    const scroller = document.querySelector<HTMLElement>(".settings-content")!;
    const restart = screen.getByRole("region", { name: "Restart" });
    expect(document.activeElement).toBe(restart);
    await waitFor(() => expect(mocks.providerAuthStatus).toHaveBeenCalled());
    await act(async () => resolve({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: Array.from({ length: 9 }, (_, index) => ({ providerId: `fixture-${index}`, label: `Provider ${index}`, state: "missing", verification: "not_verified", methods: [] })) }));
    await screen.findByText("Provider 8");
    expect(restart.getBoundingClientRect().top).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().top - 16);
    expect(restart.getBoundingClientRect().top).toBeLessThan(scroller.getBoundingClientRect().bottom);
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller);
    mocks.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: [] });
    expect(scroller.scrollTop).toBe(0);
  });

  it("does not re-scroll after the user moves while providers are pending", async () => {
    await page.viewport(390, 720);
    let resolve!: (value: unknown) => void;
    store.selectedAgent = agent("atlas", { label: "Atlas", supportsProviderAuth: true, restart: { supported: true } });
    mocks.providerAuthStatus.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<AgentSettingsScreen section="agent" layout="stacked" onClose={() => undefined} onNotice={() => undefined} />);
    const scroller = document.querySelector<HTMLElement>(".settings-content")!;
    await waitFor(() => expect(mocks.providerAuthStatus).toHaveBeenCalled());
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller);
    await act(async () => resolve({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: Array.from({ length: 9 }, (_, index) => ({ providerId: `fixture-${index}`, label: `Provider ${index}`, state: "missing", verification: "not_verified", methods: [] })) }));
    await screen.findByText("Provider 8");
    expect(scroller.scrollTop).toBe(0);
  });

});

import { render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { createRef } from "react";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { agent } from "../test/fixtures";
import type { ProviderUsageSnapshot } from "../types";
import "../styles.css";
const store = vi.hoisted(() => ({ selectedAgent: null as ReturnType<typeof agent> | null, catalogByProvider: {}, ensureProviderCatalog: vi.fn(), setAgentPinned: vi.fn(), setAgentRunDefaults: vi.fn(), clearAgentRunDefaults: vi.fn() }));
const mocks = vi.hoisted(() => ({ providerAuthStatus: vi.fn(), providerUsage: vi.fn() }));
vi.mock("../console-store", () => ({ useConsoleStore: () => store }));
vi.mock("../api", () => ({ api: mocks }));
import { AgentSettingsDialog } from "./AgentSettingsDialog";
declare module "vitest" {
  export interface ProvidedContext { providerUsageTouch: boolean }
}
const touch = inject("providerUsageTouch");
const viewport = touch ? { width: 390, height: 844 } : { width: 1280, height: 800 };
const reset = new Date(Date.now() + 3_600_000).toISOString();
const snapshot: ProviderUsageSnapshot = { schema: "mono-agent.provider-usage.v1", providers: [
  { providerId: "anthropic", label: "Claude", fetchedAt: new Date().toISOString(), stale: false, windows: [
    { kind: "session", label: "Session", usedPercent: 38, periodMs: 18000000, resetsAt: reset },
    { kind: "weekly", label: "Weekly", usedPercent: 30, periodMs: 604800000, resetsAt: reset },
    { kind: "model", label: "Fable", usedPercent: 31, periodMs: 604800000, resetsAt: reset },
  ] },
  { providerId: "openai-codex", label: "Codex", plan: "Pro 20x", fetchedAt: new Date().toISOString(), stale: false, windows: [
    { kind: "weekly", label: "Weekly", usedPercent: 48, periodMs: 604800000, resetsAt: reset },
  ] },
  { providerId: "opencode-go", label: "OpenCode Go", plan: "Go", fetchedAt: new Date().toISOString(), stale: false, windows: [
    { kind: "session", label: "Session", usedPercent: 0, periodMs: 18000000, resetsAt: reset },
    { kind: "weekly", label: "Weekly", usedPercent: 1, periodMs: 604800000, resetsAt: reset },
    { kind: "monthly", label: "Monthly", usedPercent: 17, periodMs: 2592000000, resetsAt: reset },
  ] },
] };
beforeEach(() => {
  vi.clearAllMocks();
  store.selectedAgent = agent("fixture", { label: "Synthetic usage fixture", supportsProviderAuth: true, supportsProviderUsage: true, supportsProviderAuthChecks: true,
    defaultModel: "anthropic:claude-sonnet-4-6", models: ["anthropic:claude-sonnet-4-6"],
  });
  mocks.providerUsage.mockResolvedValue(snapshot);
  mocks.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: snapshot.providers.map((p) => ({
    providerId: p.providerId, label: p.label, usages: [], state: "present", source: "stored", verification: p.providerId === "openai-codex" ? "verified_by_live_request" : "verified_by_account_request",
    methods: [{ authType: p.providerId === "opencode-go" ? "api_key" : "oauth", strategy: "paste_back", label: "Login", recommended: true }],
  })) });
});
describe("compact Agent settings subscription meters", () => {
  it(`renders compact controls without overflow with ${touch ? "coarse touch" : "fine desktop"} input`, async () => {
    const { width, height } = viewport;
    await page.viewport(width, height);
    expect(matchMedia("(pointer: coarse)").matches).toBe(touch);
    expect(matchMedia("(pointer: fine)").matches).toBe(!touch);
    expect(navigator.maxTouchPoints > 0).toBe(touch);
    render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);
    await screen.findByRole("progressbar", { name: "Codex Weekly used" });
    expect(screen.getAllByRole("progressbar")).toHaveLength(7);
    expect(screen.queryByRole("progressbar", { name: "Codex Session used" })).toBeNull();
    expect(screen.getByText("Pro 20x")).toBeVisible();
    expect(screen.getByText("0%")).toBeVisible();
    expect(screen.getAllByText("Credential OK")).toHaveLength(2);
    const accountBadge = screen.getAllByText("Credential OK")[0]!.closest(".provider-auth-state")!;
    const liveBadge = screen.getByText("OK", { exact: true }).closest(".provider-auth-state")!;
    expect(accountBadge).toHaveClass("is-ok-account");
    expect(liveBadge).toHaveClass("is-ok");
    expect(getComputedStyle(accountBadge).color).toBe(getComputedStyle(liveBadge).color);
    expect(getComputedStyle(accountBadge).fontSize).toBe("10px");
    const codexHeading = screen.getByText("Pro 20x").closest(".provider-auth-heading")!;
    expect([...codexHeading.querySelectorAll("b, .provider-usage-plan, .provider-auth-state")].map((child) => child.textContent?.trim())).toEqual(["Codex", "Pro 20x", "✓ OK"]);
    const headingItems = [...codexHeading.querySelectorAll("b, .provider-usage-plan, .provider-auth-state")];
    const centers = headingItems.map((item) => { const rect = item.getBoundingClientRect(); return rect.y + rect.height / 2; });
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    const actions = [
      ...screen.getAllByRole("button", { name: "Re-authenticate" }),
      screen.getByRole("button", { name: "Run live checks for all displayed providers" }),
      screen.getByRole("button", { name: "Save for new conversations" }),
    ];
    for (const button of actions) {
      expect(getComputedStyle(button).fontSize).toBe("12px");
      expect(button.getBoundingClientRect().height).toBe(28);
    }
    const headerIcons = document.querySelectorAll(".agent-settings-header-actions .icon-button");
    expect(headerIcons).toHaveLength(2);
    for (const icon of headerIcons) {
      expect(icon.getBoundingClientRect().width).toBe(28);
      expect(icon.getBoundingClientRect().height).toBe(28);
    }
    expect(screen.queryByText(/Sonnet|Spark|credits/)).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(width);
    expect(screen.getByRole("button", { name: "Save for new conversations" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "OpenCode Go Monthly used" })).toBeVisible());
    const directory = import.meta.env.VITE_PROVIDER_USAGE_SHOTS;
    if (directory) await page.screenshot({ path: `${directory}/synthetic-agent-settings-${width}x${height}-${touch ? "coarse-touch" : "fine-desktop"}.png` });
  });
});

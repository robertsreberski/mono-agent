import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { agent } from "../test/fixtures";
import type { ProviderUsageSnapshot } from "../types";
import "../styles.css";
const store = vi.hoisted(() => ({ selectedAgent: null as ReturnType<typeof agent> | null, catalogByProvider: {}, ensureProviderCatalog: vi.fn(), setAgentPinned: vi.fn(), setAgentRunDefaults: vi.fn(), clearAgentRunDefaults: vi.fn() }));
const mocks = vi.hoisted(() => ({ providerAuthStatus: vi.fn(), providerUsage: vi.fn(), refreshProviderUsage: vi.fn() }));
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
  { providerId: "github-copilot", label: "GitHub Copilot", plan: "Individual", fetchedAt: new Date().toISOString(), stale: false, windows: [
    { kind: "credits", label: "Credits", usedPercent: 42.1, periodMs: 2592000000, resetsAt: reset },
  ] },
] };
beforeEach(() => {
  vi.clearAllMocks();
  store.selectedAgent = agent("fixture", { label: "Synthetic usage fixture", supportsProviderAuth: true, supportsProviderUsage: true, supportsProviderUsageRefresh: true, supportsProviderAuthChecks: true,
    defaultModel: "anthropic:claude-sonnet-4-6", models: ["anthropic:claude-sonnet-4-6"],
  });
  mocks.providerUsage.mockResolvedValue(snapshot);
  mocks.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: snapshot.providers.filter((p) => p.providerId !== "github-copilot").map((p) => ({
    providerId: p.providerId, label: p.label, usages: [], state: "present", source: "stored", verification: p.providerId === "openai-codex" ? "verified_by_live_request" : "verified_by_account_request",
    methods: [{ authType: p.providerId === "opencode-go" ? "api_key" : "oauth", strategy: "paste_back", label: "Login", recommended: true }],
  })) });
});
afterEach(async () => { await commands.emulateColorScheme(null); });
describe("compact Agent settings subscription meters", () => {
  it.each(["light", "dark"] as const)(`renders compact controls with ${touch ? "coarse touch" : "fine desktop"} input in %s`, async (theme) => {
    await commands.emulateColorScheme(theme);
    expect(matchMedia(`(prefers-color-scheme: ${theme})`).matches).toBe(true);
    const { width, height } = viewport;
    await page.viewport(width, height);
    expect(matchMedia("(pointer: coarse)").matches).toBe(touch);
    expect(matchMedia("(pointer: fine)").matches).toBe(!touch);
    expect(navigator.maxTouchPoints > 0).toBe(touch);
    render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);
    await screen.findByRole("progressbar", { name: "Codex Weekly used" });
    expect(screen.getAllByRole("progressbar")).toHaveLength(8);
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
      screen.getByRole("button", { name: "Check access" }),
      screen.getByRole("button", { name: "Refresh usage" }),
    ];
    for (const button of actions) {
      expect(getComputedStyle(button).fontSize).toBe("10px");
      expect(button.getBoundingClientRect().height).toBe(28);
    }
    const headerIcons = document.querySelectorAll(".agent-settings-header-actions .icon-button");
    expect(headerIcons).toHaveLength(2);
    for (const icon of headerIcons) {
      expect(icon.getBoundingClientRect().width).toBe(36);
      expect(icon.getBoundingClientRect().height).toBe(36);
      expect(getComputedStyle(icon).borderRadius).toBe("10px");
    }
    const copilot = screen.getByText("GitHub Copilot").closest("article")!;
    expect(screen.getByText("Usage only")).toBeVisible();
    expect(copilot.querySelector("button, .provider-auth-state, .provider-auth-check-result")).toBeNull();
    expect([...document.querySelectorAll(".provider-auth-card b")].map((element) => element.textContent)).toEqual(["Claude", "Codex", "OpenCode Go", "GitHub Copilot"]);
    expect(screen.getByRole("progressbar", { name: "GitHub Copilot Credits used" })).toHaveAttribute("value", "42.1");
    const refreshButton = screen.getByRole("button", { name: "Refresh usage" });
    expect(refreshButton).toHaveAttribute("title", "Refresh usage");
    const runButton = screen.getByRole("button", { name: "Check access" });
    expect(refreshButton.getBoundingClientRect().y).toBe(runButton.getBoundingClientRect().y);
    expect(refreshButton).toHaveTextContent("Refresh usage");
    expect(runButton).toHaveTextContent("Check access");
    expect(screen.queryByText(/Run again|Run check/)).toBeNull();
    expect(refreshButton).toHaveAccessibleDescription(/Refresh usage reads subscription limits without inference\. Check access sends one small model request/);
    expect(runButton).toHaveAccessibleDescription(/may use quota or refresh OAuth/);
    const actionsGroup = refreshButton.closest(".provider-auth-header-actions")!;
    expect(actionsGroup.scrollWidth).toBeLessThanOrEqual(actionsGroup.clientWidth);
    expect(getComputedStyle(refreshButton).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(runButton).whiteSpace).toBe("nowrap");
    const save = screen.getByRole("button", { name: "Save for new conversations" });
    expect(getComputedStyle(save).fontSize).toBe("12px");
    expect(save.getBoundingClientRect().height).toBe(28);
    expect(screen.queryByText(/Sonnet|Spark|credits/)).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(width);
    expect(screen.getByRole("button", { name: "Save for new conversations" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "OpenCode Go Monthly used" })).toBeVisible());
    expect(screen.getByRole("progressbar", { name: "GitHub Copilot Credits used" })).toBeVisible();
    const directory = import.meta.env.VITE_PROVIDER_USAGE_SHOTS;
    if (directory) await page.screenshot({ path: `${directory}/synthetic-agent-settings-${width}x${height}-${touch ? "coarse-touch" : "fine-desktop"}-${theme}.png` });
  });
  it("shows a bounded pending refresh and retains meters on failure in dark mode", async () => {
    await commands.emulateColorScheme("dark");
    await page.viewport(viewport.width, viewport.height);
    let reject!: (error: Error) => void;
    mocks.refreshProviderUsage.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);
    await screen.findByRole("progressbar", { name: "Codex Weekly used" });
    const button = screen.getByRole("button", { name: "Refresh usage" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Refreshing usage…")).toBeVisible();
    expect(getComputedStyle(button.querySelector("svg")!).animationName).toBe("spin");
    const directory = import.meta.env.VITE_PROVIDER_USAGE_SHOTS;
    const name = `${viewport.width}x${viewport.height}-${touch ? "coarse-touch" : "fine-desktop"}-dark`;
    if (directory) await page.screenshot({ path: `${directory}/synthetic-agent-settings-${name}-refresh-pending.png` });
    await act(async () => reject(new Error("PRIVATE_VENDOR_DETAIL")));
    await screen.findByText(/Usage refresh failed/);
    expect(button).toBeEnabled();
    expect(screen.getByRole("progressbar", { name: "Codex Weekly used" })).toHaveAttribute("value", "48");
    expect(document.body.textContent).not.toContain("PRIVATE_VENDOR_DETAIL");
    expect(screen.getByRole("progressbar", { name: "GitHub Copilot Credits used" })).toHaveAttribute("value", "42.1");
    expect(screen.getByText("Usage only").closest("article")!.querySelector(".provider-auth-state, button")).toBeNull();
    if (directory) await page.screenshot({ path: `${directory}/synthetic-agent-settings-${name}-refresh-error.png` });
  });

  it.each([false, true])("renders free Copilot configured=%s without duplicate or fabricated auth", async (configured) => {
    await page.viewport(viewport.width, viewport.height);
    const copilot = snapshot.providers.find((p) => p.providerId === "github-copilot")!;
    mocks.providerUsage.mockResolvedValue({ ...snapshot, providers: [{ ...copilot, plan: "Free", windows: [
      { kind: "chat", label: "Chat", usedPercent: 60, periodMs: 2592000000 },
      { kind: "completions", label: "Completions", usedPercent: 25, periodMs: 2592000000 },
    ] }] });
    mocks.providerAuthStatus.mockResolvedValue({ schema: "mono-agent.provider-auth.v1", generatedAt: new Date().toISOString(), providers: configured ? [{
      providerId: "github-copilot", label: "GitHub Copilot", usages: [], state: "present", source: "stored", verification: "not_verified",
      methods: [{ authType: "oauth", strategy: "paste_back", label: "Login", recommended: true }],
    }] : [] });
    render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);
    await screen.findByRole("progressbar", { name: "GitHub Copilot Chat used" });
    expect(screen.getAllByText("GitHub Copilot")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "GitHub Copilot Completions used" })).toHaveAttribute("value", "25");
    expect(screen.queryByRole("progressbar", { name: "GitHub Copilot Credits used" })).toBeNull();
    expect(document.querySelectorAll(".provider-auth-card")).toHaveLength(1);
    expect(document.querySelectorAll(".provider-auth-state")).toHaveLength(configured ? 1 : 0);
    expect(screen.queryAllByRole("button", { name: "Re-authenticate" })).toHaveLength(configured ? 1 : 0);
    expect(screen.queryAllByText("Usage only")).toHaveLength(configured ? 0 : 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
  });

});

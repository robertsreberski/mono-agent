import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "./test/fixtures";
import { routeWriteState } from "./mobile-history";
import "./styles.css";
const storeMock = vi.hoisted(() => ({
  loading: false,
  bootstrap: { console: { hostName: "console-host", displayName: "console-host", theme: "ocean" as const } },
  error: null,
  actionError: null,
  clearActionError: vi.fn(),
  agents: [],
  visibleAgents: [],
  selectedAgent: null,
  selectionLoading: false,
  selectionError: null,
  selectedThread: null,
  hasRunningThread: false,
  openProjectId: null as string | null,
  openProjectById: vi.fn(),
  closeProject: vi.fn(),
  showArchived: false,
  showOfflineAgents: false,
  hiddenOfflineAgentCount: 0,
  createThread: vi.fn(),
  renameThread: vi.fn(),
  setAgentPinned: vi.fn(),
  setAgentRunDefaults: vi.fn(),
  clearAgentRunDefaults: vi.fn(),
  catalogByProvider: {},
  ensureProviderCatalog: vi.fn(),
  setShowArchived: vi.fn(),
  setShowOfflineAgents: vi.fn(),
  selectAgent: vi.fn(),
  clearCachedData: vi.fn(async () => undefined),
  clearError: vi.fn(),
  retry: vi.fn(),
  retrySelection: vi.fn(),
  hasServerSnapshot: true,
  setConversationVisible: vi.fn(),
}));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock,
}));

vi.mock("./components/BrandMark", () => ({
  BrandMark: () => <span>mono-agent</span>,
}));

vi.mock("./components/Chat", () => ({
  Chat: ({ onBack }: { readonly onBack: () => void }) => (
    <main>
      Chat
      <button type="button" onClick={onBack}>Back to dashboard</button>
    </main>
  ),
}));

vi.mock("./components/dashboard/Dashboard", () => ({
  Dashboard: ({
    onNavigate,
    onCloseProject,
  }: {
    readonly onNavigate?: () => void;
    readonly onCloseProject?: () => void;
  }) => (
    <div data-testid="dashboard">
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("mono-agent:agent-settings"))}>Agent settings gear</button>
      <button type="button" onClick={onNavigate}>Open a conversation</button>
      {storeMock.openProjectId !== null && (
        <button type="button" onClick={onCloseProject}>Back to project conversations</button>
      )}
    </div>
  ),
}));

const latestRestart = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("./api", async (original) => {
  const module = await original<typeof import("./api")>();
  return { ...module, api: { ...module.api, latestAgentRestart: latestRestart } };
});
import { App } from "./App";
const position = (): number => (window as unknown as Window & { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index;
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  storeMock.selectedAgent = agent("atlas", { label: "Atlas", restart: { supported: true } }) as never;
  storeMock.openProjectId = null;
  storeMock.setConversationVisible.mockClear();
  latestRestart.mockClear();
});
describe("settings screen navigation", () => {
  it("covers the entire 360px viewport after the entrance animation and keeps the shell inert", async () => {
    await page.viewport(360, 780);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    const surface = document.querySelector<HTMLElement>(".settings-region")!;
    await waitFor(() => expect(surface.getBoundingClientRect().left).toBeCloseTo(0, 0));
    expect(surface.getBoundingClientRect().width).toBe(360);
    expect(surface.getBoundingClientRect().right).toBe(360);
    expect(getComputedStyle(surface).position).toBe("fixed");
    expect(document.querySelector(".dashboard-panel")!.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".chat-region")!.hasAttribute("inert")).toBe(true);
    expect(surface.contains(document.elementFromPoint(8, 400))).toBe(true);
    const back = screen.getByRole("button", { name: "Close settings" }).getBoundingClientRect();
    const eyebrow = document.querySelector(".settings-phone-index-title .eyebrow")!.getBoundingClientRect();
    const title = screen.getByRole("heading", { name: "Atlas", level: 1 }).getBoundingClientRect();
    const facts = document.querySelector(".settings-facts-card")!.getBoundingClientRect();
    expect(back.bottom).toBeLessThan(eyebrow.top);
    expect(eyebrow.bottom).toBeLessThanOrEqual(title.top);
    expect(title.bottom).toBeLessThan(facts.top);
    expect(title.left).toBeLessThan(30);
    expect(document.querySelector(".settings-phone-index-header .settings-agent-tile")).toBeNull();
  });
  it("opens on desktop without writing history, closes on Escape and gates read marking", async () => {
    await page.viewport(1200, 800);
    const start = position();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    expect(screen.getByRole("heading", { name: "Atlas", level: 1 })).toBeVisible();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(document.querySelector(".dashboard-panel")!.hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".chat-region")!.hasAttribute("inert")).toBe(true);
    expect(position()).toBe(start);
    await waitFor(() => expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(false));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("New conversations", { selector: ".settings-rail-label" })).toBeNull();
    expect(position()).toBe(start);
    await waitFor(() => expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(true));
  });
  it("lets a nested picker consume Escape before closing the screen (A18)", async () => {
    await page.viewport(1200, 800);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    await waitFor(() => expect(document.querySelector('[data-slot="model-selector-content"]')).not.toBeNull());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-slot="model-selector-content"]')).toBeNull());
    expect(screen.getByRole("button", { name: "Close agent settings" })).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
  });
  it("pushes index and detail on a phone, then Back and Forward restore the section", async () => {
    await page.viewport(390, 844);
    const start = position();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(document.querySelector(".dashboard-panel")!.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".chat-region")!.hasAttribute("inert")).toBe(true);
    expect(position()).toBe(start + 1);
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
    expect(position()).toBe(start + 2);
    window.history.back();
    await waitFor(() => expect(position()).toBe(start + 1));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
    window.history.forward();
    await waitFor(() => expect(position()).toBe(start + 2));
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
  });
  it("uses tabs through 1100px and a rail at 1101px without horizontal overflow", async () => {
    await page.viewport(1200, 800);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    for (const width of [901, 1059, 1060, 1100, 1101]) {
      await page.viewport(width, 800);
      await waitFor(() => expect(getComputedStyle(document.querySelector(".settings-rail")!).flexDirection).toBe(width <= 1100 ? "row" : "column"));
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    }
  });
  it("establishes an index and detail on a desktop-to-phone resize (N16)", async () => {
    await page.viewport(1200, 800);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const before = position();
    await page.viewport(390, 844);
    await waitFor(() => expect(position()).toBe(before + 2));
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(position()).toBe(before + 1));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
  });
  it("keeps a replaced settings marker owned at its new URL (N21)", async () => {
    await page.viewport(390, 844);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const url = "/agents/atlas/cron/fictional";
    window.history.replaceState(routeWriteState(window.history.state, url, "replace"), "", url);
    expect(window.history.state.monoAgentMobileNavigation.href).toBe(window.location.href);
    window.history.back();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible());
  });
  it("keeps the project entry beneath settings when the screen remounts (N22)", async () => {
    await page.viewport(390, 844);
    const view = render(<App />);
    storeMock.openProjectId = "fictional-project";
    view.rerender(<App />);
    await waitFor(() => expect(window.history.state.monoAgentMobileNavigation.surface).toBe("project"));
    const projectPosition = position();
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const detailPosition = position();
    view.unmount();
    render(<App />);
    expect(position()).toBe(detailPosition);
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(position()).toBe(projectPosition + 1));
    window.history.back();
    await waitFor(() => expect(position()).toBe(projectPosition));
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("project");
  });
  it("never closes by copied depth after a phone-to-desktop route push (N18/N19)", async () => {
    await page.viewport(390, 844);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent Not pinned/ }));
    await page.viewport(1200, 800);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close agent settings" })).toBeVisible());
    const url = "/agents/atlas/cron/fictional";
    window.history.pushState(routeWriteState(window.history.state, url, "push"), "", url);
    const index = position();
    fireEvent.click(screen.getByRole("button", { name: "Close agent settings" }));
    expect(position()).toBe(index);
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("conversation");
    window.history.back();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Agent", level: 2 })).toBeVisible());
    window.history.forward();
    await waitFor(() => expect(position()).toBe(index));
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
  });
  it("keeps a covered phone conversation unread until the conversation is visible (A8)", async () => {
    await page.viewport(390, 844);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    await waitFor(() => expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(false);
    window.history.back();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible());
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Agent settings sections" })).toBeNull());
    expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Open a conversation" }));
    await waitFor(() => expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(true));
  });
  it("restores the Providers row focus after Back, then closes the index without an extra entry (N1/N2)", async () => {
    await page.viewport(390, 844);
    const start = position();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    window.history.back();
    await waitFor(() => expect(position()).toBe(start + 1));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Providers/ })));
    window.history.back();
    await waitFor(() => expect(position()).toBe(start));
    expect(screen.queryByRole("navigation", { name: "Agent settings sections" })).toBeNull();
    window.history.forward();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible());
    expect(position()).toBe(start + 1);
  });
  it("handles Escape and right swipe one level at a time (N3)", async () => {
    await page.viewport(390, 844);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const scroll = document.querySelector(".settings-scroll")!;
    const startTouch = new Touch({ identifier: 1, target: scroll, clientX: 20, clientY: 250 });
    const endTouch = new Touch({ identifier: 1, target: scroll, clientX: 200, clientY: 251 });
    fireEvent.touchStart(scroll, { touches: [startTouch] });
    fireEvent.touchEnd(scroll, { touches: [], changedTouches: [endTouch] });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Agent settings sections" })).toBeNull());
  });
  it("restores a detail on remount without adding an entry (N5)", async () => {
    await page.viewport(390, 844);
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const detail = position();
    view.unmount();
    render(<App />);
    expect(position()).toBe(detail);
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(position()).toBe(detail - 1));
  });
  it("normalizes a phone cold link exactly once under StrictMode (N6)", async () => {
    await page.viewport(390, 844);
    window.history.replaceState(null, "", "/?settings=providers");
    const start = position();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible());
    expect(position()).toBe(start + 2);
    expect(location.search).toBe("");
    expect(JSON.stringify(window.history.state)).not.toContain("settings=providers");
    window.history.back();
    await waitFor(() => expect(position()).toBe(start + 1));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
  });
  it("opens a desktop cold link without pushing and removes its URL parameter (N15)", async () => {
    await page.viewport(1200, 800);
    window.history.replaceState(null, "", "/?settings=providers");
    const start = position();
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible());
    expect(position()).toBe(start);
    expect(location.search).toBe("");
    view.unmount();
    render(<App />);
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
  });
  it("pops both owned entries on a phone-to-desktop close and does not reopen on Back (N17)", async () => {
    await page.viewport(390, 844);
    const start = position();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    expect(position()).toBe(start + 2);
    await page.viewport(1200, 800);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close agent settings" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Close agent settings" }));
    await waitFor(() => expect(position()).toBe(start));
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("dashboard");
  });

  it("opens a cron-route cold link once and preserves the cron entry beneath settings (N7)", async () => {
    await page.viewport(390, 844);
    window.history.replaceState(null, "", "/agents/atlas/cron/garden-daily?settings=agent");
    const start = position();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Agent", level: 2 })).toBeVisible());
    expect(position()).toBe(start + 3);
    expect(location.search).toBe("");
    window.history.back();
    await waitFor(() => expect(position()).toBe(start + 2));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(position()).toBe(start + 1));
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("conversation");
    window.history.back();
    await waitFor(() => expect(position()).toBe(start));
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("dashboard");
  });
  it("a plain notification leaves settings on the back stack without copying its marker (N9)", async () => {
    await page.viewport(390, 844);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const detail = position();
    window.dispatchEvent(new Event("mono-agent:open-conversation"));
    await waitFor(() => expect(position()).toBe(detail + 1));
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("conversation");
    expect(screen.queryByRole("heading", { name: "Providers", level: 2 })).toBeNull();
    window.history.back();
    await waitFor(() => expect(position()).toBe(detail));
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
  });
  it("a cron notification reuses the route writer's conversation entry without duplicating it (N10)", async () => {
    await page.viewport(390, 844);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    const detail = position();
    const url = "/agents/atlas/cron/garden-daily";
    window.history.pushState(routeWriteState(window.history.state, url, "push"), "", url);
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("conversation");
    window.dispatchEvent(new Event("mono-agent:open-conversation"));
    expect(position()).toBe(detail + 1);
    window.history.back();
    await waitFor(() => expect(position()).toBe(detail));
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
  });
  it("restores a project entry through breakpoint changes and Forward (N22/N23)", async () => {
    await page.viewport(390, 844);
    const view = render(<App />);
    storeMock.openProjectId = "fictional-project";
    view.rerender(<App />);
    await waitFor(() => expect(window.history.state.monoAgentMobileNavigation.surface).toBe("project"));
    const project = position();
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    fireEvent.click(screen.getByRole("button", { name: /Providers/ }));
    await page.viewport(1200, 800);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close agent settings" })).toBeVisible());
    await page.viewport(390, 844);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible());
    expect(position()).toBe(project + 2);
    window.history.back();
    await waitFor(() => expect(position()).toBe(project + 1));
    window.history.back();
    await waitFor(() => expect(position()).toBe(project));
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("project");
    window.history.forward();
    await waitFor(() => expect(position()).toBe(project + 1));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
  });

});

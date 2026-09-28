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
  it("opens on desktop without writing history, closes on Escape and gates read marking", async () => {
    await page.viewport(1200, 800);
    const start = position();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    expect(screen.getByRole("heading", { name: "Atlas", level: 1 })).toBeVisible();
    expect(position()).toBe(start);
    await waitFor(() => expect(storeMock.setConversationVisible).toHaveBeenLastCalledWith(false));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("New conversations", { selector: ".settings-rail-label" })).toBeNull();
    expect(position()).toBe(start);
  });
  it("pushes index and detail on a phone, then Back and Forward restore the section", async () => {
    await page.viewport(390, 844);
    const start = position();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings gear" }));
    expect(screen.getByRole("navigation", { name: "Agent settings sections" })).toBeVisible();
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
});

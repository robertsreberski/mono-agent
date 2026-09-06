import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RAIL_STORAGE_KEY } from "./agent-rail-layout";
import { readDataModeSetting, writeDataModeSetting } from "./data-mode";
import { recordDataUsage, resetDataUsage } from "./data-usage";
import "./styles.css";

const storeMock = vi.hoisted(() => ({
  loading: false,
  bootstrap: { console: { hostName: "console-host", theme: "ocean" as const } },
  error: null,
  actionError: null,
  clearActionError: vi.fn(),
  agents: [],
  visibleAgents: [],
  selectedAgent: null,
  selectedThread: null,
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
  hasServerSnapshot: true,
}));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock,
}));

vi.mock("./components/AgentRail", () => ({
  AgentRail: ({
    expanded,
    onToggleExpanded,
  }: {
    readonly expanded?: boolean;
    readonly onToggleExpanded?: () => void;
  }) => (
    <div data-testid="agent-rail" data-expanded={String(Boolean(expanded))}>
      <button type="button" onClick={onToggleExpanded}>Toggle agent sidebar</button>
    </div>
  ),
  BrandMark: () => <span>mono-agent</span>,
  MobileAgentPicker: () => <div>Agents</div>,
}));

vi.mock("./components/Chat", () => ({
  Chat: () => <main>Chat</main>,
}));

vi.mock("./components/ThreadSidebar", () => ({
  ThreadSidebar: () => <aside>Threads</aside>,
}));

import { App } from "./App";

beforeEach(() => {
  localStorage.clear();
  document.title = "mono-agent";
});

describe("App agent sidebar toggle", () => {
  it("toggles between the two fixed states and persists the result", () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Toggle agent sidebar" });

    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "false");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "true");
    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("240");

    fireEvent.click(toggle);
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "false");
    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("72");
  });

  it("treats a legacy expanded width as the expanded state", () => {
    localStorage.setItem(AGENT_RAIL_STORAGE_KEY, "204");
    render(<App />);
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "true");
  });
});

describe("App viewport layout", () => {
  it("constrains the grid row so long conversation lists cannot push the composer off-screen", () => {
    const { container } = render(<App />);
    const shell = container.querySelector<HTMLElement>(".app-shell");

    expect(shell).not.toBeNull();
    expect(getComputedStyle(shell!).gridTemplateRows).toBe("minmax(0, 1fr)");
  });

  it("applies the host identity and selected theme to browser chrome", () => {
    render(<App />);

    expect(document.title).toBe("console-host · mono-agent");
    expect(document.documentElement).toHaveAttribute("data-console-theme", "ocean");
  });
});

describe("App snapshot failure", () => {
  afterEach(() => {
    storeMock.error = null;
    storeMock.hasServerSnapshot = true;
  });

  it("keeps a failed snapshot in front of the operator, behind what the device restored", () => {
    // The console now draws before anything is asked for, so `error` is no
    // longer only the fatal screen's business: without a banner, a dead server
    // behind a restored listing shows as stale content and a small pill.
    storeMock.error = "The web console request failed." as unknown as null;
    storeMock.hasServerSnapshot = false;
    render(<App />);

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("The web console request failed.");
    expect(banner).toHaveTextContent("Showing what this browser had stored.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(storeMock.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(storeMock.clearError).toHaveBeenCalledTimes(1);
  });
});

describe("App command palette", () => {
  it("gives the operator a way to clear what this browser has stored", async () => {
    // The console keeps recent conversations on the device now, so there has to
    // be one action that takes them off it -- and it has to say that it did.
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    fireEvent.click(screen.getByRole("option", { name: "Clear cached data" }));

    await waitFor(() => expect(storeMock.clearCachedData).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Cleared the conversations this browser had stored.");
  });
});

describe("App data mode", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
    resetDataUsage();
    localStorage.clear();
  });

  const standalone = (matches: boolean): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: matches && query.includes("standalone"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  };

  it("cycles the mode from the palette and says what the session has cost", async () => {
    recordDataUsage(2_048);
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const action = screen.getByRole("option", { name: /^Data: Auto · Full/u });
    expect(action).toHaveTextContent("2 KiB");
    fireEvent.click(action);

    await waitFor(() => { expect(readDataModeSetting()).toBe("lean"); });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("option", { name: /^Data: Lean/u })).toBeVisible();
  });

  it("offers Lean once to a home-screen install that cannot read the network", async () => {
    // iOS Safari reports no connection at all, so Auto can never resolve to
    // Lean there. Rather than guessing, the console says so once.
    standalone(true);
    const first = render(<App />);

    const offer = await screen.findByRole("status");
    expect(offer).toHaveTextContent("Auto stays on Full");
    fireEvent.click(screen.getByRole("button", { name: "Use Lean" }));
    expect(readDataModeSetting()).toBe("lean");
    first.unmount();

    // Offered once, and never again — including on the next visit.
    writeDataModeSetting("auto");
    render(<App />);
    expect(screen.queryByRole("button", { name: "Use Lean" })).toBeNull();
  });

  it("never offers Lean to a browser that can answer for itself", () => {
    standalone(false);
    render(<App />);
    expect(screen.queryByRole("button", { name: "Use Lean" })).toBeNull();
  });
});

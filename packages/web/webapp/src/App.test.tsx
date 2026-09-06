import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RAIL_STORAGE_KEY } from "./agent-rail-layout";
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./styles.css";

const storeMock = vi.hoisted(() => ({
  loading: false,
  bootstrap: { console: { hostName: "console-host", theme: "ocean" as const } },
  error: null,
  actionError: null,
  clearActionError: vi.fn(),
  conversationDetailOpen: false,
  openConversationIndex: vi.fn(),
  workspaceRoute: { kind: "conversations" as const } as { kind: "conversations" } | { kind: "memory"; sourceId: string },
  openMemory: vi.fn(),
  agents: [] as Array<{ label: string; sourceId: string; pinned: boolean; status: "online" | "offline" }>,
  connection: "live" as "live" | "connecting" | "offline",
  selectedAgent: null as { label: string; sourceId: string; pinned: boolean } | null,
  selectedThread: null as { id: string; title: string } | null,
  showArchived: false,
  showOfflineAgents: false,
  hiddenOfflineAgentCount: 0,
  visibleAgents: [],
  createThread: vi.fn(),
  renameThread: vi.fn(),
  setAgentPinned: vi.fn(),
  setShowArchived: vi.fn(),
  setShowOfflineAgents: vi.fn(),
  selectAgent: vi.fn(),
  activeCardVisible: true,
}));

vi.mock("./console-store", () => ({ useConsoleStore: () => storeMock }));
vi.mock("./components/AgentRail", () => ({
  BrandMark: () => <span>mono-agent</span>,
  AgentRail: () => <aside aria-label="Agents">Agents</aside>,
}));
vi.mock("./components/ConversationWorkspace", () => ({
  ConversationWorkspace: () => (
    <section aria-label="Conversation workspace">
      <label className="workspace-search">Search <input type="search" /></label>
      {storeMock.activeCardVisible && (
        <article className="workspace-thread-card is-active">
          <button type="button" className="workspace-thread-open">Selected conversation</button>
        </article>
      )}
    </section>
  ),
}));
vi.mock("./components/Chat", () => ({
  Chat: ({ onBackToWorkspace }: { readonly onBackToWorkspace: () => void }) => (
    <main><button type="button" className="mobile-conversation-back" onClick={onBackToWorkspace}>Back to conversations</button>Chat</main>
  ),
}));
vi.mock("./components/MemoryWorkspace", () => ({
  MemoryWorkspace: () => {
    const [owner] = useState(() => {
      const source = storeMock.workspaceRoute.kind === "memory" ? storeMock.workspaceRoute.sourceId : "none";
      const status = storeMock.agents.find((agent) => agent.sourceId === source)?.status ?? "missing";
      return `${source}:${storeMock.connection}:${status}`;
    });
    return <main aria-label="Memory workspace">Live memory {owner}</main>;
  },
}));

import { App } from "./App";

beforeEach(() => {
  localStorage.clear();
  document.title = "mono-agent";
  storeMock.conversationDetailOpen = false;
  storeMock.workspaceRoute = { kind: "conversations" };
  storeMock.selectedAgent = null;
  storeMock.agents = [];
  storeMock.connection = "live";
  storeMock.activeCardVisible = true;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App conversation workspace layout", () => {
  it("mounts the conversation workspace and detail as one desktop master-detail shell", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("region", { name: "Conversation workspace" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Chat");
    const shell = container.querySelector<HTMLElement>(".app-shell");
    expect(shell).toHaveClass("conversation-layout");
    expect(getComputedStyle(shell!).gridTemplateRows).toBe("minmax(0, 1fr)");
  });

  it("marks a routed conversation detail and moves phone focus between detail and discovery", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    storeMock.conversationDetailOpen = true;
    const { container, rerender } = render(<App />);
    expect(container.querySelector(".conversation-layout")).toHaveClass("has-conversation-detail");
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to conversations" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(storeMock.openConversationIndex).toHaveBeenCalledTimes(1);
    storeMock.conversationDetailOpen = false;
    rerender(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Selected conversation" })).toHaveFocus());
  });

  it("applies the host identity and selected theme to browser chrome", () => {
    render(<App />);
    expect(document.title).toBe("console-host · mono-agent");
    expect(document.documentElement).toHaveAttribute("data-console-theme", "ocean");
  });

  it("keeps the agent rail and replaces both conversation panes on a memory route", () => {
    storeMock.workspaceRoute = { kind: "memory", sourceId: "alpha" };
    storeMock.agents = [{ label: "Alpha", sourceId: "alpha", pinned: false, status: "online" }];
    const { container } = render(<App />);

    expect(screen.getByRole("complementary", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Memory workspace" })).toHaveTextContent("Live memory");
    expect(screen.queryByRole("region", { name: "Conversation workspace" })).not.toBeInTheDocument();
    expect(container.querySelector(".app-shell")).toHaveClass("memory-layout");
  });

  it("offers the selected agent memory in the command palette", async () => {
    storeMock.selectedAgent = { label: "Alpha", sourceId: "alpha", pinned: false };
    render(<App />);

    fireEvent(window, new Event("mono-agent:command"));
    fireEvent.click(screen.getByRole("option", { name: /open alpha memory/i }));

    await waitFor(() => expect(storeMock.openMemory).toHaveBeenCalledTimes(1));
  });

  it("remounts memory state before rendering another source or an offline transition", () => {
    storeMock.workspaceRoute = { kind: "memory", sourceId: "alpha" };
    storeMock.agents = [
      { label: "Alpha", sourceId: "alpha", pinned: false, status: "online" },
      { label: "Beta", sourceId: "beta", pinned: false, status: "online" },
    ];
    const view = render(<App />);
    expect(screen.getByRole("main", { name: "Memory workspace" })).toHaveTextContent("alpha:live:online");

    storeMock.workspaceRoute = { kind: "memory", sourceId: "beta" };
    view.rerender(<App />);
    expect(screen.getByRole("main", { name: "Memory workspace" })).toHaveTextContent("beta:live:online");
    expect(screen.getByRole("main", { name: "Memory workspace" })).not.toHaveTextContent("alpha");

    storeMock.connection = "offline";
    view.rerender(<App />);
    expect(screen.getByRole("main", { name: "Memory workspace" })).toHaveTextContent("beta:offline:online");
    expect(screen.getByRole("main", { name: "Memory workspace" })).not.toHaveTextContent("beta:live");
  });

  it("uses a master fallback and reacts when the viewport enters the mobile breakpoint", async () => {
    let breakpointListener: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
        breakpointListener = listener;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(media));
    storeMock.conversationDetailOpen = true;
    const { rerender } = render(<App />);

    media.matches = true;
    breakpointListener?.({ matches: true } as MediaQueryListEvent);
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to conversations" })).toHaveFocus());

    storeMock.activeCardVisible = false;
    storeMock.conversationDetailOpen = false;
    rerender(<App />);
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  });
});

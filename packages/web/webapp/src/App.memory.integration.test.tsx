import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { agent, memoryAvailability } from "./test/fixtures";

const apiMock = vi.hoisted(() => ({
  memoryOverview: vi.fn(),
  memoryRecords: vi.fn(),
  memoryRecord: vi.fn(),
  memoryGraph: vi.fn(),
  memoryOperation: vi.fn(),
  editMemoryRecord: vi.fn(),
  forgetMemoryRecord: vi.fn(),
  restoreMemoryRecord: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

vi.mock("./components/AgentRail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/AgentRail")>();
  return {
    ...actual,
    BrandMark: () => <span>mono-agent</span>,
    AgentRail: () => <aside aria-label="Agents">Agents</aside>,
  };
});

vi.mock("./components/ConversationWorkspace", () => ({
  ConversationWorkspace: () => <section aria-label="Conversation workspace" />,
}));

vi.mock("./components/Chat", () => ({
  Chat: () => <main>Chat</main>,
}));

import { App } from "./App";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  const agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })];
  const selectAgent = vi.fn((sourceId: string) => {
    const selectedAgent = agents.find((candidate) => candidate.sourceId === sourceId)!;
    storeMock.current = {
      ...storeMock.current,
      workspaceRoute: { kind: "memory", sourceId },
      selectedAgentId: sourceId,
      selectedAgent,
    };
  });
  storeMock.current = {
    loading: false,
    bootstrap: { console: { hostName: "console-host", theme: "ocean" } },
    error: null,
    actionError: null,
    clearActionError: vi.fn(),
    conversationDetailOpen: false,
    openConversationIndex: vi.fn(),
    workspaceRoute: { kind: "memory", sourceId: "alpha" },
    openMemory: vi.fn(),
    agents,
    visibleAgents: agents,
    connection: "live",
    selectedAgentId: "alpha",
    selectedAgent: agents[0],
    selectedThread: null,
    showArchived: false,
    showOfflineAgents: false,
    hiddenOfflineAgentCount: 0,
    createThread: vi.fn(),
    renameThread: vi.fn(),
    setAgentPinned: vi.fn(async () => undefined),
    setShowArchived: vi.fn(),
    setShowOfflineAgents: vi.fn(),
    selectAgent,
  };
  apiMock.memoryOverview.mockResolvedValue(memoryAvailability());
  apiMock.memoryRecords.mockResolvedValue({ records: [] });
  apiMock.memoryGraph.mockResolvedValue({ fidelity: "captured", nodes: [], edges: [] });
});

describe("App memory focus handoff", () => {
  it("moves focus to the replacement picker opener after a real mobile source selection", async () => {
    render(<App />);
    await screen.findByRole("region", { name: "Memory counts" });
    const originalOpener = screen.getByRole("button", { name: "Choose memory agent" });
    originalOpener.focus();
    fireEvent.click(originalOpener);
    const dialog = screen.getByRole("dialog", { name: "Choose memory agent" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Beta, online" }));

    await waitFor(() => expect(
      (storeMock.current?.selectAgent as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(screen.getByText("Beta", { selector: ".memory-title > span:last-child" }))
      .toBeInTheDocument());
    const replacementOpener = screen.getByRole("button", { name: "Choose memory agent" });
    expect(replacementOpener).not.toBe(originalOpener);
    await waitFor(() => expect(replacementOpener).toHaveFocus());
  });
});

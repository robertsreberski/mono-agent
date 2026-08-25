import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../test/fixtures";

const collection = {
  id: "project",
  name: "Project",
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
};
const todo = thread("todo", "online", { title: "Todo item", workflowStatus: "todo" });
const running = thread("running", "offline", {
  title: "Active item",
  workflowStatus: "in_progress",
  runState: { status: "running" },
});
const done = thread("done", "pinned-offline", {
  title: "Done item",
  workflowStatus: "done",
  pinned: true,
  collectionId: collection.id,
  searchMatch: { messageId: "answer-1", snippet: "Matched answer text" },
});

const storeMock = vi.hoisted(() => ({
  agents: [] as ReturnType<typeof agent>[],
  threads: [] as ReturnType<typeof thread>[],
  collections: [] as typeof collection[],
  collectionsLoading: false,
  agentPreferences: { online: null, offline: null, "pinned-offline": null },
  selectedAgent: null as ReturnType<typeof agent> | null,
  selectedAgentId: "online",
  selectedThreadId: null,
  showOfflineAgents: false,
  hiddenOfflineAgentCount: 1,
  workspaceRevision: 1,
  setShowOfflineAgents: vi.fn(),
  queryWorkspaceThreads: vi.fn(),
  selectSearchMatch: vi.fn(),
  updateThreadWorkspace: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  createThread: vi.fn(),
  createCollection: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
  loadAgentPreferences: vi.fn(),
  setAgentRunPreference: vi.fn(),
}));

vi.mock("../console-store", async (loadOriginal) => ({
  ...await loadOriginal<typeof import("../console-store")>(),
  useConsoleStore: () => storeMock,
}));

import { ConversationWorkspace } from "./ConversationWorkspace";

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.agents = [
    agent("online", {
      label: "Online",
      modelOptions: { "provider/model": { reasoning: true, effortLevels: ["high"] } },
    }),
    agent("offline", { label: "Offline", status: "offline" }),
    agent("pinned-offline", { label: "Pinned offline", status: "offline", pinned: true }),
  ];
  storeMock.threads = [todo, running, done];
  storeMock.collections = [collection];
  storeMock.selectedAgent = storeMock.agents[0]!;
  storeMock.workspaceRevision = 1;
  storeMock.showOfflineAgents = false;
  storeMock.queryWorkspaceThreads.mockResolvedValue({ threads: [todo, running, done] });
  storeMock.createThread.mockResolvedValue(todo);
  storeMock.loadAgentPreferences.mockImplementation(async (sourceId: string) => ({
    sourceId,
    runPreference: null,
  }));
  storeMock.setAgentRunPreference.mockResolvedValue(undefined);
});

describe("ConversationWorkspace", () => {
  it("queries All without expanding agent ids while keeping ordinary offline agents hidden in the chooser", async () => {
    const { rerender } = render(<ConversationWorkspace />);

    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "interactive",
        archived: false,
      }),
    ));
    expect(storeMock.queryWorkspaceThreads.mock.calls[0]?.[0]).not.toHaveProperty("sourceIds");
    expect(screen.getByRole("complementary", { name: "Conversation collections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unfiled" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("All agents"));
    expect(screen.queryByText("Offline", { selector: ".agent-filter-row span" })).not.toBeInTheDocument();
    expect(screen.getByText("Pinned offline", { selector: ".agent-filter-row span" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 1 offline" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 offline" }));
    expect(storeMock.setShowOfflineAgents).toHaveBeenCalledWith(true);
    storeMock.showOfflineAgents = true;
    rerender(<ConversationWorkspace />);
    expect(screen.getByText("Offline", { selector: ".agent-filter-row span" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide offline agents" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("New"));
    const newMenu = screen.getByRole("menu", { name: "Choose agent for new conversation" });
    expect(within(newMenu).getByRole("menuitem", { name: "Offline" })).toBeDisabled();
    fireEvent.click(within(newMenu).getByRole("menuitem", { name: "Online" }));
    expect(storeMock.createThread).toHaveBeenCalledWith("online");
  });

  it("keeps an all-agent query bounded with more than sixty-four agents", async () => {
    storeMock.agents = Array.from({ length: 65 }, (_, index) => agent(`agent-${String(index)}`));
    storeMock.threads = [];
    storeMock.queryWorkspaceThreads.mockResolvedValue({ threads: [] });

    render(<ConversationWorkspace />);

    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledTimes(1));
    expect(storeMock.queryWorkspaceThreads.mock.calls[0]?.[0]).not.toHaveProperty("sourceIds");
  });

  it("sends an exact source-id subset when an agent filter is selected", async () => {
    render(<ConversationWorkspace />);
    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledTimes(1));
    storeMock.queryWorkspaceThreads.mockClear();

    fireEvent.click(screen.getByText("All agents"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Online/u }));

    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ["online"], type: "interactive" }),
    ));
  });

  it("uses valid group labels for ungrouped results and card actions", async () => {
    const { container } = render(<ConversationWorkspace />);
    await screen.findByRole("article", { name: "Todo item" });

    const resultGroup = container.querySelector(".workspace-list-group");
    expect(resultGroup).toHaveAttribute("role", "group");
    expect(resultGroup).not.toHaveAttribute("aria-labelledby");
    expect(within(screen.getByRole("article", { name: "Todo item" })).getByRole("group", {
      name: "Actions for Todo item",
    })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Group" }), {
      target: { value: "agent" },
    });
    await waitFor(() => expect(container.querySelector(
      '.workspace-list-group[aria-labelledby="group-online"]',
    )).toBeInTheDocument());
    expect(container.querySelector("#group-online")).toHaveTextContent("Online");
  });

  it("replaces stale results with a visible server-query error", async () => {
    storeMock.queryWorkspaceThreads.mockRejectedValue(new Error("Legacy agent query failed."));

    render(<ConversationWorkspace />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Legacy agent query failed.");
    expect(screen.queryByRole("article", { name: "Todo item" })).not.toBeInTheDocument();
  });

  it("offers fixed Kanban columns plus keyboard/touch status actions and locks an active run", async () => {
    render(<ConversationWorkspace />);
    await screen.findByText("Active item");
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));

    const tabs = screen.getByRole("tablist", { name: "Workflow status" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Todo1",
      "In progress1",
      "Done1",
    ]);
    const activeCard = screen.getByRole("article", { name: "Active item" });
    expect(activeCard).toHaveAttribute("draggable", "false");
    expect(within(activeCard).getByRole("combobox", { name: "Workflow status for Active item" })).toBeDisabled();
    const todoCard = screen.getByRole("article", { name: "Todo item" });
    expect(todoCard).toHaveAttribute("draggable", "true");
    expect(within(todoCard).getByRole("combobox", { name: "Workflow status for Todo item" })).toBeEnabled();
  });

  it("reruns the active server query after a bootstrap or live workspace revision", async () => {
    const { rerender } = render(<ConversationWorkspace />);
    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledTimes(1));

    storeMock.workspaceRevision = 2;
    rerender(<ConversationWorkspace />);

    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledTimes(2));
  });

  it("loads the next server page with the active filters and retains both pages", async () => {
    storeMock.queryWorkspaceThreads.mockImplementation(async (input: { readonly before?: string }) => input.before
      ? { threads: [done] }
      : { threads: [todo], nextCursor: "cursor/next" });
    render(<ConversationWorkspace />);
    await screen.findByRole("article", { name: "Todo item" });

    fireEvent.click(await screen.findByRole("button", { name: "Load more conversations" }));

    await waitFor(() => expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "interactive",
        archived: false,
        groupBy: "none",
        before: "cursor/next",
      }),
    ));
    expect(storeMock.queryWorkspaceThreads.mock.calls.at(-1)?.[0]).not.toHaveProperty("sourceIds");
    expect(await screen.findByRole("article", { name: "Done item" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Todo item" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more conversations" })).not.toBeInTheDocument();
  });

  it("moves and traps focus inside the mobile filter drawer, then restores its trigger", async () => {
    render(<ConversationWorkspace />);
    const open = screen.getByRole("button", { name: "Open filters" });
    fireEvent.click(open);
    const close = screen.getAllByRole("button", { name: "Close filters" })[0]!;
    await waitFor(() => expect(close).toHaveFocus());

    const archive = screen.getByRole("button", { name: /^Archive$/ });
    archive.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.click(close);
    expect(open).toHaveFocus();
  });

  it("keeps automations explicit and list-only, and opens a search hit at its exact message", async () => {
    render(<ConversationWorkspace />);
    await screen.findByText("Matched answer text");
    const searchResult = screen.getByRole("article", { name: "Done item" });
    fireEvent.click(within(searchResult).getAllByRole("button")[0]!);
    expect(storeMock.selectSearchMatch).toHaveBeenCalledWith("done", "answer-1");

    fireEvent.change(screen.getByRole("combobox", { name: "Group" }), {
      target: { value: "collection" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation type" }), {
      target: { value: "automation" },
    });
    await waitFor(() => {
      expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledWith(expect.objectContaining({ type: "cron", groupBy: "none" }));
      expect(storeMock.queryWorkspaceThreads).toHaveBeenCalledWith(expect.objectContaining({ type: "webhook", groupBy: "none" }));
    });
    expect(screen.getByRole("button", { name: "Kanban" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });

  it("removes a stale search snippet and anchor after the query is cleared", async () => {
    const { searchMatch: _searchMatch, ...plainDone } = done;
    storeMock.queryWorkspaceThreads.mockImplementation(async (input: { readonly q?: string }) => ({
      threads: input.q ? [done] : [plainDone],
    }));
    render(<ConversationWorkspace />);
    const search = screen.getByRole("searchbox", { name: "Search all messages" });
    await waitFor(() => expect(screen.queryByText("Matched answer text")).not.toBeInTheDocument());

    fireEvent.change(search, { target: { value: "answer" } });
    await screen.findByText("Matched answer text");
    fireEvent.change(search, { target: { value: "" } });

    await waitFor(() => expect(screen.queryByText("Matched answer text")).not.toBeInTheDocument());
    const result = screen.getByRole("article", { name: "Done item" });
    fireEvent.click(within(result).getAllByRole("button")[0]!);
    expect(storeMock.selectSearchMatch).toHaveBeenLastCalledWith("done", undefined);
  });

  it("exposes per-agent web defaults with independent Default resets", async () => {
    render(<ConversationWorkspace />);
    fireEvent.click(screen.getByText("All agents"));
    fireEvent.click(screen.getByRole("button", { name: "Preferences for Online" }));

    const dialog = screen.getByRole("dialog", { name: "Online" });
    const model = within(dialog).getByLabelText("Model");
    const effort = within(dialog).getByLabelText("Effort");
    expect(within(model).getByRole("option", { name: /Default/ })).toHaveValue("");
    expect(within(effort).getByRole("option", { name: /Default/ })).toHaveValue("");

    const save = within(dialog).getByRole("button", { name: "Save preference" });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Close agent preferences" })).toHaveFocus();

    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.change(model, { target: { value: "provider/model" } });
    fireEvent.click(save);
    await waitFor(() => expect(storeMock.setAgentRunPreference).toHaveBeenCalledWith(
      "online",
      { model: "provider/model", effort: "high" },
    ));
  });
});

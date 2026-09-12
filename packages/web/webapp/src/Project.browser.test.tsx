import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agent, project, thread, uploadLimits } from "./test/fixtures";
import type { TagSummary, ThreadSummary } from "./types";
import "./styles.css";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock.current,
  useUploadLimits: () => uploadLimits,
}));
vi.mock("./notifications", () => ({ NotificationBell: () => null }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      searchThreads: vi.fn().mockResolvedValue({ hits: [], truncated: false }),
    },
  };
});
vi.mock("./components/CronChannelHeader", () => ({
  CronChannelHeader: () => null,
}));
vi.mock("./components/assistant-ui/Quote", () => ({
  SelectionToolbar: () => null,
}));
vi.mock("./components/Composer", () => ({
  Composer: () => null,
}));
vi.mock("./components/Messages", () => ({
  AskReconciliationProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  AssistantMessage: () => <div data-testid="thread-message">Alpha transcript</div>,
  SystemMessage: () => <div data-testid="thread-message" />,
  UserMessage: () => <div data-testid="thread-message" />,
}));

import { Dashboard } from "./components/dashboard/Dashboard";
import { ProjectSettingsSheet } from "./components/project/ProjectSettingsSheet";
import { Chat } from "./components/Chat";
import { WebRuntimeProvider } from "./runtime";

/**
 * Screenshot evidence is opt-in: `VITE_PROJECT_SHOTS=<absolute dir>` captures
 * the eight project surfaces, and CI runs the same assertions without it.
 */
const shotDirectory = import.meta.env.VITE_PROJECT_SHOTS as string | undefined;

const capture = async (name: string): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.screenshot({ path: `${shotDirectory}/${name}.png` });
};

const webProject = project("project-web", "alpha", {
  name: "Web console",
  context: "Work in mono-agent/console. Verify from served bytes, never from source.",
  conversationCount: 2,
  runningCount: 1,
  monthUsd: 3.12,
});
const tag = (id: string, sourceId: string, patch: Partial<TagSummary>): TagSummary => ({
  id, sourceId, name: id, color: "default", createdAt: "2026-09-12T12:00:00Z", updatedAt: "2026-09-12T12:00:00Z", revision: 1, ...patch,
});
const first = thread("member-one", "alpha", { title: "Console conversation and cron-list polish", projectId: webProject.id });
const second = thread("member-two", "alpha", { title: "Dashboard drawer redesign plan", projectId: webProject.id });

const dashboardStore = (overrides: Record<string, unknown> = {}) => ({
  bootstrap: { console: { hostName: "fable", displayName: "fable", theme: "evergreen" as const } },
  connection: "live",
  agents: [agent("alpha", { label: "Alpha" })],
  visibleAgents: [agent("alpha", { label: "Alpha" })],
  hiddenOfflineAgentCount: 0,
  showOfflineAgents: false,
  cachedRunningThreads: [] as readonly ThreadSummary[],
  unreadThreadIds: new Set<string>(),
  unreadCountByAgent: new Map<string, number>(),
  activeThreads: null,
  navigationDestination: "chats" as const,
  cronOverview: null,
  setNavigationDestination: vi.fn(),
  selectedAgent: agent("alpha", { label: "Alpha" }),
  selectedAgentId: "alpha",
  selectedThreadId: first.id,
  selectedThread: null,
  detail: null,
  detailLoading: false,
  threads: [first, second],
  visibleThreads: [first, second],
  projectsByAgent: { alpha: [webProject] },
  openProjectId: null,
  openProject: null,
  openProjectById: vi.fn(),
  projectMembers: [first, second],
  projectMembersLoading: false,
  projectMembersError: null,
  hasMoreProjectMembers: false,
  loadMoreProjectMembers: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn(),
  createThread: vi.fn().mockResolvedValue(first),
  showArchived: false,
  selectionLoading: false,
  creatingThread: false,
  selectionError: null,
  threadListError: null,
  retryThreadList: vi.fn(),
  setShowArchived: vi.fn(),
  setShowOfflineAgents: vi.fn(),
  setAgentPinned: vi.fn().mockResolvedValue(undefined),
  selectAgent: vi.fn(),
  hasMoreThreads: false,
  loadMoreThreads: vi.fn().mockResolvedValue(undefined),
  selectThread: vi.fn(),
  ...overrides,
});

const chatStore = () => ({
  ...dashboardStore(),
  selectedThread: first,
  detail: {
    thread: first,
    messages: [{
      id: "message-one",
      threadId: first.id,
      role: "assistant",
      parts: [{ type: "text", text: "Alpha transcript" }],
      attachments: [],
      createdAt: "2026-09-08T08:00:00.000Z",
      updatedAt: "2026-09-08T08:00:00.000Z",
      status: "complete",
    }],
  },
  detailLoading: false,
  model: "",
  effort: "",
  modelOptions: [],
  effortOptions: [],
  skillRegistry: { status: "ready", items: [], total: 0 },
  renameThread: vi.fn(),
  archiveThread: vi.fn().mockResolvedValue(undefined),
  unarchiveThread: vi.fn().mockResolvedValue(undefined),
  deleteThread: vi.fn().mockResolvedValue(undefined),
  loadProjects: vi.fn().mockResolvedValue([webProject]),
  setThreadProject: vi.fn().mockResolvedValue(undefined),
  sendTurn: vi.fn(),
  sendSubmission: vi.fn().mockResolvedValue(undefined),
  sendLiveInput: vi.fn(),
  cancelTurn: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  retry: vi.fn(),
  clearActionError: vi.fn(),
  loadOlderMessages: vi.fn().mockResolvedValue(undefined),
  hasOlderMessages: false,
  loadFullToolCall: vi.fn().mockResolvedValue(false),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.style.margin = "0";
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe.each([
  { label: "desktop", width: 1_280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
])("projects at the $label viewport", ({ label, width, height }) => {
  it("shows three colored tags below the title and their membership menu", async () => {
    await page.viewport(width, height);
    const tags = [tag("planning", "alpha", { name: "planning", color: "blue" }), tag("implementing", "alpha", { name: "implementing", color: "amber" }), tag("reviewing", "alpha", { name: "reviewing", color: "green" })];
    storeMock.current = { ...chatStore(), selectedThread: { ...first, tagIds: tags.map((item) => item.id) }, tagsByAgent: { alpha: tags }, loadTags: vi.fn().mockResolvedValue(tags), setThreadTags: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<WebRuntimeProvider><Chat onBack={() => undefined} /></WebRuntimeProvider>);
    const line = screen.getByLabelText("Conversation tag line");
    const title = container.querySelector(".chat-title-row")!;
    const titleBounds = title.getBoundingClientRect();
    expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(titleBounds.bottom);
    expect(line.querySelectorAll(".tag-chip")).toHaveLength(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (label === "mobile") await capture("tags-header-phone");
    await userEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
    expect(await screen.findByRole("menuitem", { name: "New tag…" })).toBeVisible();
    for (const item of tags) expect(screen.getByRole("menuitem", { name: `Remove ${item.name}` })).toBeVisible();
    expect(title.getBoundingClientRect()).toEqual(titleBounds);
    if (label === "desktop") await capture("tags-header-menu-desktop");
  });

  it("shows dashboard tag chips with a bounded overflow count", async () => {
    await page.viewport(width, height);
    const tags = ["planning", "implementing", "reviewing", "ready to merge", "merged"].map((name, i) => tag(`tag-${String(i)}`, "alpha", { name, color: i % 2 === 0 ? "blue" : "green" }));
    const rows = [{ ...first, tagIds: tags.map((item) => item.id) }, { ...second, tagIds: [tags[0]!.id] }];
    storeMock.current = dashboardStore({ threads: rows, visibleThreads: rows, tagsByAgent: { alpha: tags } });
    render(<WebRuntimeProvider><Dashboard highlightSelected={false} /></WebRuntimeProvider>);
    expect(await screen.findByText("+2")).toBeVisible();
    expect(document.querySelectorAll(".thread-preview .tag-chip")).toHaveLength(4);
    if (label === "desktop") await capture("tags-dashboard-chips-desktop");
  });

  it("keeps ten long tags on a scrollable header line below the title", async () => {
    await page.viewport(width, height);
    const tags = Array.from({ length: 10 }, (_, i) => ({ id: `tag-${String(i)}`, sourceId: "alpha", name: `planning long status ${String(i)} ` + "x".repeat(60), color: "green", revision: 1 }));
    storeMock.current = { ...chatStore(), selectedThread: { ...first, tagIds: tags.map((tag) => tag.id) }, tagsByAgent: { alpha: tags }, loadTags: vi.fn().mockResolvedValue(tags), setThreadTags: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<WebRuntimeProvider><Chat onBack={() => undefined} /></WebRuntimeProvider>);
    const line = screen.getByLabelText("Conversation tag line");
    const title = container.querySelector(".chat-title-row")!;
    expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom);
    expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
    const chips = [...line.querySelectorAll(".tag-chip")];
    expect(chips).toHaveLength(10);
    expect(new Set(chips.map((chip) => chip.getBoundingClientRect().top)).size).toBe(1);
    line.scrollLeft = line.scrollWidth;
    expect(line.scrollLeft).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await userEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
    expect(await screen.findByRole("menuitem", { name: "New tag…" })).toBeVisible();
  });

  it("draws the Projects section on the Dashboard", async () => {
    await page.viewport(width, height);
    storeMock.current = dashboardStore();
    render(
      <WebRuntimeProvider>
        <Dashboard highlightSelected={false} />
      </WebRuntimeProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open project Web console" })).toBeVisible();
    await capture(`dashboard-projects-${label}`);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  it("names the project on a conversation's row and on its running card", async () => {
    await page.viewport(width, height);
    const running = { ...first, runState: { status: "running" as const } };
    const own = thread("own-one", "alpha", { title: "Agent conversation" });
    storeMock.current = dashboardStore({
      threads: [running, second, own],
      visibleThreads: [running, second, own],
      activeThreads: {
        threads: [running],
        total: 1,
        truncated: false,
        runningCounts: { alpha: 1 },
        authoritative: true,
      },
    });
    render(
      <WebRuntimeProvider>
        <Dashboard highlightSelected={false} />
      </WebRuntimeProvider>,
    );

    // The list carries every conversation; the ones in a project say so.
    const row = await screen.findByRole("button", {
      name: "Open Dashboard drawer redesign plan, in project Web console",
    });
    expect(row).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Agent conversation" })).toBeVisible();
    // And a running one wears the same label on its card.
    const card = screen.getByRole("button", {
      name: "Open Console conversation and cron-list polish on Alpha, in project Web console",
    });
    expect(card.querySelector(".project-badge")).toHaveTextContent("Web console");
    await capture(`labelled-project-chats-${label}`);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  it("draws the project page with its context card and members", async () => {
    await page.viewport(width, height);
    storeMock.current = dashboardStore({
      openProjectId: webProject.id,
      openProject: webProject,
    });
    render(
      <WebRuntimeProvider>
        <Dashboard highlightSelected={false} />
      </WebRuntimeProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Web console" })).toBeVisible();
    expect(screen.getByText("2 conversations · 1 running · $3.12 this month")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Console conversation and cron-list polish" })).toBeVisible();
    await capture(`project-page-${label}`);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  it("draws the project settings sheet", async () => {
    await page.viewport(width, height);
    storeMock.current = dashboardStore({
      createProject: vi.fn(),
      patchProject: vi.fn(),
      archiveProject: vi.fn(),
      deleteProject: vi.fn(),
    });
    render(
      <WebRuntimeProvider>
        <div>
          <Dashboard highlightSelected={false} />
          <ProjectSettingsSheet
            sheet={{ mode: "edit", projectId: webProject.id }}
            onClose={() => undefined}
            dialogRef={{ current: null }}
          />
        </div>
      </WebRuntimeProvider>,
    );

    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("Project name")).toHaveValue("Web console");
    await capture(`project-settings-${label}`);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  it("offers the project picker in the conversation actions", async () => {
    await page.viewport(width, height);
    storeMock.current = chatStore();
    render(
      <WebRuntimeProvider>
        <Chat onBack={() => undefined} />
      </WebRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByText("Alpha transcript")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to project Web console" }));
    expect(screen.getByRole("menuitem", { name: "New project from this chat" })).toBeVisible();
    expect(await screen.findByRole("menuitem", { name: "Web console" })).toBeInTheDocument();
    await capture(`project-picker-${label}`);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
});

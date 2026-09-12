import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agent, project, thread, uploadLimits } from "./test/fixtures";
import type { ThreadSummary } from "./types";
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

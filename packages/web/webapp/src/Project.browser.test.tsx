import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
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

beforeEach(async () => {
  await commands.emulateColorScheme("dark");
  vi.clearAllMocks();
  localStorage.clear();
  document.body.style.margin = "0";
});

afterEach(async () => {
  await commands.emulateColorScheme(null);
  cleanup();
  localStorage.clear();
});

describe.each([
  { label: "desktop", width: 1_280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
])("projects at the $label viewport", ({ label, width, height }) => {
  it("shows three rounded colored tags beside the project label and their membership menu", async () => {
    await page.viewport(width, height);
    const tags = [tag("planning", "alpha", { name: "planning", color: "blue" }), tag("implementing", "alpha", { name: "implementing", color: "amber" }), tag("reviewing", "alpha", { name: "reviewing", color: "green" })];
    storeMock.current = { ...chatStore(), selectedThread: { ...first, tagIds: tags.map((item) => item.id) }, tagsByAgent: { alpha: tags }, loadTags: vi.fn().mockResolvedValue(tags), setThreadTags: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<WebRuntimeProvider><Chat onBack={() => undefined} /></WebRuntimeProvider>);
    const line = screen.getByLabelText("Conversation tag line");
    const title = container.querySelector(".chat-title-row")!;
    const titleBounds = title.getBoundingClientRect();
    const metadata = container.querySelector(".chat-metadata-row")!;
    expect(metadata).toContainElement(line);
    expect(metadata).toContainElement(screen.getByRole("button", { name: "Open project Web console" }));
    expect(title).not.toContainElement(line);
    expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual(titleBounds.top);
    const chipStyle = getComputedStyle(line.querySelector(".tag-chip")!);
    expect(chipStyle.borderRadius).toBe("999px");
    expect(chipStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(line.querySelectorAll(".tag-chip")).toHaveLength(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await capture(`tags-header-${label}`);
    await userEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
    expect(await screen.findByRole("menuitem", { name: "New tag…" })).toBeVisible();
    for (const item of tags) expect(screen.getByRole("menuitem", { name: `Remove ${item.name}` })).toBeVisible();
    expect(title.getBoundingClientRect()).toEqual(titleBounds);
    await capture(`tags-header-menu-${label}`);
  });

  it("keeps tags above the title without a dangling separator when there is no project", async () => {
    await page.viewport(width, height);
    const tags = [tag("planning", "alpha", { name: "planning", color: "blue" })];
    storeMock.current = { ...chatStore(), selectedThread: { ...first, projectId: undefined, tagIds: [tags[0]!.id] }, tagsByAgent: { alpha: tags }, loadTags: vi.fn().mockResolvedValue(tags), setThreadTags: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<WebRuntimeProvider><Chat onBack={() => undefined} /></WebRuntimeProvider>);
    const line = screen.getByLabelText("Conversation tag line");
    expect(container.querySelector(".chat-project-identity")).toBeNull();
    expect(line.querySelector(".tag-separator")).not.toBeVisible();
    expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual(container.querySelector(".chat-title-row")!.getBoundingClientRect().top);
    expect(screen.getByRole("button", { name: "Conversation tags" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  it("shows dashboard tag chips with a bounded overflow count", async () => {
    await page.viewport(width, height);
    const tags = ["planning", "implementing", "reviewing", "ready to merge", "merged"].map((name, i) => tag(`tag-${String(i)}`, "alpha", { name, color: i % 2 === 0 ? "blue" : "green" }));
    const rows = [{ ...first, runState: { status: "complete" as const }, lastMessagePreview: "A settled reply beside the chips", tagIds: tags.map((item) => item.id) }, { ...second, tagIds: [tags[0]!.id] }];
    storeMock.current = dashboardStore({ threads: rows, visibleThreads: rows, tagsByAgent: { alpha: tags } });
    render(<WebRuntimeProvider><Dashboard highlightSelected={false} /></WebRuntimeProvider>);
    expect(await screen.findByText("+2")).toBeVisible();
    expect(document.querySelectorAll(".thread-tags .tag-chip")).toHaveLength(4);
    for (const line of document.querySelectorAll(".thread-tags")) {
      const preview = line.parentElement!;
      expect(preview).toHaveClass("thread-preview");
      expect(line.getBoundingClientRect().top).toBeLessThan(preview.getBoundingClientRect().bottom);
    }
    expect(document.querySelectorAll(".thread-preview .tag-chip")).toHaveLength(4);
    expect(screen.queryByText("Completed")).toBeNull();
    // The settled slot carries the newest reply; the chips keep their own line space beside it.
    expect(screen.getByText("A settled reply beside the chips")).toBeVisible();
    expect(getComputedStyle(document.querySelector(".dashboard-footer")!).borderTopWidth).toBe("0px");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await capture(`tags-dashboard-chips-${label}`);
  });

  it("keeps ten long tags scrollable beside the project label with their menu visible", async () => {
    await page.viewport(width, height);
    const tags = Array.from({ length: 10 }, (_, i) => ({ id: `tag-${String(i)}`, sourceId: "alpha", name: `planning long status ${String(i)} ` + "x".repeat(60), color: "green", revision: 1 }));
    storeMock.current = { ...chatStore(), selectedThread: { ...first, tagIds: tags.map((tag) => tag.id) }, tagsByAgent: { alpha: tags }, loadTags: vi.fn().mockResolvedValue(tags), setThreadTags: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<WebRuntimeProvider><Chat onBack={() => undefined} /></WebRuntimeProvider>);
    const line = screen.getByLabelText("Conversation tag line");
    const title = container.querySelector(".chat-title-row")!;
    const metadata = container.querySelector(".chat-metadata-row")!;
    expect(metadata).toContainElement(line);
    expect(metadata).toContainElement(screen.getByRole("button", { name: "Open project Web console" }));
    expect(title).not.toContainElement(line);
    const scroller = line.querySelector<HTMLElement>(".conversation-tag-chips")!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    const chips = [...line.querySelectorAll(".tag-chip")];
    expect(chips).toHaveLength(10);
    expect(new Set(chips.map((chip) => chip.getBoundingClientRect().top)).size).toBe(1);
    scroller.scrollLeft = scroller.scrollWidth;
    expect(scroller.scrollLeft).toBeGreaterThan(0);
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

describe("conversation rows with reply excerpts", () => {
  it("gives a long excerpt only the space the badge and chips leave behind", async () => {
    // A long settled reply with ragged whitespace: the row collapses it to
    // one line and ellipsizes it, instead of squeezing its neighbours.
    const longExcerpt = `Rebuilt the checkout queue\n  so deploys drain in order,\n  retries logged  ${"x".repeat(90)}`;
    const collapsed = `Rebuilt the checkout queue so deploys drain in order, retries logged ${"x".repeat(90)}`;
    const tags = [
      tag("planning", "alpha", { name: "planning", color: "blue" }),
      tag("review", "alpha", { name: "review", color: "green" }),
    ];
    const withExcerpt = { ...first, title: "Queue rebuild", runState: { status: "complete" as const },
      lastMessagePreview: longExcerpt, tagIds: tags.map((item) => item.id) };
    const tagsOnly = { ...second, title: "Tag gardening", projectId: null,
      runState: { status: "complete" as const }, tagIds: [tags[0]!.id] };
    const bare = thread("bare-row", "alpha", { title: "Bare row", projectId: null,
      runState: { status: "complete" as const } });
    const rows = [withExcerpt, tagsOnly, bare];
    storeMock.current = dashboardStore({ threads: rows, visibleThreads: rows,
      tagsByAgent: { alpha: tags } });
    render(
      <WebRuntimeProvider>
        <Dashboard highlightSelected={false} />
      </WebRuntimeProvider>,
    );

    const row = await screen.findByRole("button", { name: "Open Queue rebuild, in project Web console" });
    const preview = row.querySelector(".thread-preview-text")!;
    expect(preview.textContent).toBe(collapsed);
    expect(preview).toHaveAttribute("title", collapsed);
    const previewStyle = getComputedStyle(preview);
    expect(previewStyle.textOverflow).toBe("ellipsis");
    expect(previewStyle.overflow).toBe("hidden");
    expect(previewStyle.whiteSpace).toBe("nowrap");
    expect(previewStyle.flexGrow).toBe("1");
    // Badge and chips keep their intrinsic width beside the excerpt.
    const badge = row.querySelector(".project-badge")!;
    expect(getComputedStyle(badge).flexShrink).toBe("0");
    expect(getComputedStyle(row.querySelector(".thread-tags")!).flexShrink).toBe("0");
    expect(row.querySelector(".thread-tags .tag-separator")).not.toBeNull();

    // Tags alone read without a dangling separator; neither needs no tags line.
    const tagsRow = await screen.findByRole("button", { name: "Open Tag gardening" });
    expect(tagsRow.querySelector(".thread-preview-text")?.textContent).toBe("");
    expect(tagsRow.querySelector(".thread-tags")).not.toBeNull();
    expect(tagsRow.querySelector(".thread-tags .tag-separator")).toBeNull();
    const bareRow = await screen.findByRole("button", { name: "Open Bare row" });
    expect(bareRow.querySelector(".thread-tags")).toBeNull();

    for (const [label, width, height] of [["mobile", 390, 844], ["desktop", 1440, 900]] as const) {
      await page.viewport(width, height);
      // The excerpt truncates instead of pushing its neighbours out of the row.
      const line = row.querySelector(".thread-preview")!;
      const lineBox = line.getBoundingClientRect();
      if (label === "mobile") {
        // A phone leaves no room for the whole reply: it ellipsizes.
        expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
      } else {
        // A desktop fits a server-capped reply in full; nothing is cut.
        expect(preview.scrollWidth).toBeLessThanOrEqual(preview.clientWidth);
        expect(preview.clientWidth).toBeGreaterThan(0);
      }
      for (const element of [badge, ...row.querySelectorAll(".thread-tags .tag-chip")]) {
        const box = element.getBoundingClientRect();
        expect(box.width).toBeGreaterThan(0);
        expect(box.right).toBeLessThanOrEqual(lineBox.right + 1);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await capture(`conversation-row-excerpt-${label}`);
    }
  });
});

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, project, thread } from "../../test/fixtures";
import type { ThreadSummary } from "../../types";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("../dashboard/DashboardFooter", () => ({
  DashboardFooter: () => null,
}));
vi.mock("@assistant-ui/react", () => ({
  ThreadListPrimitive: {
    Root: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
    Items: ({ children }: {
      children: (input: { threadListItem: { id: string } }) => ReactNode;
    }) => <>{(storeMock.current?.projectMembers as ThreadSummary[] ?? [])
      .map((item) => <Fragment key={item.id}>{children({ threadListItem: { id: item.id } })}</Fragment>)}</>,
  },
  ThreadListItemPrimitive: {
    Root: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
    Trigger: ({ children, ...rest }: Record<string, unknown>) => <button type="button" {...rest}>{children as never}</button>,
    Title: () => null,
    Archive: () => null,
    Unarchive: () => null,
  },
  useAuiState: () => false,
}));

import { ProjectPage } from "./ProjectPage";

const web = project("web", "alpha", {
  name: "Web console",
  context: "Stay sharp.",
  conversationCount: 2,
  runningCount: 1,
  monthUsd: 3.12,
});
const first = thread("first", "alpha", { title: "First", projectId: "web" });
const second = thread("second", "alpha", { title: "Second", projectId: "web" });

const createStore = (overrides: Record<string, unknown> = {}) => ({
  agents: [agent("alpha", { label: "Alpha" })],
  closeProject: vi.fn(),
  createThread: vi.fn().mockResolvedValue(first),
  creatingThread: false,
  hasMoreProjectMembers: false,
  loadMoreProjectMembers: vi.fn().mockResolvedValue(undefined),
  openProjectById: vi.fn(),
  projectMembers: [first, second],
  projectMembersError: null,
  projectMembersLoading: false,
  selectionError: null,
  selectionLoading: false,
  unreadThreadIds: new Set<string>(),
  ...overrides,
});

const store = () => storeMock.current as ReturnType<typeof createStore>;

beforeEach(() => {
  storeMock.current = createStore();
});

describe("ProjectPage", () => {
  it("draws the header, meta line and context card", () => {
    render(<ProjectPage project={web} />);

    expect(screen.getByRole("button", { name: "Back to Alpha conversations" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Web console" })).toBeVisible();
    expect(screen.getByText("2 conversations · 1 running · $3.12 this month")).toBeVisible();
    expect(screen.getByText("Stay sharp.")).toBeVisible();
    expect(screen.getByText("Prepended to every conversation in this project")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open First" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Second" })).toBeVisible();
  });

  it("omits the cost segment without a priced observation", () => {
    render(<ProjectPage project={{ ...web, monthUsd: undefined }} />);
    expect(screen.getByText("2 conversations · 1 running")).toBeVisible();
  });

  it("names an empty context instead of claiming one", () => {
    render(<ProjectPage project={{ ...web, context: "  " }} />);
    expect(screen.getByText("No context yet.")).toBeVisible();
  });

  it("walks back to the agent conversations", () => {
    render(<ProjectPage project={web} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Alpha conversations" }));
    expect(store().closeProject).toHaveBeenCalled();
  });

  it("opens the settings sheet in edit mode", () => {
    const seen: Event[] = [];
    const listener = (event: Event): void => { seen.push(event); };
    window.addEventListener("mono-agent:project-settings", listener);
    try {
      render(<ProjectPage project={web} />);
      fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      expect(seen.map((event) => (event as CustomEvent).detail)).toEqual([
        { mode: "edit", projectId: "web" },
        { mode: "edit", projectId: "web" },
      ]);
    } finally {
      window.removeEventListener("mono-agent:project-settings", listener);
    }
  });

  it("creates a member conversation and navigates to it", async () => {
    const onNavigate = vi.fn();
    render(<ProjectPage project={web} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(store().createThread).toHaveBeenCalledWith("web");
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
  });

  it("pages older members and retries a failed page", () => {
    storeMock.current = createStore({ hasMoreProjectMembers: true });
    render(<ProjectPage project={web} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older conversations" }));
    expect(store().loadMoreProjectMembers).toHaveBeenCalled();

    storeMock.current = createStore({ projectMembers: [], projectMembersError: "offline" });
    render(<ProjectPage project={web} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
    expect(store().openProjectById).toHaveBeenCalledWith("web");
  });

  it("says loading and empty instead of claiming either", () => {
    storeMock.current = createStore({ projectMembers: [], projectMembersLoading: true });
    render(<ProjectPage project={web} />);
    expect(screen.getByText("Loading conversations…")).toBeVisible();

    storeMock.current = createStore({ projectMembers: [] });
    render(<ProjectPage project={web} />);
    expect(screen.getByText("No conversations yet")).toBeVisible();
  });
});

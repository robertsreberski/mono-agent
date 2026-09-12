import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { project } from "../../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { ProjectsSection } from "./ProjectsSection";

beforeEach(() => {
  storeMock.current = {
    projectsByAgent: {},
    selectedAgentId: "agent-one",
    openProjectById: vi.fn(),
  };
});

describe("ProjectsSection", () => {
  it("keeps only the label row and New when the agent has no active projects", () => {
    storeMock.current = {
      ...storeMock.current,
      projectsByAgent: {
        "agent-one": [project("old", "agent-one", { archivedAt: "2026-09-01T00:00:00.000Z" })],
      },
    };
    render(<ProjectsSection />);

    expect(screen.getByRole("heading", { name: "Projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open project/u })).toBeNull();
  });

  it("lists active projects with their conversation counts", () => {
    storeMock.current = {
      ...storeMock.current,
      projectsByAgent: {
        "agent-one": [
          project("web", "agent-one", { name: "Web console", conversationCount: 6, runningCount: 1 }),
          project("solo", "agent-one", { name: "Solo", conversationCount: 1 }),
        ],
      },
    };
    render(<ProjectsSection />);

    const web = screen.getByRole("button", { name: "Open project Web console" });
    expect(web).toHaveTextContent("6 chats · updated");
    expect(web).toHaveTextContent("1 running");
    expect(screen.getByRole("button", { name: "Open project Solo" })).toHaveTextContent("1 chat · updated");
  });

  it("opens the project page from a row", () => {
    storeMock.current = {
      ...storeMock.current,
      projectsByAgent: {
        "agent-one": [project("web", "agent-one", { name: "Web console" })],
      },
    };
    render(<ProjectsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Open project Web console" }));
    expect(storeMock.current?.openProjectById).toHaveBeenCalledWith("web");
  });

  it("asks for the settings sheet in create mode from New", () => {
    const seen: Event[] = [];
    const listener = (event: Event): void => { seen.push(event); };
    window.addEventListener("mono-agent:project-settings", listener);
    try {
      render(<ProjectsSection />);
      fireEvent.click(screen.getByRole("button", { name: "New" }));
      expect(seen).toHaveLength(1);
      expect((seen[0] as CustomEvent).detail).toEqual({ mode: "create" });
    } finally {
      window.removeEventListener("mono-agent:project-settings", listener);
    }
  });
});

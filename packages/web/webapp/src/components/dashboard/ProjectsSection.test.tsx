import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_COLLAPSED_STORAGE_KEY } from "../../projects-collapsed";
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
  // Each test starts without a stored choice, so the default expanded state
  // is what renders unless the test stores a value first.
  window.localStorage.removeItem(PROJECTS_COLLAPSED_STORAGE_KEY);
  vi.restoreAllMocks();
});

const twoProjects = () => {
  storeMock.current = {
    ...storeMock.current,
    projectsByAgent: {
      "agent-one": [
        project("web", "agent-one", { name: "Web console", conversationCount: 6, runningCount: 1 }),
        project("solo", "agent-one", { name: "Solo", conversationCount: 1 }),
      ],
    },
  };
};

const toggle = (): HTMLElement => screen.getByRole("button", { name: /^Projects/u });

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
    twoProjects();
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

  it("collapses the rows from the label toggle and expands them again", () => {
    twoProjects();
    render(<ProjectsSection />);

    const control = toggle();
    // The toggle owns the list it shows and hides, and starts expanded, which
    // is the default for a browser that has never chosen.
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(control).toHaveAttribute("aria-controls", "dashboard-projects-list");
    expect(document.getElementById("dashboard-projects-list")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open project Web console" })).toBeVisible();

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Open project/u })).toBeNull();

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Open project Web console" })).toBeVisible();
  });

  it("reports the hidden active project count while collapsed", () => {
    twoProjects();
    render(<ProjectsSection />);

    fireEvent.click(toggle());
    // The collapsed head keeps the count in the existing count style, so the
    // operator can see how many rows the toggle is hiding.
    const count = document.querySelector(".dashboard-section-count");
    expect(count).not.toBeNull();
    expect(count).toHaveTextContent("2");
    expect(screen.getByRole("heading", { name: /Projects/u })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "New" })).toBeVisible();
  });

  it("writes the collapsed choice to storage", () => {
    twoProjects();
    render(<ProjectsSection />);

    fireEvent.click(toggle());
    expect(window.localStorage.getItem(PROJECTS_COLLAPSED_STORAGE_KEY)).toBe("true");

    fireEvent.click(toggle());
    expect(window.localStorage.getItem(PROJECTS_COLLAPSED_STORAGE_KEY)).toBe("false");
  });

  it("honors a stored collapsed value on first render", () => {
    twoProjects();
    window.localStorage.setItem(PROJECTS_COLLAPSED_STORAGE_KEY, "true");
    render(<ProjectsSection />);

    // The initial state comes from storage rather than an effect, so the rows
    // never flash open on a reload that chose collapsed.
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Open project/u })).toBeNull();
    expect(document.querySelector(".dashboard-section-count")).toHaveTextContent("2");
  });

  it("keeps New working while collapsed without toggling the section", () => {
    twoProjects();
    const seen: Event[] = [];
    const listener = (event: Event): void => { seen.push(event); };
    window.addEventListener("mono-agent:project-settings", listener);
    try {
      render(<ProjectsSection />);
      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(screen.getByRole("button", { name: "New" }));
      expect(seen).toHaveLength(1);
      expect((seen[0] as CustomEvent).detail).toEqual({ mode: "create" });
      // New lives beside the toggle, not inside it, so creating a project
      // never expands or collapses the listing as a side effect.
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: /Open project/u })).toBeNull();
    } finally {
      window.removeEventListener("mono-agent:project-settings", listener);
    }
  });

  it("stays expanded and still toggles when storage throws", () => {
    twoProjects();
    // Safari private browsing and locked-down profiles throw on access, so a
    // storage failure must read as the expanded default and never break the
    // toggle for this tab.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable.");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable.");
    });
    render(<ProjectsSection />);

    const control = toggle();
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Open project Web console" })).toBeVisible();

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Open project/u })).toBeNull();

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Open project Web console" })).toBeVisible();
  });
});

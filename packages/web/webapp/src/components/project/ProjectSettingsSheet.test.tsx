import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, project } from "../../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { ProjectSettingsSheet } from "./ProjectSettingsSheet";

const web = project("web", "alpha", { name: "Web console", context: "Stay sharp." });

const createStore = (overrides: Record<string, unknown> = {}) => ({
  agents: [agent("alpha", { label: "Alpha" })],
  selectedAgent: agent("alpha", { label: "Alpha" }),
  projectsByAgent: { alpha: [web] },
  createProject: vi.fn().mockResolvedValue(web),
  patchProject: vi.fn().mockResolvedValue(web),
  archiveProject: vi.fn().mockResolvedValue(undefined),
  deleteProject: vi.fn().mockResolvedValue(undefined),
  openProjectById: vi.fn(),
  ...overrides,
});

const store = () => storeMock.current as ReturnType<typeof createStore>;
const dialogRef = { current: null };

beforeEach(() => {
  storeMock.current = createStore();
});

describe("ProjectSettingsSheet", () => {
  it("renders nothing without a sheet", () => {
    render(<ProjectSettingsSheet sheet={null} onClose={() => undefined} dialogRef={dialogRef} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a project, opens it and closes", async () => {
    const onClose = vi.fn();
    render(<ProjectSettingsSheet sheet={{ mode: "create" }} onClose={onClose} dialogRef={dialogRef} />);

    expect(screen.getByRole("heading", { name: "New project" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  Web console  " } });
    fireEvent.change(screen.getByLabelText("Project context"), { target: { value: "Stay sharp." } });
    expect(screen.getByText("11 chars")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(store().createProject).toHaveBeenCalledWith("Web console", "Stay sharp.", undefined));
    expect(store().openProjectById).toHaveBeenCalledWith("web");
    expect(onClose).toHaveBeenCalled();
  });

  it("cancels without saving", () => {
    const onClose = vi.fn();
    render(<ProjectSettingsSheet sheet={{ mode: "create" }} onClose={onClose} dialogRef={dialogRef} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Abandoned" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store().createProject).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("edits only the fields that changed", async () => {
    const onClose = vi.fn();
    render(
      <ProjectSettingsSheet sheet={{ mode: "edit", projectId: "web" }} onClose={onClose} dialogRef={dialogRef} />,
    );

    expect(screen.getByRole("heading", { name: "Project settings" })).toBeVisible();
    expect(screen.getByLabelText("Project name")).toHaveValue("Web console");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Locale-independent `d MMM`, stable across machines and screenshots.
    expect(screen.getByText("Created 17 Jul · Alpha")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Project context"), { target: { value: "Stay sharper." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(store().patchProject).toHaveBeenCalledWith("web", { context: "Stay sharper." }));
    expect(onClose).toHaveBeenCalled();
  });

  it("archives and deletes behind confirms", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onClose = vi.fn();
    render(
      <ProjectSettingsSheet sheet={{ mode: "edit", projectId: "web" }} onClose={onClose} dialogRef={dialogRef} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Archive project/u }));
    expect(confirm).toHaveBeenCalled();
    expect(store().archiveProject).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Archive project/u }));
    await waitFor(() => expect(store().archiveProject).toHaveBeenCalledWith("web"));
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Delete project/u }));
    await waitFor(() => expect(store().deleteProject).toHaveBeenCalledWith("web"));
    confirm.mockRestore();
  });

  it("says the project is gone when its summary left", () => {
    storeMock.current = createStore({ projectsByAgent: { alpha: [] } });
    render(
      <ProjectSettingsSheet sheet={{ mode: "edit", projectId: "web" }} onClose={() => undefined} dialogRef={dialogRef} />,
    );
    expect(screen.getByText("This project is no longer available.")).toBeVisible();
  });
});

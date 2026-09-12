import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { thread } from "../../test/fixtures";
import type { TagSummary } from "../../types";
const mock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../console-store", () => ({ useConsoleStore: () => mock.current }));
import { TagSettingsSheet } from "./TagSettingsSheet";
const tag: TagSummary = { id: "tag", sourceId: "alpha", name: "planning", color: "green", createdAt: "2026-09-12", updatedAt: "2026-09-12", revision: 1 };
const dialogRef = { current: null };
beforeEach(() => { mock.current = { tagsByAgent: { alpha: [tag] }, selectedThread: thread("chat", "alpha", { tagIds: ["other"] }), threads: [], createTag: vi.fn().mockResolvedValue(tag), patchTag: vi.fn().mockResolvedValue(tag), deleteTag: vi.fn().mockResolvedValue(undefined), setThreadTags: vi.fn().mockResolvedValue(undefined) }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("creates and assigns a tag with the eight-color palette, preserving existing tags", async () => {
  const close = vi.fn();
  render(<TagSettingsSheet sheet={{ mode: "create", sourceId: "alpha", threadId: "chat" }} onClose={close} dialogRef={dialogRef} />);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getAllByRole("radio")).toHaveLength(8);
  fireEvent.change(screen.getByLabelText("Tag name"), { target: { value: " planning " } });
  fireEvent.click(screen.getByRole("radio", { name: "green tag color" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(mock.current.createTag).toHaveBeenCalledWith("planning", "alpha", "green");
  expect(mock.current.setThreadTags).toHaveBeenCalledWith("chat", ["other", "tag"]);
});

it("keeps a failed assignment visible and retries without creating a second tag", async () => {
  const assign = vi.fn().mockRejectedValueOnce(new Error("A conversation can have at most 10 tags.")).mockResolvedValue(undefined);
  mock.current.setThreadTags = assign;
  const close = vi.fn();
  render(<TagSettingsSheet sheet={{ mode: "create", sourceId: "alpha", threadId: "chat" }} onClose={close} dialogRef={dialogRef} />);
  fireEvent.change(screen.getByLabelText("Tag name"), { target: { value: "planning" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("at most 10 tags");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(mock.current.createTag).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledTimes(2);
});

it("edits name/color and deletes with confirmation, retaining drafts across events", async () => {
  const close = vi.fn();
  const props = { sheet: { mode: "edit" as const, tagId: "tag" }, onClose: close, dialogRef };
  const { rerender } = render(<TagSettingsSheet {...props} />);
  fireEvent.change(screen.getByLabelText("Tag name"), { target: { value: "reviewing" } });
  mock.current.tagsByAgent = { alpha: [{ ...tag, name: "remote", revision: 2 }] }; rerender(<TagSettingsSheet {...props} />);
  expect(screen.getByLabelText("Tag name")).toHaveValue("reviewing");
  fireEvent.click(screen.getByRole("radio", { name: "red tag color" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mock.current.patchTag).toHaveBeenCalledWith("tag", { name: "reviewing", color: "red" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Delete tag/u })).not.toBeDisabled());
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: /Delete tag/u }));
  await waitFor(() => expect(mock.current.deleteTag).toHaveBeenCalledWith("tag"));
});

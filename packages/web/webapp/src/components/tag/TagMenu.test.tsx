import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { thread } from "../../test/fixtures";
import type { TagSummary } from "../../types";

const mock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../console-store", () => ({ useConsoleStore: () => mock.current }));
import { TagMenu } from "./TagMenu";
import { ConversationTags } from "./ConversationTags";

const tag: TagSummary = { id: "planning", sourceId: "alpha", name: "planning", color: "green", createdAt: "2026-09-12", updatedAt: "2026-09-12", revision: 1 };
beforeEach(() => { mock.current = { tagsByAgent: { alpha: [tag] }, loadTags: vi.fn().mockResolvedValue([tag]), setThreadTags: vi.fn().mockResolvedValue(undefined) }; });
afterEach(cleanup);

it("loads the agent tags and toggles membership using the existing closing menu item", async () => {
  const target = thread("chat", "alpha", { tagIds: [tag.id] });
  render(<TagMenu thread={target} />);
  fireEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
  const remove = await screen.findByRole("menuitem", { name: "Remove planning" });
  expect(mock.current.loadTags).toHaveBeenCalledWith("alpha");
  fireEvent.click(remove);
  expect(mock.current.setThreadTags).toHaveBeenCalledWith("chat", []);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("adds a tag without dropping existing ids and opens create/edit settings", async () => {
  render(<TagMenu thread={thread("chat", "alpha", { tagIds: ["other"] })} />);
  fireEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Add planning" }));
  expect(mock.current.setThreadTags).toHaveBeenCalledWith("chat", ["other", "planning"]);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const received: unknown[] = [];
  const handler = (event: Event) => { received.push((event as CustomEvent<unknown>).detail); };
  window.addEventListener("mono-agent:tag-settings", handler);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New tag…" }));
    expect(received).toEqual([{ mode: "create", sourceId: "alpha", threadId: "chat" }]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Conversation tags" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit tags/u }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "planning" }));
    expect(received.at(-1)).toEqual({ mode: "edit", tagId: "planning" });
  } finally { window.removeEventListener("mono-agent:tag-settings", handler); }
});

it("renders resolved header chips on their own line and ignores unknown ids", () => {
  mock.current.selectedThread = thread("chat", "alpha", { tagIds: ["missing", "planning"] });
  const { rerender } = render(<ConversationTags />);
  expect(screen.getByLabelText("Conversation tag line")).toContainElement(screen.getByText("planning"));
  expect(screen.queryByText("missing")).toBeNull();
  mock.current.selectedThread = thread("chat", "alpha"); rerender(<ConversationTags />);
  expect(screen.getByText("Add tag")).toBeVisible();
  expect(screen.queryByText("planning")).toBeNull();
});

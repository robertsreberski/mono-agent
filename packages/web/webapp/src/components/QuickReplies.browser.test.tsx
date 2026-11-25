import { useState } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { render, screen, waitFor } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, expect, it, vi } from "vitest";
import { resetComposerDraft } from "../composer-draft";
import { convertWebMessage } from "../runtime";
import { uploadLimits } from "../test/fixtures";
import type { WebMessage } from "../types";
import { Composer } from "./Composer";
import { AssistantMessage, UserMessage } from "./Messages";
import "../styles.css";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    tapReplyOption(label: string): Promise<void>;
  }
}

vi.mock("../console-store", () => ({
  useUploadLimits: () => uploadLimits,
  useConsoleStore: () => ({
    connection: "live",
    selectedAgent: null,
    selectedAgentId: "fixture-agent",
    selectedThread: null,
    selectedThreadId: "thread",
    selectionError: null,
    skillRegistry: { status: "idle", items: [] },
    modelOptions: [],
    effortOptions: [],
  }),
}));

afterEach(resetComposerDraft);

const answerText = "The project draft is ready. What would you like to do next?";
const answer: WebMessage = {
  id: "quick-answer", threadId: "thread", role: "assistant", status: "complete",
  createdAt: "2026-09-23T10:00:00.000Z", updatedAt: "2026-09-23T10:00:01.000Z", attachments: [],
  parts: [{ type: "text", text: answerText },
    { type: "reply_options", id: "quick-choices", options: ["Review draft", "Keep going", "Try another approach", "Summarize changes"] }],
};

function QuickRepliesHarness({ onSend }: { readonly onSend: (text: string) => void }) {
  const [messages, setMessages] = useState<readonly WebMessage[]>([answer]);
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages,
    convertMessage: (message) => convertWebMessage(message),
    onNew: async (message) => {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      onSend(text);
      setMessages((held) => [...held, { id: "chosen", threadId: "thread", role: "user", status: "complete",
        createdAt: "2026-09-23T10:00:02.000Z", updatedAt: "2026-09-23T10:00:02.000Z", attachments: [],
        parts: [{ type: "text", text }] }]);
    },
    adapters: {
      threadList: {
        threadId: "thread", isLoading: false,
        threads: [{ id: "thread", remoteId: "thread", status: "regular" }], archivedThreads: [],
        onSwitchToNewThread: async () => undefined, onSwitchToThread: () => undefined,
        onRename: async () => undefined, onArchive: async () => undefined, onUnarchive: async () => undefined,
      },
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <main className="chat-panel" style={{ height: "100dvh" }}>
      <ThreadPrimitive.Root className="thread-root">
        <ThreadPrimitive.Viewport className="thread-viewport">
          <div className="message-column">
            <ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} />
          </div>
          <ThreadPrimitive.ViewportFooter className="thread-footer"><Composer /></ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </main>
  </AssistantRuntimeProvider>;
}

const touch = matchMedia("(pointer: coarse)").matches;

it(`inserts, combines, and focuses quick replies without sending (${touch ? "mobile tap" : "desktop click"})`, async () => {
  const [width, height] = touch ? [390, 844] : [1280, 800];
  await page.viewport(width, height);
  const onSend = vi.fn();
  const { container } = render(<QuickRepliesHarness onSend={onSend} />);
  const row = screen.getByRole("group", { name: "Suggested replies" });
  expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(screen.getByText(answerText).getBoundingClientRect().bottom - 1);
  expect(row.closest(".activity-root")).toBeNull();
  expect(container.scrollWidth).toBeLessThanOrEqual(width);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

  const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  const choose = async (label: string, text: string) => {
    if (touch) await commands.tapReplyOption(label);
    else await page.getByRole("button", { name: label }).click();
    await waitFor(() => {
      expect(input).toHaveValue(text);
      expect(input).toHaveFocus();
      expect(input.selectionStart).toBe(text.length);
      expect(input.selectionEnd).toBe(text.length);
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector(".message-user")).toBeNull();
  };
  await choose("Review draft", "Review draft");
  input.setSelectionRange(0, 0);
  await choose("Keep going", "Review draft\nKeep going");

  const directory = import.meta.env.VITE_QUICK_REPLIES_SHOTS as string | undefined;
  if (directory) await page.screenshot({ path: `${directory}/quick-replies-${touch ? "mobile" : "desktop"}.png` });

  await page.getByRole("combobox", { name: "Message" }).fill("My notes  \n ");
  await choose("Review draft", "My notes\nReview draft");
  await page.getByRole("button", { name: "Send message" }).click();
  await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith("My notes\nReview draft"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Keep going" })).toBeDisabled());
});

import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { AssistantMessage, UserMessage } from "./Messages";
import { ContextDisplay } from "./assistant-ui/ContextDisplay";
import { Transcript } from "../stories/transcript";
import "../styles.css";

const apiMock = vi.hoisted(() => ({ compactThread: vi.fn(), threadUsage: vi.fn() }));
vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), api: apiMock }));
const answer: WebMessage = {
  id: "answer", threadId: "thread", role: "assistant", status: "complete", attachments: [],
  createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:01Z",
  parts: [{ type: "text", text: "The fictional garden plan is ready." }],
};
function CompactConversation() {
  const [message, setMessage] = useState(answer);
  const convertMessage = useCallback((value: WebMessage) => convertWebMessage(value), []);
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [message], convertMessage, onNew: async () => undefined,
    adapters: { threadList: {
      threadId: "thread", isLoading: false,
      threads: [{ id: "thread", remoteId: "thread", status: "regular" }], archivedThreads: [],
      onSwitchToNewThread: async () => undefined, onSwitchToThread: () => undefined,
      onRename: async () => undefined, onArchive: async () => undefined, onUnarchive: async () => undefined,
    } },
  });
  apiMock.compactThread.mockImplementation(async () => {
    const result = { status: "succeeded", trigger: "manual", operationId: "fictional-compact",
      tokensBefore: 183_400, tokensAfter: 41_300, tokenCountsExact: false };
    // The store's message.changed projection replaces the settled message after Compact.
    setMessage((current) => ({ ...current, updatedAt: "2026-01-15T10:00:02Z", parts: [...current.parts, {
      type: "telemetry", event: "runtime_telemetry", data: { kind: "context_compaction", data: result },
    }] }));
    return result;
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="thread-root"><ThreadPrimitive.Viewport className="thread-viewport">
      <div className="message-column"><ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} /></div>
    </ThreadPrimitive.Viewport></ThreadPrimitive.Root>
    <div style={{ position: "fixed", bottom: 70, right: 16 }}><ContextDisplay
      context={{ status: "current", usage: { total: 183_400, contextWindow: 200_000 } }}
      totals={{ total: {}, byModel: [], computedAt: "2026-01-15T10:00:00Z" }} compactThreadId="thread"
    /></div>
  </AssistantRuntimeProvider>;
}
afterEach(async () => { vi.clearAllMocks(); await page.viewport(1440, 1000); });
describe("Transcript compaction", () => {
  it("keeps the automatic-running Storybook fixture visibly running", async () => {
    render(<Transcript messages={[{ role: "assistant", status: { type: "running" }, content: [
      { type: "text", text: "The garden plan is ready." },
      { type: "data-context-compaction", data: { kind: "context_compaction", data: { status: "running", trigger: "automatic" } } },
    ] }]} />);
    expect(await screen.findByRole("note", { name: "Compacting context… · automatic" })).toBeVisible();
  });
  it.each([[1440, 1000, "desktop"], [390, 844, "phone"]])("shows the persisted row after Compact at %ipx", async (width, height, label) => {
    await page.viewport(width, height);
    render(<CompactConversation />);
    expect(screen.queryByText(/Context compacted/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Context usage:/u }));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    const row = await screen.findByRole("note", { name: "Context compacted · 183.4k → ≈41.3k tokens · manual" });
    expect(row).toBeVisible();
    expect(screen.getByText("The fictional garden plan is ready.").compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(document.querySelector<HTMLElement>(".context-display-backdrop") ?? document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument());
    const shots = import.meta.env.VITE_CONTEXT_FOLLOWUP_SHOTS as string | undefined;
    if (shots) await page.screenshot({ path: `${shots}/compaction-row-${label}.png` });
  });
});

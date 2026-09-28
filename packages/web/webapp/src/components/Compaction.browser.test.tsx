import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { AssistantMessage, CompactionMarkerRow, UserMessage } from "./Messages";
import { ModelMarkers } from "./ModelMarkers";
import { ContextDisplay } from "./assistant-ui/ContextDisplay";
import { ManualCompactionMarker } from "./ManualCompactionMarker";
import { thread } from "../test/fixtures";
import "../styles.css";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    emulateReducedMotion(reducedMotion: "reduce" | "no-preference" | null): Promise<void>;
    emulateColorScheme(colorScheme: "light" | "dark" | null): Promise<void>;
  }
}

const apiMock = vi.hoisted(() => ({ compactThread: vi.fn(), threadUsage: vi.fn() }));
vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), api: apiMock }));
const answer: WebMessage = {
  id: "answer", threadId: "thread", role: "assistant", status: "complete", attachments: [],
  createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:01Z",
  parts: [{ type: "text", text: "The fictional garden plan is ready." }],
};
function CompactConversation({ slow = false, onRelease }: { readonly slow?: boolean; readonly onRelease?: (release: () => void) => void }) {
  const [message, setMessage] = useState(answer);
  const [compacting, setCompacting] = useState(false);
  const activeThread = thread("thread", "alpha", compacting ? { compaction: {
    status: "running", trigger: "manual", startedAt: "2026-01-15T10:00:00Z",
  } } : {});
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
    if (slow) {
      setCompacting(true);
      await new Promise<void>((resolve) => onRelease?.(resolve));
    }
    const result = { status: "succeeded", trigger: "manual", operationId: "fictional-compact",
      timestamp: Date.parse("2026-01-15T10:00:02Z"),
      tokensBefore: 183_400, tokensAfter: 41_300, tokenCountsExact: false };
    // The store's message.changed projection replaces the settled message after Compact.
    setMessage((current) => ({ ...current, updatedAt: "2026-01-15T10:00:02Z", parts: [...current.parts, {
      type: "telemetry", event: "runtime_telemetry", data: { kind: "context_compaction", data: result },
    }] }));
    setCompacting(false);
    return result;
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="thread-root"><ThreadPrimitive.Viewport className="thread-viewport">
      <div className="message-column"><ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} />
        <ManualCompactionMarker thread={activeThread} detail={{ thread: activeThread, messages: [message] }} />
      </div>
    </ThreadPrimitive.Viewport></ThreadPrimitive.Root>
    <div style={{ position: "fixed", bottom: 70, right: 16 }}><ContextDisplay
      context={{ status: "current", usage: { total: 183_400, contextWindow: 200_000 } }}
      totals={{ total: {}, byModel: [], computedAt: "2026-01-15T10:00:00Z" }} compactThreadId="thread" manualCompacting={compacting}
    /></div>
  </AssistantRuntimeProvider>;
}
afterEach(async () => { vi.clearAllMocks(); await commands.emulateReducedMotion(null); await page.viewport(1440, 1000); });
describe("Transcript compaction", () => {
  it.each([[1440, 1000, "desktop"], [390, 844, "phone"]])("keeps a running manual operation visible after closing the dialog at %ipx", async (width, height, label) => {
    await page.viewport(width, height);
    let release!: () => void;
    render(<CompactConversation slow onRelease={(finish) => { release = finish; }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Context usage:/u }));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    const row = await screen.findByRole("note", { name: "Compacting context… · manual" });
    expect(row).toBeVisible();
    await commands.emulateReducedMotion("reduce");
    expect(getComputedStyle(row.querySelector(".context-compaction-content")!).animationName).toBe("none");
    await commands.emulateReducedMotion(null);
    fireEvent.click(document.querySelector<HTMLElement>(".context-display-backdrop") ?? document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Context usage:.*compacting/u })).toHaveAttribute("data-busy");
    const shots = import.meta.env.VITE_CONTEXT_FOLLOWUP_SHOTS as string | undefined;
    if (shots) await page.screenshot({ path: `${shots}/compaction-running-${label}.png` });
    release();
    expect(await screen.findByRole("note", { name: "Context compacted · 183.4k → ≈41.3k tokens · manual" })).toBeVisible();
    expect(screen.queryByRole("note", { name: "Compacting context… · manual" })).not.toBeInTheDocument();
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

const shotDirectory = import.meta.env.VITE_COMPACTION_MARKER_SHOTS as string | undefined;
describe("Compaction marker and unknown context visual states", () => {
  afterEach(async () => { document.documentElement.removeAttribute("data-console-theme"); await commands.emulateColorScheme(null); });
  it.each(["light", "dark"] as const)("colors the pre-turn dash muted in every %s palette", async (scheme) => {
    await page.viewport(800, 360);
    await commands.emulateColorScheme(scheme);
    render(<div style={{ padding: 36, zoom: 4 }}><ContextDisplay context={{ status: "unavailable" }}
      totals={{ total: {}, byModel: [], settledAssistantTurns: 0, computedAt: "2026-01-15T10:00:00Z" }} /></div>);
    const trigger = screen.getByRole("button", { name: /Context usage:/u });
    const percent = trigger.querySelector<HTMLElement>(".context-display-trigger-percent")!;
    expect(percent.textContent).toBe("—");
    expect(trigger).toHaveAttribute("data-unknown");
    for (const palette of ["default", "ocean", "plum", "terracotta"]) {
      if (palette === "default") document.documentElement.removeAttribute("data-console-theme");
      else document.documentElement.setAttribute("data-console-theme", palette);
      const reference = document.createElement("span");
      reference.style.color = "var(--text-muted)";
      document.body.append(reference);
      expect(getComputedStyle(percent).color).toBe(getComputedStyle(reference).color);
      reference.remove();
    }
    document.documentElement.removeAttribute("data-console-theme");
    if (shotDirectory) await page.screenshot({ path: `${shotDirectory}/dash-${scheme}.png` });
  });
  it("mutes even a stale percent while context is loading", () => {
    render(<ContextDisplay contextLoading context={{ status: "current", usage: { total: 10_000, contextWindow: 20_000 } }}
      totals={{ total: {}, byModel: [], computedAt: "2026-01-15T10:00:00Z" }} />);
    const trigger = screen.getByRole("button", { name: /Context usage: loading/u });
    expect(trigger).toHaveAttribute("data-unknown");
    const percent = trigger.querySelector<HTMLElement>(".context-display-trigger-percent")!;
    expect(percent.textContent).not.toBe("—");
    const reference = document.createElement("span");
    reference.style.color = "var(--text-muted)";
    document.body.append(reference);
    expect(getComputedStyle(percent).color).toBe(getComputedStyle(reference).color);
    reference.remove();
  });
  it("shows compaction next to a model change in a transcript", async () => {
    await page.viewport(1440, 900);
    render(<div className="thread-root"><div className="thread-viewport"><div className="message-column">
      <ModelMarkers transitions={[{ type: "conversation-marker", kind: "model", at: "2026-01-15T09:00:00Z",
        before: { model: "atlas/standard", effort: "high" }, after: { model: "grove/fast", effort: "medium" } }]} />
      <div className="message message-assistant">A fictional garden plan is ready.</div>
      <CompactionMarkerRow marker={{ type: "conversation-marker", kind: "compaction", at: "2026-01-15T10:00:00Z",
        operationId: "fictional-compact", trigger: "manual", status: "succeeded", tokensBefore: 183_400, tokensAfter: 41_300 }} />
    </div></div></div>);
    expect(screen.getByRole("note", { name: /Context compacted/u })).toBeVisible();
    if (shotDirectory) await page.screenshot({ path: `${shotDirectory}/markers-desktop.png` });
  });
});

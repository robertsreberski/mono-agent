import type { AssistantRuntime } from "@assistant-ui/react";
import { useAssistantRuntime } from "@assistant-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartTurnInput, WebMessage } from "./types";
import { agent, attachment, monitor, thread, uploadLimits } from "./test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock.current,
  useUploadLimits: () => uploadLimits,
}));
vi.mock("./api", () => ({
  api: {
    createUpload: vi.fn(),
    deleteUpload: vi.fn(),
  },
  uploadContent: vi.fn(),
}));

import { api, uploadContent } from "./api";
import { composerDraftKey, hasUnsentComposerDraft, resetComposerDraft } from "./composer-draft";
import { Composer } from "./components/Composer";
import { WebRuntimeProvider } from "./runtime";

const onlineAgent = agent("agent");
const idleThread = thread("thread", "agent");

type SendTurn = (
  input: StartTurnInput,
  onThreadResolved?: (threadId: string) => void,
) => Promise<void>;

const createStore = (
  sendTurn: SendTurn,
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  bootstrap: null,
  agents: [onlineAgent],
  threads: [idleThread],
  visibleThreads: [idleThread],
  selectedAgent: onlineAgent,
  selectedThread: idleThread,
  detail: null,
  selectedAgentId: onlineAgent.sourceId,
  selectedThreadId: idleThread.id,
  loading: false,
  detailLoading: false,
  error: null,
  actionError: null,
  connection: "live",
  showArchived: false,
  model: "",
  effort: "",
  modelOptions: [],
  effortOptions: [],
  skillRegistry: { status: "ready", items: [], total: 0 },
  selectAgent: vi.fn(),
  selectThread: vi.fn(),
  createThread: vi.fn(),
  renameThread: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  sendTurn,
  sendLiveInput: vi.fn().mockResolvedValue(undefined),
  cancelTurn: vi.fn(),
  setShowArchived: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  retry: vi.fn(),
  clearActionError: vi.fn(),
  ...overrides,
});

function RuntimeCapture({ onReady }: { readonly onReady: (runtime: AssistantRuntime) => void }) {
  const runtime = useAssistantRuntime();
  useEffect(() => onReady(runtime), [onReady, runtime]);
  return null;
}

const runtimeTree = (onReady: (runtime: AssistantRuntime) => void) => (
  <WebRuntimeProvider>
    <RuntimeCapture onReady={onReady} />
  </WebRuntimeProvider>
);

const renderRuntime = async () => {
  let runtime: AssistantRuntime | undefined;
  const onReady = (value: AssistantRuntime) => { runtime = value; };
  const view = render(runtimeTree(onReady));
  await waitFor(() => expect(runtime).toBeDefined());
  return {
    get runtime() {
      if (!runtime) throw new Error("Runtime is not ready.");
      return runtime;
    },
    rerender: () => view.rerender(runtimeTree(onReady)),
  };
};

const renderComposerRuntime = async () => {
  let runtime: AssistantRuntime | undefined;
  const onReady = (value: AssistantRuntime) => { runtime = value; };
  const tree = () => (
    <WebRuntimeProvider>
      <RuntimeCapture onReady={onReady} />
      <Composer key={composerDraftKey(
        storeMock.current?.selectedAgentId as string | null,
        storeMock.current?.selectedThreadId as string | null,
      ) ?? "no-agent"} />
    </WebRuntimeProvider>
  );
  const view = render(tree());
  await waitFor(() => expect(runtime).toBeDefined());
  return {
    get runtime() {
      if (!runtime) throw new Error("Runtime is not ready.");
      return runtime;
    },
    rerender: () => view.rerender(tree()),
  };
};

describe("WebRuntimeProvider assistant-ui submission integration", () => {
  beforeEach(() => {
    storeMock.current = null;
    resetComposerDraft();
    vi.clearAllMocks();
    vi.mocked(api.createUpload).mockImplementation(async (file) =>
      attachment("upload-1", {
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }),
    );
    vi.mocked(api.deleteUpload).mockResolvedValue(undefined);
    vi.mocked(uploadContent).mockImplementation(async (upload) => ({
      ...upload,
      uploaded: true,
    }));
  });

  it("hides legacy silent cron rows while coalescing Monitor activity and keeping rich cron content", async () => {
    const wake = (id: string): WebMessage => ({
      id, threadId: idleThread.id, turnId: `turn-${id}`, role: "assistant", status: "complete",
      createdAt: "2026-07-17T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", attachments: [],
      parts: [{ type: "monitor-activity", monitors: [{ projection: monitor(), deliveryKeys: [] }] }],
    });
    const silent: WebMessage = { ...wake("silent"), parts: [
      { type: "text", text: "Completed silently (no message was reported)." },
      { type: "telemetry", event: "cron_run", data: { runId: "run", status: "succeeded", silent: true } },
    ] };
    const rich: WebMessage = { ...silent, id: "rich", parts: [...silent.parts, { type: "text", text: "Delivered content" }] };
    storeMock.current = createStore(vi.fn(), {
      detail: { thread: idleThread, messages: [wake("first"), wake("second"), silent, rich] },
    });
    const view = await renderRuntime();
    expect(view.runtime.thread.getState().messages.map((message) => message.id)).toEqual(["second", "rich"]);
    expect(view.runtime.thread.getState().messages[1]?.content).toContainEqual({ type: "text", text: "Delivered content" });
  });

  it("restores a rejected turn as a retryable composer draft without an unhandled rejection", async () => {
    let rejectTurn!: (reason: Error) => void;
    const sendTurn = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => { rejectTurn = reject; }),
      )
      .mockResolvedValueOnce(undefined);
    storeMock.current = createStore(sendTurn);
    const { runtime } = await renderRuntime();
    const composer = runtime.thread.composer;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    act(() => {
      composer.setText("keep this draft");
      composer.setQuote({ text: "quoted context", messageId: "source-message" });
      composer.send();
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(composer.getState().text).toBe("");
    act(() => composer.setText("newer work"));

    await act(async () => {
      rejectTurn(new Error("start failed"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(composer.getState().text).toBe("keep this draft\n\nnewer work"),
    );
    expect(composer.getState().quote).toEqual({
      text: "quoted context",
      messageId: "source-message",
    });
    await waitFor(() => expect(composer.getState().canSend).toBe(true));
    act(() => composer.send());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("submits one quote with the authored text and clears it on a thread switch", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn);
    const view = await renderRuntime();
    const composer = view.runtime.thread.composer;

    act(() => {
      composer.setQuote({ text: "selected response", messageId: "source-message" });
      composer.setText("Follow up");
      composer.send();
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Follow up",
        quote: { text: "selected response", messageId: "source-message" },
      }),
      expect.any(Function),
    ));

    const otherThread = thread("other", "agent");
    act(() => composer.setQuote({ text: "do not carry", messageId: "source-message" }));
    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await waitFor(() => expect(view.runtime.thread.composer.getState().quote).toBeUndefined());
  });

  it("admits only one rapid turn start and preserves the second submission as a draft", async () => {
    let resolveTurn!: () => void;
    const sendTurn = vi.fn(
      () => new Promise<void>((resolve) => { resolveTurn = resolve; }),
    );
    storeMock.current = createStore(sendTurn);
    const { runtime } = await renderRuntime();
    const composer = runtime.thread.composer;

    act(() => {
      composer.setText("first");
      composer.send();
      composer.setText("second");
      composer.send();
    });

    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(composer.getState().text).toBe("");

    await act(async () => {
      resolveTurn();
      await Promise.resolve();
    });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(composer.getState().text).toBe("second"));
  });

  it("routes text submitted during a running turn to live input instead of starting another turn", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const sendLiveInput = vi.fn().mockResolvedValue(undefined);
    const runningThread = thread("thread", "agent", {
      runState: { id: "turn-running", status: "running" },
    });
    storeMock.current = createStore(sendTurn, {
      threads: [runningThread],
      visibleThreads: [runningThread],
      selectedThread: runningThread,
      sendLiveInput,
    });
    const { runtime } = await renderRuntime();
    const composer = runtime.thread.composer;

    act(() => {
      composer.setText("Use the smaller scope");
      composer.send();
    });

    await waitFor(() => expect(sendLiveInput).toHaveBeenCalledWith("Use the smaller scope"));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(composer.getState().text).toBe("");
  });

  it("keeps the rendered send button active for a live follow-up", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const sendLiveInput = vi.fn().mockResolvedValue(undefined);
    const runningThread = thread("thread", "agent", {
      runState: { id: "turn-running", status: "running" },
    });
    storeMock.current = createStore(sendTurn, {
      threads: [runningThread],
      visibleThreads: [runningThread],
      selectedThread: runningThread,
      sendLiveInput,
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" });
    const send = screen.getByRole("button", { name: "Send live follow-up" });

    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: "Use the actual button" } });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(sendLiveInput).toHaveBeenCalledWith("Use the actual button"));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(runtime.thread.composer.getState().text).toBe("");
  });

  it("submits a live follow-up from Enter while preserving Shift+Enter", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const sendLiveInput = vi.fn().mockResolvedValue(undefined);
    const runningThread = thread("thread", "agent", {
      runState: { id: "turn-running", status: "running" },
    });
    storeMock.current = createStore(sendTurn, {
      threads: [runningThread],
      visibleThreads: [runningThread],
      selectedThread: runningThread,
      sendLiveInput,
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" });

    fireEvent.change(input, { target: { value: "Use Enter" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    expect(sendLiveInput).not.toHaveBeenCalled();
    expect(runtime.thread.composer.getState().text).toBe("Use Enter");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sendLiveInput).toHaveBeenCalledWith("Use Enter"));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(runtime.thread.composer.getState().text).toBe("");
  });

  it("inserts a keyboard-selected $ skill without sending and restores the caret", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn, {
      skillRegistry: {
        status: "ready",
        items: [
          {
            name: "research",
            description: "Find primary sources",
            availability: "on-demand",
            reference: "$research",
          },
          {
            name: "review",
            description: "Review the final patch",
            availability: "inlined",
            reference: "$review",
          },
        ],
        total: 2,
      },
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;

    input.focus();
    fireEvent.change(input, { target: { value: "Use $re" } });
    const firstOption = await screen.findByRole("option", { name: /\$review/u });
    const option = screen.getByRole("option", { name: /\$research/u });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(firstOption).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown", code: "ArrowDown" });
    expect(option).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(runtime.thread.composer.getState().text).toBe("Use $research "));
    expect(sendTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(input.selectionStart).toBe("Use $research ".length));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("dismisses $ skill autocomplete without changing or sending the draft", async () => {
    const animationFrames = new Map<number, FrameRequestCallback>();
    let nextAnimationFrame = 0;
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextAnimationFrame += 1;
      animationFrames.set(nextAnimationFrame, callback);
      return nextAnimationFrame;
    });
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      animationFrames.delete(frame);
    });
    const flushAnimationFrames = async (): Promise<void> => {
      for (let pass = 0; pass < 10 && animationFrames.size > 0; pass += 1) {
        const callbacks = [...animationFrames.values()];
        animationFrames.clear();
        await act(async () => {
          for (const callback of callbacks) callback(performance.now());
        });
      }
    };
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn, {
      skillRegistry: {
        status: "ready",
        items: [{
          name: "research",
          description: "Find primary sources",
          availability: "on-demand",
          reference: "$research",
        }],
        total: 1,
      },
    });
    try {
      const { runtime } = await renderComposerRuntime();
      const input = screen.getByRole("combobox", { name: "Message" });
      await flushAnimationFrames();
      expect(animationFrames.size).toBe(0);

      fireEvent.change(input, { target: { value: "$res" } });
      expect(await screen.findByRole("option", { name: /\$research/u })).toBeInTheDocument();
      expect(screen.getByText("1 skill suggestion available.")).toBeInTheDocument();
      expect(fireEvent.keyDown(input, { key: "Escape", code: "Escape" })).toBe(false);
      await flushAnimationFrames();
      await waitFor(() => expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument());

      expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument();
      expect(document.querySelector('[role="status"][aria-live="polite"]')).toBeNull();
      expect(runtime.thread.composer.getState().text).toBe("$res");
      expect(sendTurn).not.toHaveBeenCalled();
    } finally {
      requestAnimationFrame.mockRestore();
      cancelAnimationFrame.mockRestore();
    }
  });

  it("inserts a pointer-selected $ skill without sending", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn, {
      skillRegistry: {
        status: "ready",
        items: [{
          name: "research",
          description: "Find primary sources",
          availability: "on-demand",
          reference: "$research",
        }],
        total: 1,
      },
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" });

    fireEvent.change(input, { target: { value: "$res" } });
    fireEvent.click(await screen.findByRole("option", { name: /\$research/u }));

    await waitFor(() => expect(runtime.thread.composer.getState().text).toBe("$research "));
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("opens autocomplete for a $ skill pasted in the middle of a draft", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn, {
      skillRegistry: {
        status: "ready",
        items: [{
          name: "research",
          description: "Find primary sources",
          availability: "on-demand",
          reference: "$research",
        }],
        total: 1,
      },
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;

    input.focus();
    fireEvent.change(input, {
      target: {
        value: "Use $res later",
        selectionStart: 8,
        selectionEnd: 8,
      },
    });

    const option = await screen.findByRole("option", { name: /\$research/u });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(option);
    await waitFor(() => expect(runtime.thread.composer.getState().text).toBe("Use $research later"));
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("does not mount a zero-result $ picker that would capture normal Enter submission", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn, {
      skillRegistry: {
        status: "ready",
        items: [{
          name: "research",
          description: "Find primary sources",
          availability: "on-demand",
          reference: "$research",
        }],
        total: 1,
      },
    });
    await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" });

    fireEvent.change(input, { target: { value: "$20" } });
    expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "$20" }),
      expect.any(Function),
    ));
  });

  it("browses by description, shows unavailable skills disabled, and inserts without sending", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn, {
      skillRegistry: {
        status: "ready",
        items: [
          {
            name: "research",
            description: "Find primary sources",
            availability: "on-demand",
            reference: "$research",
          },
          {
            name: "private",
            description: "Internal notes",
            availability: "unavailable",
            unavailableReason: "not-selected",
          },
        ],
        total: 2,
      },
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Draft" } });
    input.setSelectionRange(5, 5);
    fireEvent.select(input);

    const browse = screen.getByRole("button", { name: "Browse skills" });
    fireEvent.pointerDown(browse);
    fireEvent.click(browse);
    expect(await screen.findByRole("dialog", { name: "Skills" })).toBeInTheDocument();
    const unavailable = screen.getByRole("option", { name: /private, Not selected/u });
    expect(unavailable).toHaveAttribute("data-disabled", "true");

    fireEvent.change(screen.getByRole("combobox", { name: "Search skills" }), {
      target: { value: "primary sources" },
    });
    const available = await screen.findByRole("option", { name: /\$research, On demand/u });
    expect(screen.queryByRole("option", { name: /private/u })).not.toBeInTheDocument();
    const focus = vi.spyOn(input, "focus");
    fireEvent.click(available);

    await waitFor(() => expect(runtime.thread.composer.getState().text).toBe("Draft $research "));
    expect(sendTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(focus).toHaveBeenLastCalledWith();
  });

  it.each([
    [{ status: "loading", items: [] }, "Loading skills…"],
    [{ status: "ready", items: [], total: 0 }, "No skills are installed for this agent."],
    [{ status: "error", items: [] }, "The agent could not load its skill registry."],
    [{ status: "unsupported", items: [] }, "This agent version does not expose skill discovery."],
    [{ status: "offline", items: [] }, "This agent is offline."],
  ] as const)("keeps composition usable for the %s registry state", async (skillRegistry, message) => {
    storeMock.current = createStore(vi.fn<SendTurn>().mockResolvedValue(undefined), { skillRegistry });
    await renderComposerRuntime();
    fireEvent.click(screen.getByRole("button", { name: "Browse skills" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close skills" }));
    expect(screen.getByRole("combobox", { name: "Message" })).toBeEnabled();
  });

  it("restores an attachment-only rejected turn into its exact created thread without re-uploading", async () => {
    let rejectTurn!: (reason: Error) => void;
    const createdThread = thread("created", "agent");
    const sendTurn = vi
      .fn<SendTurn>()
      .mockImplementationOnce(
        (_input, onThreadResolved) => {
          onThreadResolved?.(createdThread.id);
          return new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
        },
      )
      .mockResolvedValueOnce(undefined);
    storeMock.current = createStore(sendTurn, {
      threads: [],
      visibleThreads: [],
      selectedThread: null,
      selectedThreadId: null,
    });
    const view = await renderRuntime();
    const composer = view.runtime.thread.composer;

    await act(async () => {
      await composer.addAttachment(new File(["retry"], "retry.md", { type: "text/markdown" }));
    });
    expect(composer.getState().attachments).toHaveLength(1);
    act(() => composer.send());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({ attachmentIds: ["upload-1"] });

    storeMock.current = createStore(sendTurn, {
      threads: [createdThread],
      visibleThreads: [createdThread],
      selectedThread: createdThread,
      selectedThreadId: createdThread.id,
      connection: "reconnecting",
    });
    view.rerender();
    await act(async () => {
      rejectTurn(new Error("start failed"));
      await Promise.resolve();
    });

    await waitFor(() => expect(view.runtime.thread.composer.getState().canSend).toBe(false));
    expect(view.runtime.thread.composer.getState().attachments).toHaveLength(0);
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();

    storeMock.current = createStore(sendTurn, {
      threads: [createdThread],
      visibleThreads: [createdThread],
      selectedThread: createdThread,
      selectedThreadId: createdThread.id,
      connection: "live",
    });
    view.rerender();

    await waitFor(() =>
      expect(view.runtime.thread.composer.getState().attachments).toMatchObject([
        { id: "upload-1", name: "retry.md" },
      ]),
    );
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();

    act(() => view.runtime.thread.composer.send());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    expect(sendTurn.mock.calls[1]?.[0]).toMatchObject({ attachmentIds: ["upload-1"] });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();
  });

  it("does not restore a new-thread submission into another same-agent thread", async () => {
    let rejectTurn!: (reason: Error) => void;
    const createdThread = thread("created", "agent");
    const otherThread = thread("other", "agent");
    const sendTurn = vi.fn<SendTurn>(
      (_input, onThreadResolved) => {
        onThreadResolved?.(createdThread.id);
        return new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
      },
    );
    storeMock.current = createStore(sendTurn, {
      threads: [],
      visibleThreads: [],
      selectedThread: null,
      selectedThreadId: null,
    });
    const view = await renderRuntime();

    act(() => {
      view.runtime.thread.composer.setText("belongs to created");
      view.runtime.thread.composer.send();
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));

    storeMock.current = createStore(sendTurn, {
      threads: [createdThread, otherThread],
      visibleThreads: [createdThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await act(async () => {
      rejectTurn(new Error("start failed"));
      await Promise.resolve();
    });

    await waitFor(() => expect(view.runtime.thread.composer.getState().canSend).toBe(false));
    expect(view.runtime.thread.composer.getState().text).toBe("");
  });
});

describe("what the composer is holding, for anything that would destroy it", () => {
  beforeEach(() => {
    storeMock.current = null;
    resetComposerDraft();
    vi.clearAllMocks();
  });
  afterEach(() => { resetComposerDraft(); });

  it("says what is typed and unsent, and stops saying it once it is sent", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn);
    await renderComposerRuntime();
    const input = screen.getByRole("combobox", { name: "Message" });

    expect(hasUnsentComposerDraft()).toBe(false);
    fireEvent.change(input, { target: { value: "half a thought" } });
    await waitFor(() => expect(hasUnsentComposerDraft()).toBe(true));

    // Whitespace is not a draft.
    fireEvent.change(input, { target: { value: "   " } });
    await waitFor(() => expect(hasUnsentComposerDraft()).toBe(false));

    fireEvent.change(input, { target: { value: "half a thought" } });
    await waitFor(() => expect(hasUnsentComposerDraft()).toBe(true));
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(sendTurn).toHaveBeenCalled());
    await waitFor(() => expect(hasUnsentComposerDraft()).toBe(false));
  });

  it("restores independent text drafts across rapid conversation switches", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const otherThread = thread("other", "agent");
    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
    });
    const view = await renderComposerRuntime();

    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), {
      target: { value: "draft for A" },
    });
    await waitFor(() => expect(hasUnsentComposerDraft()).toBe(true));

    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue(""));
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), {
      target: { value: "draft for B" },
    });

    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
    });
    view.rerender();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("draft for A"));

    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("draft for B"));
  });

  it("restores switched text but disposes the old context's attachment", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const otherThread = thread("other", "agent");
    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
    });
    const view = await renderComposerRuntime();
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), {
      target: { value: "text survives" },
    });
    await act(async () => {
      await view.runtime.thread.composer.addAttachment(
        new File(["discard"], "discard.md", { type: "text/markdown" }),
      );
    });
    expect(view.runtime.thread.composer.getState().attachments).toHaveLength(1);

    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await waitFor(() => expect(api.deleteUpload).toHaveBeenCalledWith("upload-1"));
    await waitFor(() => expect(view.runtime.thread.composer.getState().attachments).toHaveLength(0));

    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
    });
    view.rerender();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("text survives"));
    expect(view.runtime.thread.composer.getState().attachments).toHaveLength(0);
  });

  it("keeps saying so when the composer is taken off screen with a draft in it", async () => {
    // `Chat` swaps the composer for the archived and cron read-only footers,
    // and the assistant-ui runtime that holds the text outlives it. Reporting
    // "nothing is held" there let the next visibility flip reload over a draft
    // that was still there.
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn);
    let runtime: AssistantRuntime | undefined;
    const onReady = (value: AssistantRuntime) => { runtime = value; };
    const tree = (composer: boolean) => (
      <WebRuntimeProvider>
        <RuntimeCapture onReady={onReady} />
        {composer && <Composer />}
      </WebRuntimeProvider>
    );
    const view = render(tree(true));
    await waitFor(() => expect(runtime).toBeDefined());
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), {
      target: { value: "half a thought" },
    });
    await waitFor(() => expect(hasUnsentComposerDraft()).toBe(true));

    // The operator opens an archived conversation: the composer goes, the text
    // does not.
    view.rerender(tree(false));
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    expect(hasUnsentComposerDraft()).toBe(true);

    // The same context comes back with the text the bridge retained.
    view.rerender(tree(true));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" }))
      .toHaveValue("half a thought"));
    expect(hasUnsentComposerDraft()).toBe(true);
  });
});

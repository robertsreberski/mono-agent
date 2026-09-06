import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../test/fixtures";
import { WebRuntimeProvider } from "../runtime";
import type { ThreadDetail, ThreadSummary, WebMessage } from "../types";

const MODEL = "pi:openai-codex:gpt-5.5";
const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../console-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../console-store")>();
  return {
    ...actual,
    useConsoleStore: () => storeMock.current,
    useUploadLimits: () => ({
      maxFileBytes: 20,
      maxFilesPerTurn: 10,
      maxTurnBytes: 100,
      accept: ["image/png"],
    }),
  };
});

vi.mock("../notifications", () => ({
  NotificationBell: () => null,
}));
vi.mock("./CronChannelHeader", () => ({
  CronChannelHeader: () => null,
}));
vi.mock("./assistant-ui/Quote", () => ({
  SelectionToolbar: () => null,
}));
vi.mock("./Composer", () => ({
  Composer: () => null,
}));
vi.mock("./Messages", () => ({
  AskReconciliationProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  AssistantMessage: () => <div data-testid="thread-message" />,
  SystemMessage: () => <div data-testid="thread-message" />,
  UserMessage: () => <div data-testid="thread-message" />,
}));

import { CONNECTION_NOTICE_DELAY_MS, Chat, ConnectionBanner, ModelControls } from "./Chat";

const resizeObserverCallbacks = new Set<ResizeObserverCallback>();
class ResizeObserverStub implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverCallbacks.add(callback);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    resizeObserverCallbacks.delete(this.callback);
  }
}

const notifyResizeObservers = () => {
  for (const callback of resizeObserverCallbacks) callback([], {} as ResizeObserver);
};

const scrollDescriptors = {
  scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop"),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  scrollTo: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo"),
};
const scrollTopByElement = new WeakMap<HTMLElement, number>();
let messageRowHeight = 100;

const isThreadViewport = (element: HTMLElement) => element.classList.contains("thread-viewport");
const maxScrollTop = (element: HTMLElement) => Math.max(0, element.scrollHeight - element.clientHeight);

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();

  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return scrollTopByElement.get(this) ?? 0;
    },
    set(value: number) {
      scrollTopByElement.set(this, Math.min(Number(value), maxScrollTop(this)));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return isThreadViewport(this) ? 100 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return isThreadViewport(this)
        ? this.querySelectorAll("[data-testid='thread-message']").length * messageRowHeight
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value({ top = 0 }: ScrollToOptions) {
      this.scrollTop = Math.min(Number(top), maxScrollTop(this));
      this.dispatchEvent(new Event("scroll"));
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  for (const [key, descriptor] of Object.entries(scrollDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

beforeEach(() => {
  messageRowHeight = 100;
  resizeObserverCallbacks.clear();
});

describe("ConnectionBanner", () => {
  it("suppresses brief reconnects, clears on recovery, and shows offline immediately", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ConnectionBanner connection="live" />);
    rerender(<ConnectionBanner connection="reconnecting" />);

    expect(screen.queryByText(/Live updates are reconnecting/u)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONNECTION_NOTICE_DELAY_MS - 1));
    expect(screen.queryByText(/Live updates are reconnecting/u)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(/Live updates are reconnecting/u)).toBeVisible();

    rerender(<ConnectionBanner connection="live" />);
    expect(screen.queryByText(/Live updates are reconnecting/u)).not.toBeInTheDocument();
    rerender(<ConnectionBanner connection="offline" />);
    expect(screen.getByText(/You’re offline/u)).toBeVisible();
    vi.useRealTimers();
  });
});

const chatMessage = (id: string, threadId: string): WebMessage => ({
  id,
  threadId,
  role: "assistant",
  parts: [{ type: "text", text: id }],
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  finishedAt: "2026-07-17T10:00:00.000Z",
  status: "complete",
});

const chatDetail = (selectedThread: ThreadSummary, count: number): ThreadDetail => ({
  thread: selectedThread,
  messages: Array.from(
    { length: count },
    (_, index) => chatMessage(`${selectedThread.id}-message-${index}`, selectedThread.id),
  ),
});

const chatStore = (
  selectedThread: ThreadSummary,
  detail: ThreadDetail | null,
  detailLoading = false,
  selectedThreadId = selectedThread.id,
) => {
  const selectedAgent = agent("agent", { supportsAttachments: false });
  return {
    bootstrap: null,
    agents: [selectedAgent],
    threads: [selectedThread],
    visibleThreads: [selectedThread],
    selectedAgent,
    selectedThread,
    detail,
    selectedAgentId: selectedAgent.sourceId,
    selectedThreadId,
    loading: false,
    detailLoading,
    connection: "live" as const,
    model: "",
    effort: "",
    createThread: vi.fn(),
    selectThread: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    unarchiveThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    hasOlderMessages: false,
    loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    sendTurn: vi.fn().mockResolvedValue(undefined),
    sendLiveInput: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn(),
    loadFullToolCall: vi.fn().mockResolvedValue(false),
  };
};

const chatTree = () => (
  <WebRuntimeProvider>
    <Chat onOpenAgents={() => undefined} onOpenThreads={() => undefined} />
  </WebRuntimeProvider>
);

describe("Chat conversation viewport", () => {
  it("shows the server-owned current route in the header independently of next-turn controls", () => {
    const selected = thread("thread-a", "agent", {
      trigger: { kind: "cron" },
      runState: {
        id: "turn-1",
        status: "running",
        attribution: {
          requested: { model: "provider:primary", effort: "high" },
          attempted: { model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" },
          disposition: "fallback",
          transitions: [{ from: "provider:primary", to: "provider:fallback", reason: "overloaded" }],
          retries: [],
        },
      },
    });
    storeMock.current = chatStore(selected, chatDetail(selected, 1));

    render(chatTree());

    expect(screen.getByRole("status", { name: "Model fallback" })).toBeVisible();
    expect(screen.getByText("provider:primary → provider:fallback")).toBeVisible();
    expect(screen.queryByText(/overloaded/u)).toBeNull();
  });

  it("recreates the viewport for an async conversation switch without interrupting a current conversation", async () => {
    const firstThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const secondThread = thread("thread-b", "agent", { trigger: { kind: "cron" } });
    storeMock.current = chatStore(firstThread, chatDetail(firstThread, 4));

    const { container, rerender } = render(chatTree());
    const firstViewport = container.querySelector<HTMLElement>(".thread-viewport");
    expect(firstViewport).not.toBeNull();
    await waitFor(() => expect(firstViewport!.scrollTop).toBe(maxScrollTop(firstViewport!)));
    expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeDisabled();

    firstViewport!.scrollTop = 120;
    fireEvent.scroll(firstViewport!);

    storeMock.current = chatStore(firstThread, null, true, secondThread.id);
    rerender(chatTree());

    const secondViewport = container.querySelector<HTMLElement>(".thread-viewport");
    expect(secondViewport).not.toBeNull();
    expect(secondViewport).not.toBe(firstViewport);
    expect(secondViewport!.scrollTop).toBe(0);

    storeMock.current = chatStore(secondThread, chatDetail(secondThread, 4));
    rerender(chatTree());
    await waitFor(() => expect(secondViewport!.scrollTop).toBe(maxScrollTop(secondViewport!)));

    messageRowHeight = 180;
    await act(async () => {
      notifyResizeObservers();
      await Promise.resolve();
    });
    await waitFor(() => expect(secondViewport!.scrollTop).toBe(maxScrollTop(secondViewport!)));

    fireEvent.pointerDown(secondViewport!);
    secondViewport!.scrollTop = 0;
    fireEvent.scroll(secondViewport!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeEnabled());
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo");

    storeMock.current = chatStore(secondThread, chatDetail(secondThread, 5));
    rerender(chatTree());
    await act(async () => {
      notifyResizeObservers();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector<HTMLElement>(".thread-viewport")).toBe(secondViewport);
    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockRestore();
  });
});

describe("Chat conversation actions", () => {
  it("keeps archive in the actions menu and confirms its empty-conversation behavior", async () => {
    const selected = thread("thread-a", "agent");
    const store = chatStore(selected, chatDetail(selected, 0));
    storeMock.current = store;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(chatTree());
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive conversation" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Empty conversations will be permanently removed"));
    expect(store.archiveThread).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("ModelControls", () => {
  beforeEach(() => {
    storeMock.current = {
      model: "",
      effort: "",
      modelOptions: [MODEL],
      effortOptions: ["high"],
      setModel: vi.fn(),
      setEffort: vi.fn(),
      effectiveModel: MODEL,
      effectiveEffort: "high",
      hasRunOverride: false,
      resetRunOverride: vi.fn(),
      selectedThread: null,
      catalogByProvider: {},
      ensureProviderCatalog: vi.fn(),
      selectedAgent: agent("agent", {
        models: [MODEL],
        defaultModel: MODEL,
        defaultEffort: "high",
        modelOptions: {
          [MODEL]: {
            label: "GPT-5.5 Codex",
            reasoning: true,
            effortLevels: ["low", "high"],
            contextWindow: 2_000,
          },
        },
      }),
      detail: null,
    };
  });

  it("shows the advertised label while submitting the canonical model reference", async () => {
    render(<ModelControls />);
    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    const store = storeMock.current as { setModel: ReturnType<typeof vi.fn> };

    // The compact composer trigger names only the resolved model and effort.
    expect(trigger).toHaveTextContent("GPT-5.5 Codex");
    expect(trigger).toHaveTextContent("High");
    expect(trigger).not.toHaveTextContent("Default");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    const option = within(dialog).getByRole("option", { name: /^GPT-5\.5 Codex/u });
    expect(option).toHaveTextContent(MODEL);

    fireEvent.click(option);
    expect(store.setModel).toHaveBeenCalledWith(MODEL);
  });

  it("labels a blank draft with the web default that creation will snapshot", () => {
    const webModel = "provider:web-default";
    storeMock.current = {
      ...storeMock.current,
      effectiveModel: webModel,
      effectiveEffort: "high",
      selectedAgent: agent("agent", {
        models: [MODEL, webModel],
        defaultModel: MODEL,
        defaultEffort: "medium",
        modelOptions: {
          [MODEL]: { label: "Config model", reasoning: true, effortLevels: ["medium", "high"] },
          [webModel]: { label: "Web default", reasoning: true, effortLevels: ["medium", "high"] },
        },
        runSettings: {
          config: { model: MODEL, effort: "medium" },
          override: { model: webModel, effort: "high" },
          effective: {
            model: webModel,
            modelSource: "override",
            effort: "high",
            effortSource: "override",
          },
        },
      }),
    };

    render(<ModelControls />);
    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    expect(trigger).toHaveTextContent("Web default");
    expect(trigger).toHaveTextContent("High");
  });

  it("keeps a catalog-only override and its shared effort controls visible while its lazy row loads", async () => {
    const selectedModel = "anthropic:claude-fable-5";
    storeMock.current = {
      ...storeMock.current,
      model: selectedModel,
      effort: "high",
      hasRunOverride: true,
      selectedAgent: agent("agent", {
        models: [MODEL],
        defaultModel: MODEL,
        defaultEffort: "high",
        providers: [{ id: "anthropic", label: "Anthropic" }],
        modelOptions: {
          [MODEL]: { label: "GPT-5.5 Codex", reasoning: true, effortLevels: ["low", "high"] },
        },
      }),
    };
    const { rerender } = render(<ModelControls />);
    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    expect(trigger).toHaveTextContent(selectedModel);
    expect(trigger).toHaveTextContent("High");
    expect(trigger).not.toHaveTextContent("Default · GPT-5.5 Codex");

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    const effortGroup = within(dialog).getByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(effortGroup).getByRole("radio", { name: "Default · High" })).toBeVisible();
    expect(within(effortGroup).getByRole("radio", { name: "Medium" })).toBeVisible();
    expect(within(effortGroup).getByRole("radio", { name: "Ultra" })).toBeVisible();
    fireEvent.click(within(effortGroup).getByRole("radio", { name: "Medium" }));
    expect((storeMock.current as { setEffort: ReturnType<typeof vi.fn> }).setEffort)
      .toHaveBeenCalledWith("medium");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    storeMock.current = {
      ...storeMock.current,
      catalogByProvider: {
        anthropic: {
          status: "loaded",
          models: [{
            id: "claude-fable-5",
            name: "Claude Fable 5",
            provider: "anthropic",
            providerLabel: "Anthropic",
            reasoning: true,
            effortLevels: ["low", "high"],
          }],
        },
      },
    };
    rerender(<ModelControls />);
    expect(trigger).toHaveTextContent("Claude Fable 5");
    expect(trigger).toHaveTextContent("High");
    expect(trigger).not.toHaveTextContent("Default · GPT-5.5 Codex");
  });

  it("marks a conversation override and offers to clear it", async () => {
    storeMock.current = { ...storeMock.current, model: MODEL, hasRunOverride: true };
    render(<ModelControls />);
    const store = storeMock.current as { resetRunOverride: ReturnType<typeof vi.fn> };

    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    expect(trigger).toHaveTextContent("GPT-5.5 Codex");
    expect(trigger).not.toHaveTextContent("custom");

    // Reset lives in the picker, not the header: it only exists while there is
    // an override to clear, so it must not take permanent room in the bar.
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Reset to agent default/u }));
    expect(store.resetRunOverride).toHaveBeenCalledOnce();
  });

  it("does not offer a reset when the conversation runs on the agent default", () => {
    render(<ModelControls />);

    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    expect(trigger).not.toHaveTextContent("default");
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: /Reset to agent default/u })).toBeNull();
  });

  it("shows only the selected model's exact efforts and hides unspecified cloud grades", async () => {
    const cloud = "claude:claude-fable-5";
    storeMock.current = {
      ...storeMock.current,
      model: MODEL,
      modelOptions: [MODEL, cloud],
      selectedAgent: agent("agent", {
        models: [MODEL, cloud],
        defaultModel: MODEL,
        modelOptions: {
          [MODEL]: { reasoning: true, effortLevels: ["low", "high"] },
          [cloud]: { reasoning: true },
        },
      }),
    };
    const { rerender } = render(<ModelControls />);
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const first = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(first).getByRole("radio", { name: "High" })).toBeVisible();
    expect(within(first).queryByRole("radio", { name: "Ultra" })).not.toBeInTheDocument();

    storeMock.current = { ...storeMock.current, model: cloud };
    rerender(<ModelControls />);
    expect(screen.queryByRole("radiogroup", { name: "Reasoning effort" })).not.toBeInTheDocument();
  });

  it("shows the configured default effort while keeping the explicit choices distinct", async () => {
    render(<ModelControls />);

    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const effortGroup = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(effortGroup).getByRole("radio", { name: "Default · High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(effortGroup).getByRole("radio", { name: "High" }));

    const store = storeMock.current as { setEffort: ReturnType<typeof vi.fn> };
    expect(store.setEffort).toHaveBeenCalledWith("high");
  });

  it("names a provider-selected default without guessing its effort", async () => {
    storeMock.current = {
      ...storeMock.current,
      effectiveEffort: "",
      selectedAgent: agent("agent", {
        models: [MODEL],
        defaultModel: MODEL,
        modelOptions: {
          [MODEL]: {
            reasoning: true,
            effortLevels: ["low", "high"],
          },
        },
      }),
    };
    render(<ModelControls />);

    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const effortGroup = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(effortGroup).getByRole("radio", { name: "Default · Provider" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("renders the configured default through a toggle model's on/off vocabulary", async () => {
    storeMock.current = {
      ...storeMock.current,
      effectiveEffort: "none",
      selectedAgent: agent("agent", {
        models: [MODEL],
        defaultModel: MODEL,
        defaultEffort: "none",
        modelOptions: {
          [MODEL]: {
            reasoning: true,
            reasoningMode: "toggle",
            effortLevels: ["high", "none"],
          },
        },
      }),
    };
    render(<ModelControls />);

    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const effortGroup = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(effortGroup).getByRole("radio", { name: "Default · Off" })).toBeVisible();
    expect(within(effortGroup).getByRole("radio", { name: "On" })).toBeVisible();
    expect(within(effortGroup).getByRole("radio", { name: "Off" })).toBeVisible();
  });

  it("opens the same portaled mobile-safe picker from the slash settings action", async () => {
    const { container } = render(<ModelControls />);

    fireEvent(window, new Event("mono-agent:run-settings"));
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    expect(container).not.toContainElement(dialog);
    expect(within(dialog).getByRole("option", { name: /^GPT-5\.5 Codex/u })).toBeVisible();
    await waitFor(() => expect(dialog).toHaveFocus());
  });

  it("preloads the provider catalog when the slash action opens the picker", async () => {
    // Opening by setting state directly bypasses `onOpenChange`, which is
    // where the header's preload lives. With a single provider the chip row is
    // hidden too, so nothing else would ever fetch a page and the operator was
    // stuck on the shortlist until they reopened the picker from the header.
    const store = storeMock.current as { ensureProviderCatalog: ReturnType<typeof vi.fn> };
    render(<ModelControls />);
    expect(store.ensureProviderCatalog).not.toHaveBeenCalled();

    fireEvent(window, new Event("mono-agent:run-settings"));
    await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    expect(store.ensureProviderCatalog).toHaveBeenCalledWith("pi");
  });

  it("renders exact current context separately from cumulative conversation cost", async () => {
    storeMock.current = {
      ...storeMock.current,
      detail: {
        thread: thread("thread", "agent"),
        messages: [
          {
            id: "message-one",
            threadId: "thread",
            role: "assistant",
            parts: [{
              type: "telemetry",
              event: "usage_update",
              data: {
                model: MODEL,
                tokens: { input: 400, output: 100, cacheRead: 300, cacheCreation: 20 },
                cumulativeUsd: 0.01,
              },
            }, {
              type: "telemetry",
              event: "runtime_telemetry",
              data: {
                kind: "context_usage",
                data: {
                  model: MODEL,
                  contextWindow: 2_000,
                  tokens: { input: 600, cacheRead: 300, cacheCreation: 20, output: 80, total: 1_000 },
                },
              },
            }],
            attachments: [],
            createdAt: "2026-07-17T10:00:00.000Z",
            updatedAt: "2026-07-17T10:00:00.000Z",
            status: "complete",
          },
          {
            id: "message-two",
            threadId: "thread",
            role: "assistant",
            parts: [{
              type: "telemetry",
              event: "usage_update",
              data: {
                model: MODEL,
                tokens: { input: 300, output: 200, cacheRead: 200, cacheCreation: 10 },
                cumulativeUsd: 0.02,
              },
            }],
            attachments: [],
            createdAt: "2026-07-17T10:01:00.000Z",
            updatedAt: "2026-07-17T10:01:00.000Z",
            status: "complete",
          },
        ],
      },
    };
    render(<ModelControls />);

    fireEvent.click(screen.getByRole("button", {
      name: "Context usage: 1k tokens, 50%, $0.03",
    }));
    expect(await screen.findByRole("progressbar", { name: "Context window used" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });

  it("does not borrow selected-model capacity for legacy aggregate telemetry", async () => {
    storeMock.current = {
      ...storeMock.current,
      detail: {
        thread: thread("thread", "agent"),
        messages: [{
          id: "message",
          threadId: "thread",
          role: "assistant",
          parts: [{
            type: "telemetry",
            event: "usage_update",
            data: {
              model: "pi:unknown-provider:failover-model",
              tokens: { input: 900, output: 100 },
            },
          }],
          attachments: [],
          createdAt: "2026-07-17T10:00:00.000Z",
          updatedAt: "2026-07-17T10:00:00.000Z",
          status: "complete",
        }],
      },
    };
    render(<ModelControls />);

    const trigger = screen.getByRole("button", { name: "Context usage: unavailable" });
    expect(trigger).toHaveTextContent("—");
    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(popover).getByText("Exact context usage has not been reported for this conversation.")).toBeVisible();
  });
});

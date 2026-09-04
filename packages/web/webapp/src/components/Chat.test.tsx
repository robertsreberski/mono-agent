import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../test/fixtures";

const MODEL = "pi:openai-codex:gpt-5.5";
const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../console-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../console-store")>();
  return {
    ...actual,
    useConsoleStore: () => storeMock.current,
  };
});

import { CONNECTION_NOTICE_DELAY_MS, ConnectionBanner, ModelControls } from "./Chat";

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
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

    // The trigger names the model a new turn would actually use, and says
    // whether that is the agent default or a choice made here.
    expect(trigger).toHaveTextContent("Default · GPT-5.5 Codex");
    expect(trigger).toHaveTextContent("default");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    const option = within(dialog).getByRole("option", { name: /^GPT-5\.5 Codex/u });
    expect(option).toHaveTextContent(MODEL);

    fireEvent.click(option);
    expect(store.setModel).toHaveBeenCalledWith(MODEL);
  });

  it("marks a conversation override and offers to clear it", async () => {
    storeMock.current = { ...storeMock.current, model: MODEL, hasRunOverride: true };
    render(<ModelControls />);
    const store = storeMock.current as { resetRunOverride: ReturnType<typeof vi.fn> };

    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    expect(trigger).toHaveTextContent("custom");

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
    expect(trigger).toHaveTextContent("default");
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
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Search models" })).toHaveFocus());
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

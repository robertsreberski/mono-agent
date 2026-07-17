import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { ModelControls } from "./Chat";

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

describe("ModelControls", () => {
  beforeEach(() => {
    storeMock.current = {
      model: "",
      effort: "",
      modelOptions: [MODEL],
      effortOptions: ["high"],
      setModel: vi.fn(),
      setEffort: vi.fn(),
      selectedThread: null,
      selectedAgent: agent("agent", {
        models: [MODEL],
        defaultModel: MODEL,
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

    expect(trigger).toHaveTextContent("Automatic model");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    const option = within(dialog).getByRole("option", { name: /^GPT-5\.5 Codex/u });
    expect(option).toHaveTextContent(MODEL);

    fireEvent.click(option);
    expect(store.setModel).toHaveBeenCalledWith(MODEL);
  });

  it("keeps automatic model and effort choices visibly distinct", async () => {
    render(<ModelControls />);

    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const effortGroup = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(effortGroup).getByRole("radio", { name: "Automatic" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(effortGroup).getByRole("radio", { name: "High" }));

    const store = storeMock.current as { setEffort: ReturnType<typeof vi.fn> };
    expect(store.setEffort).toHaveBeenCalledWith("high");
  });

  it("opens the same portaled mobile-safe picker from the slash settings action", async () => {
    const { container } = render(<ModelControls />);

    fireEvent(window, new Event("mono-agent:run-settings"));
    const dialog = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    expect(container).not.toContainElement(dialog);
    expect(within(dialog).getByRole("option", { name: /^GPT-5\.5 Codex/u })).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Search models" })).toHaveFocus());
  });

  it("renders cumulative conversation usage against the advertised capacity", async () => {
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

  it("does not borrow selected-model capacity when telemetry names an unknown failover", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 1k tokens" }));
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

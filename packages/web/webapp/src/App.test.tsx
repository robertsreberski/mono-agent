import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RAIL_STORAGE_KEY } from "./agent-rail-layout";

const storeMock = vi.hoisted(() => ({
  loading: false,
  bootstrap: {},
  error: null,
  actionError: null,
  clearActionError: vi.fn(),
  agents: [],
  selectedAgent: null,
  selectedThread: null,
  showArchived: false,
  createThread: vi.fn(),
  renameThread: vi.fn(),
  setAgentPinned: vi.fn(),
  setShowArchived: vi.fn(),
  selectAgent: vi.fn(),
}));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock,
}));

vi.mock("./components/AgentRail", () => ({
  AgentRail: ({ expanded }: { readonly expanded?: boolean }) => (
    <div data-testid="agent-rail" data-expanded={String(Boolean(expanded))} />
  ),
  BrandMark: () => <span>mono-agent</span>,
  MobileAgentPicker: () => <div>Agents</div>,
}));

vi.mock("./components/Chat", () => ({
  Chat: () => <main>Chat</main>,
}));

vi.mock("./components/ThreadSidebar", () => ({
  ThreadSidebar: () => <aside>Threads</aside>,
}));

import { App } from "./App";

class PointerEventStub extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

beforeAll(() => {
  vi.stubGlobal("PointerEvent", PointerEventStub);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => true),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
});

beforeEach(() => {
  localStorage.clear();
  document.body.classList.remove("is-resizing-agent-rail");
});

describe("App agent sidebar resize control", () => {
  it("supports keyboard resizing, expansion, and persisted toggle state", () => {
    render(<App />);
    const separator = screen.getByRole("separator", { name: "Resize agent sidebar" });

    expect(separator).toHaveAttribute("aria-valuenow", "72");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "88");
    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("88");

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "288");
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "true");

    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "72");
    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("72");
  });

  it("tracks pointer movement and commits the final width", () => {
    render(<App />);
    const separator = screen.getByRole("separator", { name: "Resize agent sidebar" });

    fireEvent.pointerDown(separator, { pointerId: 7, button: 0, clientX: 100 });
    expect(document.body).toHaveClass("is-resizing-agent-rail");
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 200 });
    expect(separator).toHaveAttribute("aria-valuenow", "172");
    fireEvent.pointerUp(separator, { pointerId: 7, button: 0, clientX: 200 });

    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("172");
    expect(document.body).not.toHaveClass("is-resizing-agent-rail");
  });
});

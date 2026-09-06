import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RAIL_STORAGE_KEY } from "./agent-rail-layout";
import { readDataModeSetting, resetDataModeSession, writeDataModeSetting } from "./data-mode";
import { recordDataUsage, resetDataUsage } from "./data-usage";
import {
  registerServiceWorkerUpdates,
  resetServiceWorkerUpdates,
} from "./service-worker-update";
import "./styles.css";

const storeMock = vi.hoisted(() => ({
  loading: false,
  bootstrap: { console: { hostName: "console-host", theme: "ocean" as const } },
  error: null,
  actionError: null,
  clearActionError: vi.fn(),
  agents: [],
  visibleAgents: [],
  threads: [] as readonly { readonly runState: { readonly status: string } }[],
  selectedAgent: null,
  selectedThread: null as { readonly runState: { readonly status: string } } | null,
  showArchived: false,
  showOfflineAgents: false,
  hiddenOfflineAgentCount: 0,
  createThread: vi.fn(),
  renameThread: vi.fn(),
  setAgentPinned: vi.fn(),
  setAgentRunDefaults: vi.fn(),
  clearAgentRunDefaults: vi.fn(),
  catalogByProvider: {},
  ensureProviderCatalog: vi.fn(),
  setShowArchived: vi.fn(),
  setShowOfflineAgents: vi.fn(),
  selectAgent: vi.fn(),
  clearCachedData: vi.fn(async () => undefined),
  clearError: vi.fn(),
  retry: vi.fn(),
  hasServerSnapshot: true,
}));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock,
}));

vi.mock("./components/AgentRail", () => ({
  AgentRail: ({
    expanded,
    onToggleExpanded,
  }: {
    readonly expanded?: boolean;
    readonly onToggleExpanded?: () => void;
  }) => (
    <div data-testid="agent-rail" data-expanded={String(Boolean(expanded))}>
      <button type="button" onClick={onToggleExpanded}>Toggle agent sidebar</button>
    </div>
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

beforeEach(() => {
  localStorage.clear();
  document.title = "mono-agent";
});

describe("App agent sidebar toggle", () => {
  it("toggles between the two fixed states and persists the result", () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Toggle agent sidebar" });

    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "false");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "true");
    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("240");

    fireEvent.click(toggle);
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "false");
    expect(localStorage.getItem(AGENT_RAIL_STORAGE_KEY)).toBe("72");
  });

  it("treats a legacy expanded width as the expanded state", () => {
    localStorage.setItem(AGENT_RAIL_STORAGE_KEY, "204");
    render(<App />);
    expect(screen.getByTestId("agent-rail")).toHaveAttribute("data-expanded", "true");
  });
});

describe("App viewport layout", () => {
  it("constrains the grid row so long conversation lists cannot push the composer off-screen", () => {
    const { container } = render(<App />);
    const shell = container.querySelector<HTMLElement>(".app-shell");

    expect(shell).not.toBeNull();
    expect(getComputedStyle(shell!).gridTemplateRows).toBe("minmax(0, 1fr)");
  });

  it("applies the host identity and selected theme to browser chrome", () => {
    render(<App />);

    expect(document.title).toBe("console-host · mono-agent");
    expect(document.documentElement).toHaveAttribute("data-console-theme", "ocean");
  });
});

describe("App snapshot failure", () => {
  afterEach(() => {
    storeMock.error = null;
    storeMock.hasServerSnapshot = true;
  });

  it("keeps a failed snapshot in front of the operator, behind what the device restored", () => {
    // The console now draws before anything is asked for, so `error` is no
    // longer only the fatal screen's business: without a banner, a dead server
    // behind a restored listing shows as stale content and a small pill.
    storeMock.error = "The web console request failed." as unknown as null;
    storeMock.hasServerSnapshot = false;
    render(<App />);

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("The web console request failed.");
    expect(banner).toHaveTextContent("Showing what this browser had stored.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(storeMock.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(storeMock.clearError).toHaveBeenCalledTimes(1);
  });
});

describe("App command palette", () => {
  it("gives the operator a way to clear what this browser has stored", async () => {
    // The console keeps recent conversations on the device now, so there has to
    // be one action that takes them off it -- and it has to say that it did.
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    fireEvent.click(screen.getByRole("option", { name: "Clear cached data" }));

    await waitFor(() => expect(storeMock.clearCachedData).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Cleared the conversations this browser had stored.");
  });
});

describe("App data mode", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
    resetDataUsage();
    // The module remembers a once-per-install offer in memory as well as in
    // storage, for a device that refuses storage -- so a test that made one has
    // to put that back too.
    resetDataModeSession();
    localStorage.clear();
    storeMock.loading = false;
    storeMock.bootstrap = { console: { hostName: "console-host", theme: "ocean" as const } };
  });

  const standalone = (matches: boolean): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: matches && query.includes("standalone"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  };

  it("cycles the mode from the palette and says what the session has cost", async () => {
    recordDataUsage(2_048);
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const action = screen.getByRole("option", { name: /^Data: Auto · Full/u });
    // Estimated here, and marked as such: no resource observer is installed in
    // a test, exactly as none exists on a browser without resource timing.
    expect(action).toHaveTextContent("~2 KiB");
    fireEvent.click(action);

    await waitFor(() => { expect(readDataModeSetting()).toBe("lean"); });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("option", { name: /^Data: Lean/u })).toBeVisible();
  });

  it("offers Lean once to a home-screen install that cannot read the network", async () => {
    // iOS Safari reports no connection at all, so Auto can never resolve to
    // Lean there. Rather than guessing, the console says so once.
    standalone(true);
    const first = render(<App />);

    const offer = await screen.findByRole("status");
    expect(offer).toHaveTextContent("Auto stays on Full");
    fireEvent.click(screen.getByRole("button", { name: "Use Lean" }));
    expect(readDataModeSetting()).toBe("lean");
    first.unmount();

    // Offered once, and never again — including on the next visit.
    writeDataModeSetting("auto");
    render(<App />);
    expect(screen.queryByRole("button", { name: "Use Lean" })).toBeNull();
  });

  it("never offers Lean to a console running in an ordinary browser tab", () => {
    standalone(false);
    render(<App />);
    expect(screen.queryByRole("button", { name: "Use Lean" })).toBeNull();
  });

  it("waits for a shell that can actually show the offer", async () => {
    // It is offered ONCE per install, and the two pre-shell states return
    // before any toast is rendered -- so an offer made while the console was
    // still discovering agents was marked as offered, never seen, and never
    // made again.
    standalone(true);
    storeMock.loading = true;
    storeMock.bootstrap = null as unknown as (typeof storeMock)["bootstrap"];
    const first = render(<App />);
    expect(screen.queryByRole("button", { name: "Use Lean" })).toBeNull();
    // The visit ends there -- the operator put the phone down, the OS reclaimed
    // the PWA. Nothing was shown, so nothing may have been spent.
    first.unmount();

    storeMock.loading = false;
    storeMock.bootstrap = { console: { hostName: "console-host", theme: "ocean" as const } };
    render(<App />);

    expect(await screen.findByRole("button", { name: "Use Lean" })).toBeVisible();
  });

  it("takes the offer down once the operator has answered it", async () => {
    // The offer is about Auto. Setting the mode anywhere -- the palette, the
    // sidebar footer, another tab -- answers it, and a notice still on screen
    // after that is telling the operator about a decision they have made.
    standalone(true);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Use Lean" })).toBeVisible();

    await act(async () => { writeDataModeSetting("full"); });

    expect(screen.queryByRole("button", { name: "Use Lean" })).toBeNull();
  });
});

describe("App service worker update", () => {
  const visibility = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  afterEach(() => {
    resetServiceWorkerUpdates();
    Reflect.deleteProperty(document, "visibilityState");
    storeMock.threads = [];
    storeMock.selectedThread = null;
  });

  /** Registers, then plays the worker's "a new build is staged" callback. */
  const stageUpdate = (): ReturnType<typeof vi.fn> => {
    const apply = vi.fn(async () => undefined);
    let needRefresh = (): void => undefined;
    registerServiceWorkerUpdates((options) => {
      needRefresh = options.onNeedRefresh ?? needRefresh;
      return apply;
    });
    needRefresh();
    return apply;
  };

  const runningThread = {
    id: "thread-running",
    runState: { status: "running" },
  } as unknown as (typeof storeMock)["selectedThread"];

  it("does not take the page from under a running turn", () => {
    storeMock.threads = [runningThread] as unknown as (typeof storeMock)["threads"];
    const apply = stageUpdate();
    render(<App />);

    visibility("visible");

    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("new version");
  });

  it("takes the staged build the moment an idle console comes back", () => {
    const apply = stageUpdate();
    render(<App />);

    visibility("hidden");
    expect(apply).not.toHaveBeenCalled();

    visibility("visible");

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("reloads on the operator's own word, whatever is running", () => {
    storeMock.selectedThread = runningThread;
    const apply = stageUpdate();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("keeps the deferral armed after the notice is dismissed", () => {
    storeMock.threads = [runningThread] as unknown as (typeof storeMock)["threads"];
    const apply = stageUpdate();
    const view = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("button", { name: "Reload now" })).toBeNull();

    storeMock.threads = [];
    view.rerender(<App />);
    visibility("visible");
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

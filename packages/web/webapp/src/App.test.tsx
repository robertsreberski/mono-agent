import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteComposerAttachments, resetComposerDraft, writeComposerDraft } from "./composer-draft";
import { readDataModeSetting, resetDataModeSession, writeDataModeSetting } from "./data-mode";
import { recordDataUsage, resetDataUsage } from "./data-usage";
import {
  registerServiceWorkerUpdates,
  resetServiceWorkerUpdates,
} from "./service-worker-update";
import { agent } from "./test/fixtures";
import "./styles.css";

const storeMock = vi.hoisted(() => ({
  loading: false,
  bootstrap: { console: { hostName: "console-host", displayName: "console-host", theme: "ocean" as const } },
  error: null,
  actionError: null,
  clearActionError: vi.fn(),
  agents: [],
  visibleAgents: [],
  selectedAgent: null,
  selectionLoading: false,
  selectionError: null,
  selectedThread: null,
  hasRunningThread: false,
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
  retrySelection: vi.fn(),
  hasServerSnapshot: true,
}));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock,
}));

vi.mock("./components/BrandMark", () => ({
  BrandMark: () => <span>mono-agent</span>,
}));

vi.mock("./components/Chat", () => ({
  Chat: ({ onBack }: { readonly onBack: () => void }) => (
    <main>
      Chat
      <button type="button" onClick={onBack}>Back to dashboard</button>
    </main>
  ),
}));

vi.mock("./components/dashboard/Dashboard", () => ({
  Dashboard: ({ onNavigate }: { readonly onNavigate?: () => void }) => (
    <div data-testid="dashboard">
      <button type="button" onClick={onNavigate}>Open a conversation</button>
    </div>
  ),
}));

import { App } from "./App";

beforeEach(() => {
  localStorage.clear();
  document.title = "mono-agent";
  storeMock.selectionLoading = false;
  storeMock.selectionError = null;
  storeMock.selectedAgent = null;
  storeMock.createThread.mockReset().mockResolvedValue(undefined);
});

describe("App new-conversation shortcut", () => {
  afterEach(() => {
    storeMock.selectedAgent = null;
    storeMock.selectionLoading = false;
    storeMock.selectionError = null;
  });

  it("does not bypass an unresolved selection", () => {
    storeMock.selectedAgent = agent("beta", { label: "Beta" }) as never;
    storeMock.selectionLoading = true;
    render(<App />);

    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true });

    expect(storeMock.createThread).not.toHaveBeenCalled();
  });

  it("does not bypass a failed selection", () => {
    storeMock.selectedAgent = agent("beta", { label: "Beta" }) as never;
    storeMock.selectionError = "bucket unavailable" as never;
    render(<App />);

    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true });

    expect(storeMock.createThread).not.toHaveBeenCalled();
  });

  it("still opens a conversation once selection has settled", () => {
    storeMock.selectedAgent = agent("beta", { label: "Beta" }) as never;
    render(<App />);

    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true });

    expect(storeMock.createThread).toHaveBeenCalledTimes(1);
  });
});

/** What the retired agent rail wrote, and what a returning browser still has. */
const LEGACY_RAIL_WIDTH_KEY = "mono-agent.web.agent-rail-width";

describe("App viewport layout", () => {
  it("gives the desktop shell one navigation column and no width preference", () => {
    // There is one navigation surface now, at one width. Nothing reads or
    // writes a stored rail width any more, and a browser that has one is not
    // owed a migration -- only silence.
    localStorage.setItem(LEGACY_RAIL_WIDTH_KEY, "204");
    const { container } = render(<App />);
    const shell = container.querySelector<HTMLElement>(".app-shell");

    expect(shell).not.toBeNull();
    expect(getComputedStyle(shell!).gridTemplateColumns).toBe("340px minmax(0, 1fr)");
    expect(screen.getAllByTestId("dashboard")).toHaveLength(1);
    expect(localStorage.getItem(LEGACY_RAIL_WIDTH_KEY)).toBe("204");
  });

  it("is a navigation region on desktop rather than a modal drawer", () => {
    const { container } = render(<App />);

    const panel = container.querySelector<HTMLElement>(".dashboard-panel");
    expect(panel).toHaveAttribute("role", "navigation");
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(panel).not.toHaveAttribute("inert");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

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

describe("App mobile screens", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 900px)",
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  const swipe = (
    target: Element,
    start: { readonly x: number; readonly y: number },
    end: { readonly x: number; readonly y: number },
  ) => {
    fireEvent.touchStart(target, {
      touches: [{ clientX: start.x, clientY: start.y }],
    });
    fireEvent.touchEnd(target, {
      touches: [],
      changedTouches: [{ clientX: end.x, clientY: end.y }],
    });
  };

  const panel = (container: HTMLElement): HTMLElement => {
    const found = container.querySelector<HTMLElement>(".dashboard-panel");
    if (!found) throw new Error("Expected one dashboard panel");
    return found;
  };
  const chat = (container: HTMLElement): HTMLElement => {
    const found = container.querySelector<HTMLElement>(".chat-region");
    if (!found) throw new Error("Expected one chat region");
    return found;
  };
  const openConversation = () => fireEvent.click(screen.getByRole("button", { name: "Open a conversation" }));

  it("lands on the Dashboard, with the conversation pushed away and out of reach", () => {
    const { container } = render(<App />);

    // A screen, not a drawer: a navigation region and nothing modal.
    expect(panel(container)).toHaveAttribute("role", "navigation");
    expect(panel(container)).toHaveAttribute("aria-label", "Dashboard");
    expect(panel(container)).not.toHaveAttribute("aria-modal");
    expect(panel(container)).not.toHaveAttribute("aria-hidden");
    expect(panel(container)).not.toHaveAttribute("inert");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chat(container)).not.toHaveClass("is-open");
    expect(chat(container)).toHaveAttribute("aria-hidden", "true");
    expect(chat(container)).toHaveAttribute("inert");
  });

  it("lands on the conversation when the address names a cron channel", () => {
    window.history.replaceState(null, "", "/agents/alpha/cron/nightly");
    const { container } = render(<App />);

    expect(chat(container)).toHaveClass("is-open");
    expect(panel(container)).toHaveAttribute("inert");
  });

  it("pushes the conversation on a navigation action and pops it from the header", () => {
    const { container } = render(<App />);

    openConversation();
    expect(chat(container)).toHaveClass("is-open");
    expect(chat(container)).not.toHaveAttribute("inert");
    expect(panel(container)).toHaveAttribute("aria-hidden", "true");
    expect(panel(container)).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));
    expect(chat(container)).not.toHaveClass("is-open");
    expect(panel(container)).not.toHaveAttribute("inert");
  });

  it("pops the conversation on Escape", () => {
    const { container } = render(<App />);
    openConversation();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(chat(container)).not.toHaveClass("is-open");
  });

  it("pops the conversation after a deliberate right swipe across it", () => {
    const { container } = render(<App />);
    openConversation();
    const shell = container.querySelector(".app-shell");
    expect(shell).not.toBeNull();

    swipe(shell!, { x: 180, y: 240 }, { x: 256, y: 250 });

    expect(chat(container)).not.toHaveClass("is-open");
  });

  it("ignores a short drag or a vertical scroll", () => {
    const { container } = render(<App />);
    openConversation();
    const shell = container.querySelector(".app-shell");
    expect(shell).not.toBeNull();

    swipe(shell!, { x: 180, y: 240 }, { x: 243, y: 245 });
    swipe(shell!, { x: 180, y: 240 }, { x: 250, y: 320 });

    expect(chat(container)).toHaveClass("is-open");
  });

  it("does not compete with interactive controls", () => {
    const { container } = render(<App />);
    openConversation();
    const back = screen.getByRole("button", { name: "Back to dashboard" });

    swipe(back, { x: 12, y: 30 }, { x: 100, y: 32 });

    expect(chat(container)).toHaveClass("is-open");
  });

  it("pops from ordinary transcript text", () => {
    const { container } = render(<App />);
    openConversation();
    const shell = container.querySelector(".app-shell");
    expect(shell).not.toBeNull();

    const message = document.createElement("div");
    const messageContent = document.createElement("p");
    messageContent.textContent = "Swipe across this response";
    message.className = "message";
    message.append(messageContent);
    shell!.append(message);
    swipe(messageContent, { x: 40, y: 200 }, { x: 130, y: 204 });

    expect(chat(container)).not.toHaveClass("is-open");
  });

  it("leaves active text selections and native horizontal scrollers in control", () => {
    const { container } = render(<App />);
    openConversation();
    const shell = container.querySelector(".app-shell");
    expect(shell).not.toBeNull();

    // The pushed screen took focus; jsdom collapses a range added while a
    // focusable element holds it, which no browser does, so let go first.
    (document.activeElement as HTMLElement | null)?.blur();
    const selected = document.createElement("p");
    selected.textContent = "Selected response text";
    shell!.append(selected);
    const range = document.createRange();
    range.selectNodeContents(selected);
    window.getSelection()?.addRange(range);
    swipe(selected, { x: 40, y: 200 }, { x: 130, y: 204 });
    window.getSelection()?.removeAllRanges();
    expect(chat(container)).toHaveClass("is-open");

    const scroller = document.createElement("div");
    const scrollContent = document.createElement("span");
    scroller.style.overflowX = "auto";
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 240 },
    });
    scroller.append(scrollContent);
    shell!.append(scroller);
    swipe(scrollContent, { x: 40, y: 240 }, { x: 130, y: 244 });

    expect(chat(container)).toHaveClass("is-open");
  });

  it("owns no gesture on the entrance screen, so its strip keeps every swipe", () => {
    // The agent strip is a horizontal scroller and the lists scroll; a swipe
    // on the Dashboard is theirs. Only the pushed conversation has a back.
    const { container } = render(<App />);
    const shell = container.querySelector(".app-shell");
    expect(shell).not.toBeNull();

    swipe(panel(container), { x: 220, y: 240 }, { x: 140, y: 245 });
    swipe(panel(container), { x: 140, y: 240 }, { x: 220, y: 245 });

    expect(chat(container)).not.toHaveClass("is-open");
    expect(panel(container)).not.toHaveAttribute("inert");
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
  it("disables new conversation while the current selection has failed", () => {
    storeMock.selectedAgent = agent("beta", { label: "Beta" }) as never;
    storeMock.selectionError = "bucket unavailable" as never;
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(screen.getByRole("option", { name: /New conversation/iu })).toBeDisabled();
  });

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
    storeMock.bootstrap = { console: { hostName: "console-host", displayName: "console-host", theme: "ocean" as const } };
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
    storeMock.bootstrap = { console: { hostName: "console-host", displayName: "console-host", theme: "ocean" as const } };
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
    resetComposerDraft();
    Reflect.deleteProperty(document, "visibilityState");
    storeMock.hasRunningThread = false;
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

  it("does not take the page from under a turn this tab is watching", () => {
    // ANY held conversation, not the listed ones: the sidebar shows one agent's
    // one bucket, and a turn running on another agent -- or past the listed
    // page -- is still one whose stream this reload would drop.
    storeMock.hasRunningThread = true;
    const apply = stageUpdate();
    render(<App />);

    visibility("visible");

    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("new version");
  });

  it("does not throw away composer content nothing puts back", () => {
    // Typed text is retained on the device and comes back after the reload, so
    // it must NOT hold a build back: a draft forgotten in one conversation would
    // otherwise pin this console to an old shell for as long as it sat there.
    // Staged attachments are the opposite — their bytes live in the assistant-ui
    // runtime alone, and a reload is the end of them.
    writeComposerDraft("agent", "thread", "unsent");
    noteComposerAttachments(true);
    const apply = stageUpdate();
    render(<App />);

    visibility("visible");
    expect(apply).not.toHaveBeenCalled();

    // The attachment is gone; the text stays, and no longer defers anything.
    noteComposerAttachments(false);
    visibility("hidden");
    visibility("visible");
    expect(apply).toHaveBeenCalledTimes(1);
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
    storeMock.hasRunningThread = true;
    writeComposerDraft("agent", "thread", "unsent");
    const apply = stageUpdate();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("keeps the deferral armed after the notice is dismissed", () => {
    storeMock.hasRunningThread = true;
    const apply = stageUpdate();
    const view = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("button", { name: "Reload now" })).toBeNull();

    storeMock.hasRunningThread = false;
    view.rerender(<App />);
    visibility("visible");
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

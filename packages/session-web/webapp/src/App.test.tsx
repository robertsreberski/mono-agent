// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RecorderStore } from "./lib/store";
import { dateStr } from "./lib/format";
import type { Session, WebInstance } from "./lib/types";
import { App } from "./App";

const useRecorderMock = vi.hoisted(() => vi.fn());
const apiMocks = vi.hoisted(() => ({
  saveAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

vi.mock("./lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/store")>();
  return { ...actual, useRecorder: useRecorderMock };
});

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return { ...actual, ...apiMocks };
});

vi.mock("./lib/useIsMobile", () => ({ useIsMobile: () => false }));

const appSession: Session = {
  id: "app-run",
  conversationId: "cron:daily",
  cwd: "/agents/alpha",
  instance: "Alpha",
  sourceId: "agent-a",
  source: "cron",
  title: "Daily briefing",
  instr: "Prepare the briefing",
  startTs: "2026-07-06T08:00:00.000Z",
  durMs: 2_000,
  outcome: "notified",
  hasRecall: false,
  finalText: "Briefing ready",
  status: "done",
  totals: { asst: 1, tcalls: 1, think: 1, tokIn: 50, tokOut: 25, tokCache: 0, cost: 0.02, steps: 2 },
  toolCounts: { read: 1 },
  steps: [],
};

const appInstance: WebInstance = {
  sourceId: "agent-a",
  label: "Alpha",
  cwd: "/agents/alpha",
  artifactDir: "/agents/alpha/.mono-agent",
  health: "running",
  liveConnected: true,
  counts: { runs: 1 },
  timeZone: "UTC",
};

function recorderStore(): RecorderStore {
  return {
    sessions: [appSession],
    instances: [appInstance],
    status: "fixture",
    canLoadOlder: false,
    loadingOlder: false,
    canLoadOlderFor: () => false,
    loadingOlderFor: () => false,
    historyErrorFor: () => undefined,
    detailStatus: {},
    loadOlder: vi.fn(),
    ensureDetail: vi.fn(),
    retryDetail: vi.fn(),
    reload: vi.fn(),
  };
}

beforeEach(() => {
  useRecorderMock.mockReturnValue(recorderStore());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App", () => {
  test("renders recorder sessions by day and switches between top-level views", () => {
    render(<App />);

    const dayLabel = dateStr(appSession.startTs, "UTC");
    const dayGroup = screen.getByRole("region", { name: dayLabel });
    expect(within(dayGroup).getByRole("button", { name: /Open run: Daily briefing/ })).toBeTruthy();
    expect(screen.getByLabelText("No backend reachable — showing bundled demo data")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Instances" }));
    expect(screen.getByRole("heading", { name: "Agents on this machine" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: dayLabel })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByRole("region", { name: dayLabel })).toBeTruthy();
  });

  test("saves a bearer token and reloads after a 401 authentication error", () => {
    const store = recorderStore();
    useRecorderMock.mockReturnValue({
      ...store,
      status: "error",
      error: "/api/instances -> 401",
    });
    render(<App />);

    expect(screen.getByText("Authentication required")).toBeTruthy();
    expect(screen.getByText("Enter the session-web token.")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Session-web bearer token" });
    fireEvent.change(input, { target: { value: "replacement-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(apiMocks.saveAuthToken).toHaveBeenCalledOnce();
    expect(apiMocks.saveAuthToken).toHaveBeenCalledWith("replacement-token");
    expect(apiMocks.clearAuthToken).not.toHaveBeenCalled();
    expect(store.reload).toHaveBeenCalledOnce();
  });

  test("clears the bearer token, empties the input, and reloads after a 403 authentication error", () => {
    const store = recorderStore();
    useRecorderMock.mockReturnValue({ ...store, status: "error", error: "403 Forbidden" });
    render(<App />);

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Session-web bearer token" });
    fireEvent.change(input, { target: { value: "stale-token" } });
    expect(input.value).toBe("stale-token");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(apiMocks.clearAuthToken).toHaveBeenCalledOnce();
    expect(apiMocks.saveAuthToken).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(store.reload).toHaveBeenCalledOnce();
  });
});

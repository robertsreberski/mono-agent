// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { dateStr } from "../lib/format";
import { sessionStoreKey } from "../lib/store";
import type { Session, WebInstance } from "../lib/types";
import { ListView } from "./ListView";

const baseSession: Session = {
  id: "run-1",
  conversationId: "telegram:42",
  cwd: "/agents/alpha",
  instance: "Alpha",
  sourceId: "agent-a",
  source: "telegram",
  title: "Run",
  instr: "Run",
  startTs: "2026-07-06T22:30:00.000Z",
  durMs: 1_000,
  outcome: "notified",
  hasRecall: false,
  finalText: "done",
  status: "done",
  totals: { asst: 1, tcalls: 0, think: 0, tokIn: 12, tokOut: 8, tokCache: 0, cost: 0.01, steps: 1 },
  toolCounts: {},
  steps: [],
};

const instance: WebInstance = {
  sourceId: "agent-a",
  label: "Alpha",
  cwd: "/agents/alpha",
  artifactDir: "/agents/alpha/.mono-agent",
  health: "running",
  liveConnected: true,
  counts: { runs: 3 },
  timeZone: "UTC",
};

function session(overrides: Partial<Session>): Session {
  return {
    ...baseSession,
    ...overrides,
    totals: { ...baseSession.totals, ...overrides.totals },
  };
}

afterEach(cleanup);

describe("ListView", () => {
  test("renders conversation lanes inside their actual day groups and opens a run", () => {
    const onOpen = vi.fn();
    const newer = session({
      id: "newer",
      title: "New reply",
      conversationId: "telegram:42#2026-07-06",
      providerSessionId: "provider-b",
      startTs: "2026-07-06T22:30:00.000Z",
    });
    const older = session({
      id: "older",
      title: "Earlier reply",
      conversationId: "telegram:42#2026-07-06",
      providerSessionId: "provider-a",
      startTs: "2026-07-06T21:45:00.000Z",
    });
    const previousDay = session({
      id: "previous-day",
      title: "Yesterday's run",
      conversationId: "telegram:99",
      providerSessionId: "provider-z",
      startTs: "2026-07-05T10:00:00.000Z",
    });

    render(
      <ListView
        sessions={[newer, older, previousDay]}
        instances={[instance]}
        excludedChannels={new Set()}
        fOut="all"
        fInstance="all"
        setExcludedChannels={vi.fn()}
        setFOut={vi.fn()}
        setFInstance={vi.fn()}
        onOpen={onOpen}
        canLoadOlder={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
      />,
    );

    const currentDayLabel = dateStr(newer.startTs, "UTC");
    const previousDayLabel = dateStr(previousDay.startTs, "UTC");
    expect(currentDayLabel).not.toBe(previousDayLabel);

    const currentDay = screen.getByRole("region", { name: currentDayLabel });
    const priorDay = screen.getByRole("region", { name: previousDayLabel });
    expect(within(currentDay).getByText("telegram:42")).toBeTruthy();
    expect(within(currentDay).getByRole("button", { name: /Open run: New reply/ })).toBeTruthy();
    expect(within(currentDay).getByRole("button", { name: /Open run: Earlier reply/ })).toBeTruthy();
    expect(within(priorDay).getByRole("button", { name: /Open run: Yesterday's run/ })).toBeTruthy();
    expect(within(currentDay).getByText("provider session provider-b -> provider-a")).toBeTruthy();

    fireEvent.click(within(currentDay).getByRole("button", { name: /Open run: New reply/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(sessionStoreKey(newer));
  });

  test("wires the history control and reports an empty result", () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(
      <ListView
        sessions={[]}
        instances={[]}
        excludedChannels={new Set()}
        fOut="all"
        fInstance="all"
        setExcludedChannels={vi.fn()}
        setFOut={vi.fn()}
        setFInstance={vi.fn()}
        onOpen={vi.fn()}
        canLoadOlder={false}
        loadingOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );

    expect(screen.getByText("No runs recorded yet.")).toBeTruthy();

    rerender(
      <ListView
        sessions={[]}
        instances={[]}
        excludedChannels={new Set()}
        fOut="all"
        fInstance="all"
        setExcludedChannels={vi.fn()}
        setFOut={vi.fn()}
        setFInstance={vi.fn()}
        onOpen={vi.fn()}
        canLoadOlder
        loadingOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(onLoadOlder).toHaveBeenCalledOnce();
    expect(screen.getByText("No loaded sessions match this filter.")).toBeTruthy();
  });
});

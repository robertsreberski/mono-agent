import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import {
  agent,
  memoryAvailability,
  memoryCapability,
  memoryDetail,
  memoryGraph,
  memoryOverview,
  memoryRecord,
} from "../test/fixtures";
import type {
  MemoryAvailability,
  MemoryMutationAdmission,
  MemoryOperation,
  MemoryRecordDetail,
} from "../types";

const apiMock = vi.hoisted(() => ({
  memoryOverview: vi.fn(),
  memoryRecords: vi.fn(),
  memoryRecord: vi.fn(),
  memoryGraph: vi.fn(),
  memoryOperation: vi.fn(),
  editMemoryRecord: vi.fn(),
  forgetMemoryRecord: vi.fn(),
  restoreMemoryRecord: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

vi.mock("../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { MemoryWorkspace } from "./MemoryWorkspace";

const storageStub: Storage = {
  length: 0,
  clear: vi.fn(),
  getItem: vi.fn(() => null),
  key: vi.fn(() => null),
  removeItem: vi.fn(),
  setItem: vi.fn(),
};

beforeAll(() => {
  // Node 25 exposes an unusable process-level localStorage unless a backing file
  // is configured. This component does not use storage, so give test cleanup a
  // deliberately inert implementation.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storageStub,
  });
});

const succeededOperation = (
  action: MemoryOperation["action"],
  recordId: string,
  resultRecordId?: string,
): MemoryOperation => ({
  id: `${action}-operation`,
  action,
  recordId,
  status: "succeeded",
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:01.000Z",
  ...(resultRecordId === undefined ? {} : { resultRecordId }),
});

const queued = (operation: MemoryOperation): MemoryMutationAdmission => ({
  kind: "queued",
  operation,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const setLiveSource = (sourceId = "alpha") => {
  const agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })];
  storeMock.current = {
    workspaceRoute: { kind: "memory", sourceId },
    agents,
    visibleAgents: agents,
    selectedAgentId: sourceId,
    bootstrap: { console: { hostName: "Test console" } },
    connection: "live",
    hiddenOfflineAgentCount: 0,
    showOfflineAgents: false,
    openConversationIndex: vi.fn(),
    selectAgent: vi.fn(),
    setAgentPinned: vi.fn(async () => undefined),
    setShowOfflineAgents: vi.fn(),
  };
};

const openRecord = async (
  record = memoryRecord("record-one"),
  detailForId: (recordId: string) => MemoryRecordDetail = (recordId) =>
    memoryDetail(recordId === record.id ? record : memoryRecord(recordId)),
) => {
  apiMock.memoryRecords.mockResolvedValue({ records: [record] });
  apiMock.memoryRecord.mockImplementation(async (_sourceId: string, recordId: string) =>
    detailForId(recordId));

  fireEvent.click(screen.getByRole("tab", { name: "Records" }));
  const title = await screen.findByText(record.text);
  fireEvent.click(title.closest("button")!);
  return await screen.findByRole("article", { name: "Memory record detail" });
};

beforeEach(() => {
  vi.clearAllMocks();
  setLiveSource();
  apiMock.memoryOverview.mockResolvedValue(memoryAvailability());
  apiMock.memoryRecords.mockResolvedValue({ records: [] });
  apiMock.memoryRecord.mockResolvedValue(memoryDetail());
  apiMock.memoryGraph.mockResolvedValue(memoryGraph());
  apiMock.memoryOperation.mockRejectedValue(new Error("Unexpected operation poll"));
  apiMock.editMemoryRecord.mockRejectedValue(new Error("Unexpected edit"));
  apiMock.forgetMemoryRecord.mockRejectedValue(new Error("Unexpected forget"));
  apiMock.restoreMemoryRecord.mockRejectedValue(new Error("Unexpected restore"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryWorkspace", () => {
  it("renders capability-only record and graph unavailability without calling read APIs", async () => {
    apiMock.memoryOverview.mockResolvedValue(memoryAvailability({
      capability: memoryCapability({
        read: false,
        actions: false,
        graph: "unavailable",
        reason: "This backend exposes capability metadata only.",
      }),
      overview: undefined,
    }));

    render(<MemoryWorkspace />);
    expect(await screen.findByText("No record snapshot available")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Records" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Record reads unavailableThis backend exposes capability metadata only.",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Graph reads unavailableThis backend exposes capability metadata only.",
    );

    expect(apiMock.memoryRecords).not.toHaveBeenCalled();
    expect(apiMock.memoryRecord).not.toHaveBeenCalled();
    expect(apiMock.memoryGraph).not.toHaveBeenCalled();
  });

  it("reuses the exact forget input with its confirmation token and manages dialog focus", async () => {
    const record = memoryRecord("record-one", { text: "Forget me exactly" });
    apiMock.forgetMemoryRecord.mockImplementation(async (
      _sourceId: string,
      _recordId: string,
      input: { readonly confirmationToken?: string },
    ) => input.confirmationToken === undefined
      ? {
          kind: "confirmation_required" as const,
          confirmation: {
            token: "confirmation-token",
            expiresAt: "2026-08-24T10:05:00.000Z",
            message: "This action requires exact confirmation.",
          },
        }
      : queued(succeededOperation("forget", record.id)));

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const detail = await openRecord(record);
    const forget = within(detail).getByRole("button", { name: "Forget" });

    forget.focus();
    fireEvent.click(forget);
    const firstDialog = await screen.findByRole("alertdialog", { name: "Forget this memory?" });
    const firstCancel = within(firstDialog).getByRole("button", { name: "Cancel" });
    const firstConfirm = within(firstDialog).getByRole("button", { name: "Confirm forget" });
    expect(firstConfirm).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstCancel).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(firstConfirm).toHaveFocus();
    screen.getByRole("button", { name: "Conversations" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstCancel).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(forget).toHaveFocus();

    fireEvent.click(forget);
    const secondDialog = await screen.findByRole("alertdialog", { name: "Forget this memory?" });
    const originalInput = apiMock.forgetMemoryRecord.mock.calls[1]![2];
    fireEvent.click(within(secondDialog).getByRole("button", { name: "Confirm forget" }));

    await waitFor(() => expect(apiMock.forgetMemoryRecord).toHaveBeenCalledTimes(3));
    expect(apiMock.forgetMemoryRecord.mock.calls[2]?.slice(0, 2)).toEqual(["alpha", record.id]);
    expect(apiMock.forgetMemoryRecord.mock.calls[2]?.[2]).toEqual({
      ...originalInput,
      confirmationToken: "confirmation-token",
    });
  });

  it("keeps an edited resultRecordId selected and refetches its authoritative detail", async () => {
    const original = memoryRecord("record-one", {
      text: "Original editable memory",
      dueAt: "2026-08-24T10:00:37.456Z",
      validFrom: "2026-08-23T09:15:42.123Z",
    });
    const authoritative = memoryRecord("record-edited", {
      revision: "b".repeat(64),
      text: "Authoritative edited memory",
    });
    apiMock.memoryRecord.mockImplementation(async (_sourceId: string, recordId: string) =>
      memoryDetail(recordId === authoritative.id ? authoritative : original));
    apiMock.editMemoryRecord.mockResolvedValue(queued(
      succeededOperation("edit", original.id, authoritative.id),
    ));

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const detail = await openRecord(original, (recordId) =>
      memoryDetail(recordId === authoritative.id ? authoritative : original));
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(detail).getByRole("textbox", { name: "Text" }), {
      target: { value: "Client-side proposed memory" },
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Save as new memory" }));

    await waitFor(() => expect(apiMock.editMemoryRecord).toHaveBeenCalledTimes(1));
    expect(apiMock.editMemoryRecord.mock.calls[0]?.[2]).toMatchObject({
      patch: { text: "Client-side proposed memory" },
    });
    expect(apiMock.editMemoryRecord.mock.calls[0]?.[2].patch).not.toHaveProperty("dueAt");
    expect(apiMock.editMemoryRecord.mock.calls[0]?.[2].patch).not.toHaveProperty("validFrom");
    await waitFor(() => expect(apiMock.memoryRecord).toHaveBeenCalledWith(
      "alpha",
      authoritative.id,
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText(authoritative.text)).toBeInTheDocument();
    expect(screen.queryByText("Client-side proposed memory")).not.toBeInTheDocument();
  });

  it("shows a fixed UI error when mutation admission is malformed", async () => {
    const original = memoryRecord("record-one", { text: "Malformed admission source" });
    apiMock.editMemoryRecord.mockRejectedValue(new ApiError(
      "PRIVATE malformed upstream admission",
      502,
      "invalid_memory_response",
    ));

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const detail = await openRecord(original);
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(detail).getByRole("textbox", { name: "Text" }), {
      target: { value: "Proposed update" },
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Save as new memory" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The memory action could not be completed.");
    expect(alert).not.toHaveTextContent("PRIVATE");
  });

  it("keeps a restored resultRecordId selected and refetches its authoritative detail", async () => {
    const forgotten = memoryRecord("record-forgotten", {
      lifecycle: "forgotten",
      text: "Forgotten source memory",
    });
    const restored = memoryRecord("record-restored", {
      revision: "c".repeat(64),
      text: "Authoritative restored memory",
    });
    apiMock.memoryRecord.mockImplementation(async (_sourceId: string, recordId: string) =>
      memoryDetail(recordId === restored.id ? restored : forgotten));
    apiMock.restoreMemoryRecord.mockResolvedValue(queued(
      succeededOperation("restore", forgotten.id, restored.id),
    ));

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const detail = await openRecord(forgotten, (recordId) =>
      memoryDetail(recordId === restored.id ? restored : forgotten));
    fireEvent.click(within(detail).getByRole("button", { name: "Restore as new memory" }));

    await waitFor(() => expect(apiMock.memoryRecord).toHaveBeenCalledWith(
      "alpha",
      restored.id,
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText(restored.text)).toBeInTheDocument();
  });

  it("keeps the source selected when a reserved result id fails before creation", async () => {
    const forgotten = memoryRecord("record-forgotten", {
      lifecycle: "forgotten",
      text: "Restore that will fail",
    });
    apiMock.restoreMemoryRecord.mockResolvedValue(queued({
      ...succeededOperation("restore", forgotten.id, "reserved-but-absent"),
      status: "failed",
      errorCode: "invalid_request",
      errorMessage: "private provider detail",
    }));

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const detail = await openRecord(forgotten);
    fireEvent.click(within(detail).getByRole("button", { name: "Restore as new memory" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The action was no longer valid for this memory.",
    );
    expect(apiMock.memoryRecord).not.toHaveBeenCalledWith(
      "alpha",
      "reserved-but-absent",
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(apiMock.memoryRecord).toHaveBeenLastCalledWith(
      "alpha",
      forgotten.id,
      expect.any(AbortSignal),
    ));
  });

  it("publishes durable polling progress and aborts the exact operation on a source change", async () => {
    const forgotten = memoryRecord("record-forgotten", {
      lifecycle: "forgotten",
      text: "Long-running restore source",
    });
    const applying = {
      ...succeededOperation("restore", forgotten.id, "record-restored"),
      status: "applying" as const,
    };
    apiMock.restoreMemoryRecord.mockResolvedValue(queued({
      ...applying,
      status: "queued",
    }));
    apiMock.memoryOperation.mockResolvedValue(applying);

    const view = render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const detail = await openRecord(forgotten);
    vi.useFakeTimers();

    fireEvent.click(within(detail).getByRole("button", { name: "Restore as new memory" }));
    await act(async () => Promise.resolve());
    expect(screen.getByText("restore · queued")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(apiMock.memoryOperation).toHaveBeenCalledWith(
      "alpha",
      "restore-operation",
      expect.any(AbortSignal),
    );
    expect(screen.getByText("restore · applying")).toBeInTheDocument();
    const pollSignal = apiMock.memoryOperation.mock.calls[0]?.[2] as AbortSignal;

    storeMock.current = {
      ...storeMock.current,
      workspaceRoute: { kind: "memory", sourceId: "beta" },
    };
    view.rerender(<MemoryWorkspace />);
    expect(pollSignal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(apiMock.memoryOperation).toHaveBeenCalledTimes(1);
  });

  it("offers zoom controls plus complete, focusable graph list and pannable fallbacks", async () => {
    apiMock.memoryGraph.mockResolvedValue(memoryGraph({
      nodes: [
        { kind: "entity", id: "person", label: "Robert", entityType: "person" },
        { kind: "memory", id: "one", label: "First complete memory label", lifecycle: "active", recordType: "note" },
        { kind: "memory", id: "two", label: "Second complete memory label", lifecycle: "forgotten", recordType: "task" },
      ],
      edges: [
        { source: "person", target: "one", kind: "supports", label: "authored" },
        { source: "one", target: "two", kind: "supersedes" },
      ],
    }));

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));

    expect(await screen.findByRole("heading", { name: "Nodes 3" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Relationships 2" })).toBeInTheDocument();
    expect(screen.getByText("First complete memory label", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Second complete memory label", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("authored")).toBeInTheDocument();
    expect(screen.getByText("supersedes")).toBeInTheDocument();

    const canvas = screen.getByLabelText(/Pan the zoomed memory graph with touch or scroll/u);
    expect(canvas).toHaveAttribute("tabindex", "0");
    const scrollTo = vi.fn();
    Object.defineProperty(canvas, "scrollTo", { configurable: true, value: scrollTo });
    const zoom = within(screen.getByRole("group", { name: "Graph zoom controls" }));
    expect(zoom.getByText("100%")).toBeInTheDocument();
    fireEvent.click(zoom.getByRole("button", { name: "Zoom graph in" }));
    expect(zoom.getByText("120%")).toBeInTheDocument();
    fireEvent.click(zoom.getByRole("button", { name: "Zoom graph out" }));
    fireEvent.click(zoom.getByRole("button", { name: "Zoom graph out" }));
    expect(zoom.getByText("80%")).toBeInTheDocument();
    fireEvent.click(zoom.getByRole("button", { name: "Reset" }));
    expect(zoom.getByText("100%")).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0 });
  });

  it("uses roving keyboard focus with complete tab-to-panel relationships", async () => {
    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const overview = screen.getByRole("tab", { name: "Overview" });
    const records = screen.getByRole("tab", { name: "Records" });
    const graph = screen.getByRole("tab", { name: "Graph" });

    expect(overview).toHaveAttribute("tabindex", "0");
    expect(records).toHaveAttribute("tabindex", "-1");
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(records).toHaveFocus();
    expect(records).toHaveAttribute("aria-selected", "true");
    const overviewPanel = document.getElementById("memory-panel-overview");
    const recordsPanel = document.getElementById("memory-panel-records");
    const graphPanel = document.getElementById("memory-panel-graph");
    expect(overviewPanel).toHaveAttribute("tabindex", "0");
    expect(recordsPanel).toHaveAttribute("tabindex", "0");
    expect(graphPanel).toHaveAttribute("tabindex", "0");
    expect(recordsPanel).toHaveAttribute(
      "aria-labelledby",
      "memory-tab-records",
    );
    recordsPanel?.focus();
    expect(recordsPanel).toHaveFocus();

    records.focus();
    fireEvent.keyDown(records, { key: "End" });
    expect(graph).toHaveFocus();
    fireEvent.keyDown(graph, { key: "Home" });
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(graph).toHaveFocus();
  });

  it("focus-manages the real mobile agent dialog and restores its opener on Escape", async () => {
    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    const opener = screen.getByRole("button", { name: "Choose memory agent" });
    opener.focus();
    fireEvent.click(opener);

    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(opener).toHaveAttribute("aria-controls", "memory-agent-dialog");
    const dialog = screen.getByRole("dialog", { name: "Choose memory agent" });
    const buttons = within(dialog).getAllByRole("button");
    await waitFor(() => expect(buttons[0]).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "Alpha, online" })).toBeInTheDocument();

    buttons.at(-1)!.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(buttons.at(-1)).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose memory agent" }))
      .not.toBeInTheDocument());
    expect(opener).toHaveAttribute("aria-expanded", "false");
    expect(opener).toHaveFocus();
  });

  it("refreshes authoritative overview and the active tab while aborting its stale request", async () => {
    const staleRecords = deferred<{ readonly records: readonly ReturnType<typeof memoryRecord>[] }>();
    apiMock.memoryRecords
      .mockImplementationOnce(async (_sourceId: string, _query: unknown, signal: AbortSignal) => {
        signal.addEventListener("abort", () => staleRecords.reject(signal.reason), { once: true });
        return await staleRecords.promise;
      })
      .mockResolvedValue({ records: [memoryRecord("fresh-record", { text: "Fresh after refresh" })] });

    render(<MemoryWorkspace />);
    await screen.findByRole("region", { name: "Memory counts" });
    fireEvent.click(screen.getByRole("tab", { name: "Records" }));
    await waitFor(() => expect(apiMock.memoryRecords).toHaveBeenCalledTimes(1));
    const staleSignal = apiMock.memoryRecords.mock.calls[0]?.[2] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: /Refresh/u }));

    expect(staleSignal.aborted).toBe(true);
    await waitFor(() => expect(apiMock.memoryOverview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(apiMock.memoryRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Fresh after refresh")).toBeInTheDocument();
  });

  it("aborts and suppresses stale source, offline, and unmounted overview requests", async () => {
    const alpha = deferred<MemoryAvailability>();
    const beta = deferred<MemoryAvailability>();
    apiMock.memoryOverview.mockImplementation(async (sourceId: string) =>
      await (sourceId === "alpha" ? alpha.promise : beta.promise));
    const first = render(<MemoryWorkspace />);
    await waitFor(() => expect(apiMock.memoryOverview).toHaveBeenCalledTimes(1));
    const alphaSignal = apiMock.memoryOverview.mock.calls[0]?.[1] as AbortSignal;

    storeMock.current = {
      ...storeMock.current,
      workspaceRoute: { kind: "memory", sourceId: "beta" },
    };
    first.rerender(<MemoryWorkspace />);
    expect(alphaSignal.aborted).toBe(true);
    await waitFor(() => expect(apiMock.memoryOverview).toHaveBeenCalledTimes(2));
    await act(async () => {
      alpha.resolve(memoryAvailability({ overview: memoryOverview({ counts: {
        total: 91,
        active: 91,
        superseded: 0,
        forgotten: 0,
        byType: { task: 0, event: 0, note: 91 },
      } }) }));
      beta.resolve(memoryAvailability({
        capability: memoryCapability({ backend: "supermemory" }),
        overview: memoryOverview({ capability: memoryCapability({ backend: "supermemory" }) }),
      }));
    });
    expect(await screen.findByText("Supermemory")).toBeInTheDocument();
    expect(screen.queryByText("91")).not.toBeInTheDocument();

    first.unmount();
    vi.clearAllMocks();
    setLiveSource();
    const offlinePending = deferred<MemoryAvailability>();
    apiMock.memoryOverview.mockReturnValue(offlinePending.promise);
    const second = render(<MemoryWorkspace />);
    await waitFor(() => expect(apiMock.memoryOverview).toHaveBeenCalledTimes(1));
    const offlineSignal = apiMock.memoryOverview.mock.calls[0]?.[1] as AbortSignal;
    storeMock.current = {
      ...storeMock.current,
      agents: [agent("alpha", { label: "Alpha", status: "offline" })],
    };
    second.rerender(<MemoryWorkspace />);
    expect(offlineSignal.aborted).toBe(true);
    await act(async () => offlinePending.resolve(memoryAvailability()));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Alpha is offline. Memory snapshots are cleared until it reconnects.",
    );
    expect(screen.queryByRole("region", { name: "Memory counts" })).not.toBeInTheDocument();

    second.unmount();
    vi.clearAllMocks();
    setLiveSource();
    const unmountPending = deferred<MemoryAvailability>();
    apiMock.memoryOverview.mockReturnValue(unmountPending.promise);
    const third = render(<MemoryWorkspace />);
    await waitFor(() => expect(apiMock.memoryOverview).toHaveBeenCalledTimes(1));
    const unmountSignal = apiMock.memoryOverview.mock.calls[0]?.[1] as AbortSignal;
    third.unmount();
    expect(unmountSignal.aborted).toBe(true);
    await act(async () => unmountPending.resolve(memoryAvailability()));
  });

  it.each([
    ["memory_offline", "This agent is offline. No memory snapshot is retained in the browser."],
    ["memory_unsupported", "This agent does not expose a live memory operator."],
    ["agent_not_found", "This route does not match a discovered agent."],
  ])("sanitizes %s overview errors", async (code, expected) => {
    apiMock.memoryOverview.mockRejectedValue(new ApiError(
      "PRIVATE /Users/example/raw/provider detail",
      code === "agent_not_found" ? 404 : 503,
      code,
    ));

    render(<MemoryWorkspace />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert).not.toHaveTextContent("PRIVATE");
    expect(alert).not.toHaveTextContent("/Users/example");
  });
});

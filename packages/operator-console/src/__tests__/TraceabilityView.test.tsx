// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OperatorConsoleClient } from "../client/api.js";
import type {
  TraceabilityRunResponse,
  TraceabilityRunsResponse,
} from "../client/api.js";
import { TraceabilityView } from "../client/components/TraceabilityView.js";

function makeStubClient(overrides: Partial<OperatorConsoleClient> = {}): OperatorConsoleClient {
  const stub = new OperatorConsoleClient("", "test-token");
  return Object.assign(stub, overrides);
}

const sourceA = {
  schema: "agent-runtime.trace-source.v1" as const,
  sourceId: "agent-a",
  label: "Agent A",
  artifactDir: "/repo/a",
  status: "running" as const,
  health: "running" as const,
  startedAt: "2026-05-16T07:00:00.000Z",
  updatedAt: "2026-05-16T08:00:00.000Z",
  transports: ["telegram"],
  warnings: [],
};

const sourceB = {
  schema: "agent-runtime.trace-source.v1" as const,
  sourceId: "agent-b",
  label: "Agent B",
  artifactDir: "/repo/b",
  status: "running" as const,
  health: "stale" as const,
  startedAt: "2026-05-16T07:00:00.000Z",
  updatedAt: "2026-05-16T07:15:00.000Z",
  transports: ["a2a"],
  warnings: ["Source heartbeat is stale."],
};

const runA = {
  source: sourceA,
  runId: "run-a",
  conversationId: "telegram:123",
  status: "succeeded" as const,
  durationMs: 1432,
  eventCount: 6,
  updatedAt: "2026-05-16T08:00:00.000Z",
  usage: { inputTokens: 12 },
  capabilitiesUsed: ["tools"],
};

const runB = {
  source: sourceB,
  runId: "run-b",
  conversationId: "a2a:task",
  status: "failed" as const,
  failureKind: "provider_error",
  durationMs: 88,
  eventCount: 1,
  updatedAt: "2026-05-16T07:59:00.000Z",
};

const runDetail = {
  source: sourceA,
  run: {
    summary: runA,
    warnings: [],
    events: [
      {
        index: 0,
        type: "assistant",
        category: "thinking" as const,
        label: "assistant",
        summary: "I should",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "I should" }] } },
      },
      {
        index: 1,
        type: "assistant",
        category: "thinking" as const,
        label: "assistant",
        summary: " inspect",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: " inspect" }] } },
      },
      {
        index: 2,
        type: "assistant",
        category: "thinking" as const,
        label: "assistant",
        summary: " files.",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: " files." }] } },
      },
      {
        index: 3,
        type: "tool.call",
        category: "tool" as const,
        label: "Tool: Read",
        summary: "Read - started",
        payload: { type: "tool.call", toolName: "Read", status: "started" },
      },
      {
        index: 4,
        type: "assistant",
        category: "message" as const,
        label: "assistant",
        summary: "Visible",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "Visible" }] } },
      },
      {
        index: 5,
        type: "assistant",
        category: "message" as const,
        label: "assistant",
        summary: " response",
        payload: { type: "assistant", message: { content: [{ type: "text", text: " response" }] } },
      },
    ],
  },
};

describe("<TraceabilityView/>", () => {
  it("shows a disabled state instead of fixture data when traceability is not configured", async () => {
    const fetchTraceabilityRuns = vi.fn<OperatorConsoleClient["fetchTraceabilityRuns"]>().mockResolvedValue({
      enabled: false,
      sources: [],
      runs: [],
      warnings: ["Traceability is not configured for this console."],
    } satisfies TraceabilityRunsResponse);
    const fetchTraceabilityRun = vi.fn<OperatorConsoleClient["fetchTraceabilityRun"]>();

    render(<TraceabilityView client={makeStubClient({ fetchTraceabilityRuns, fetchTraceabilityRun })} />);

    expect(await screen.findByText(/not configured/u)).toBeInTheDocument();
    expect(fetchTraceabilityRun).not.toHaveBeenCalled();
  });

  it("shows source health, filters runs, and loads the selected timeline", async () => {
    const fetchTraceabilityRuns = vi.fn<OperatorConsoleClient["fetchTraceabilityRuns"]>().mockResolvedValue({
      enabled: true,
      registryDir: "/repo/.mono-agent/trace-sources",
      sources: [sourceA, sourceB],
      runs: [runA, runB],
    } satisfies TraceabilityRunsResponse);
    const fetchTraceabilityRun = vi.fn<OperatorConsoleClient["fetchTraceabilityRun"]>().mockImplementation(async (sourceId) => ({
      enabled: true,
      registryDir: "/repo/.mono-agent/trace-sources",
      detail: sourceId === "agent-b"
        ? { source: sourceB, run: { ...runDetail.run, summary: runB, events: [] } }
        : runDetail,
    } satisfies TraceabilityRunResponse));

    render(<TraceabilityView client={makeStubClient({ fetchTraceabilityRuns, fetchTraceabilityRun })} />);

    expect((await screen.findAllByText("Agent A"))[0]).toBeInTheDocument();
    expect(screen.getAllByText("stale")[0]).toBeInTheDocument();
    await waitFor(() => expect(fetchTraceabilityRun).toHaveBeenCalledWith("agent-a", "run-a"));
    expect(await screen.findByText("Assistant thoughts")).toBeInTheDocument();
    expect(screen.getByText("I should inspect files.")).toBeInTheDocument();
    expect(screen.getByText("#1-#3 · 3 events")).toBeInTheDocument();
    expect(await screen.findByText("Tool: Read")).toBeInTheDocument();
    expect(screen.getByText("#4")).toBeInTheDocument();
    expect(screen.getByText("Assistant message")).toBeInTheDocument();
    expect(screen.getByText("Visible response")).toBeInTheDocument();
    expect(screen.getByText("#5-#6 · 2 events")).toBeInTheDocument();
    expect(screen.getByText("3 rows from 6 events")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "agent-b" } });
    await waitFor(() => expect(fetchTraceabilityRun).toHaveBeenCalledWith("agent-b", "run-b"));
    expect(screen.queryByRole("button", { name: /run-a/u })).not.toBeInTheDocument();
    expect(screen.getAllByText("run-b")[0]).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "succeeded" } });
    expect(screen.getByText(/No runs match/u)).toBeInTheDocument();
  });

  it("refreshes the real endpoint on demand without double-loading on auto-selection", async () => {
    const fetchTraceabilityRuns = vi.fn<OperatorConsoleClient["fetchTraceabilityRuns"]>().mockResolvedValue({
      enabled: true,
      sources: [sourceA],
      runs: [runA],
    } satisfies TraceabilityRunsResponse);
    const fetchTraceabilityRun = vi.fn<OperatorConsoleClient["fetchTraceabilityRun"]>().mockResolvedValue({
      enabled: true,
      detail: runDetail,
    } satisfies TraceabilityRunResponse);

    render(<TraceabilityView client={makeStubClient({ fetchTraceabilityRuns, fetchTraceabilityRun })} />);
    await screen.findAllByText("run-a");
    await waitFor(() => expect(fetchTraceabilityRuns).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchTraceabilityRuns).toHaveBeenCalledTimes(2));
  });
});

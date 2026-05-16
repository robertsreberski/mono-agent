// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OperatorConsoleClient } from "../api.js";
import type {
  ObservabilityRunResponse,
  ObservabilityRunsResponse,
} from "../api.js";
import { ObservabilityView } from "./ObservabilityView.js";

function makeStubClient(overrides: Partial<OperatorConsoleClient> = {}): OperatorConsoleClient {
  const stub = new OperatorConsoleClient("", "test-token");
  return Object.assign(stub, overrides);
}

const runListItem = {
  runId: "run-1",
  conversationId: "telegram:123",
  status: "succeeded" as const,
  durationMs: 1432,
  eventCount: 2,
  updatedAt: "2026-05-16T08:00:00.000Z",
  usage: { inputTokens: 12 },
  capabilitiesUsed: ["tools"],
};

const runDetail = {
  summary: runListItem,
  warnings: [],
  events: [
    {
      index: 0,
      type: "tool.call",
      category: "tool" as const,
      label: "Tool: Read",
      summary: "Read — started",
      payload: { type: "tool.call", toolName: "Read", status: "started" },
    },
    {
      index: 1,
      type: "assistant",
      category: "message" as const,
      label: "assistant",
      summary: "Visible response",
      payload: { type: "assistant", message: { content: [{ type: "text", text: "Visible response" }] } },
    },
  ],
};

describe("<ObservabilityView/>", () => {
  it("shows a disabled state instead of fixture data when the console has no observability", async () => {
    const fetchObservedRuns = vi.fn<OperatorConsoleClient["fetchObservedRuns"]>().mockResolvedValue({
      enabled: false,
      runs: [],
      warnings: ["Observability is not configured for this console."],
    } satisfies ObservabilityRunsResponse);
    const fetchObservedRun = vi.fn<OperatorConsoleClient["fetchObservedRun"]>();

    render(<ObservabilityView client={makeStubClient({ fetchObservedRuns, fetchObservedRun })} />);

    expect(await screen.findByText(/not configured/u)).toBeInTheDocument();
    expect(fetchObservedRun).not.toHaveBeenCalled();
  });

  it("lists recorded runs and loads an expandable event timeline", async () => {
    const fetchObservedRuns = vi.fn<OperatorConsoleClient["fetchObservedRuns"]>().mockResolvedValue({
      enabled: true,
      artifactDir: "/repo/.mono-agent/artifacts",
      runs: [runListItem],
    } satisfies ObservabilityRunsResponse);
    const fetchObservedRun = vi.fn<OperatorConsoleClient["fetchObservedRun"]>().mockResolvedValue({
      enabled: true,
      artifactDir: "/repo/.mono-agent/artifacts",
      run: runDetail,
    } satisfies ObservabilityRunResponse);

    render(<ObservabilityView client={makeStubClient({ fetchObservedRuns, fetchObservedRun })} />);

    expect((await screen.findAllByText("run-1"))[0]).toBeInTheDocument();
    await waitFor(() => expect(fetchObservedRun).toHaveBeenCalledWith("run-1"));
    expect(await screen.findByText("Tool: Read")).toBeInTheDocument();
    expect(screen.getByText("Visible response")).toBeInTheDocument();
    expect(screen.getAllByText("Raw JSON payload")[0]).toBeInTheDocument();
    expect(screen.getAllByText(/usage\/cost/u)[0]).toBeInTheDocument();
    expect(screen.getByText(/Private model chain-of-thought is not inferred/u)).toBeInTheDocument();
  });

  it("refreshes the real endpoint on demand", async () => {
    const fetchObservedRuns = vi.fn<OperatorConsoleClient["fetchObservedRuns"]>().mockResolvedValue({
      enabled: true,
      runs: [runListItem],
    } satisfies ObservabilityRunsResponse);
    const fetchObservedRun = vi.fn<OperatorConsoleClient["fetchObservedRun"]>().mockResolvedValue({
      enabled: true,
      run: runDetail,
    } satisfies ObservabilityRunResponse);

    render(<ObservabilityView client={makeStubClient({ fetchObservedRuns, fetchObservedRun })} />);
    await screen.findAllByText("run-1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchObservedRuns).toHaveBeenCalledTimes(2));
  });
});

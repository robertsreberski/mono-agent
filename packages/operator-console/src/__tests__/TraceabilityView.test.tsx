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
  pid: 4242,
  status: "running" as const,
  health: "running" as const,
  startedAt: "2026-05-16T07:00:00.000Z",
  updatedAt: "2026-05-16T08:00:00.000Z",
  transports: ["telegram"],
      configPath: "/repo/a/mono-agent.config.json",
      metadata: {
        workspace: "personal-agent",
        profile: { owner: "Robert", mode: "local" },
        "{\"metadataKey\":\"secret\"}": "metadata value",
      },
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
  eventCount: 14,
  updatedAt: "2026-05-16T08:00:00.000Z",
  startedAt: "2026-05-16T07:59:58.000Z",
  endedAt: "2026-05-16T08:00:00.000Z",
  usage: { inputTokens: 12, outputTokens: 9 },
  cost: { totalUsd: 0.0012 },
  providerSessionId: "session-a",
  runtimeWarnings: ["retry recovered"],
  diagnostics: { model: "gpt-test", retries: 1 },
  capabilitiesUsed: ["tools", "memory"],
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
        payload: {
          type: "tool.call",
          toolName: "Read",
          status: "started",
          input: { path: "/repo/a/notes.md", limit: 20 },
        },
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
      {
        index: 6,
        type: "runtime.notice",
        category: "runtime" as const,
        label: "Runtime notice",
        summary: "[WARN] retrying provider",
        payload: { type: "runtime.notice", summary: "[WARN] retrying provider" },
      },
      {
        index: 7,
        type: "runtime.notice",
        category: "runtime" as const,
        label: "Runtime notice",
        summary: "{\"type\":\"runtime.notice\",\"phase\":\"retry\"}",
        payload: { type: "runtime.notice", phase: "retry" },
      },
      {
        index: 8,
        type: "runtime.output",
        category: "runtime" as const,
        label: "Runtime output",
        summary: "stringified sensitive output",
        payload: {
          type: "runtime.output",
          output: "{\"apiKey\":\"sk-live\"}",
          privateKey: "private-value",
          credentials: { token: "nested-token" },
        },
      },
      {
        index: 9,
        type: "runtime.array",
        category: "runtime" as const,
        label: "Runtime array",
        summary: "scalar array",
        payload: { type: "runtime.array", items: ["{\"path\":\"/tmp/a\"}", "tool returned {\"authorization\":\"Bearer secret\"}"] },
      },
      {
        index: 10,
        type: "runtime.summary",
        category: "runtime" as const,
        label: "Runtime summary",
        summary: "request payload {\"model\":\"gpt-5.5\"}",
        payload: { type: "runtime.summary", phase: "request" },
      },
      {
        index: 11,
        type: "runtime.large",
        category: "runtime" as const,
        label: "Runtime large",
        summary: "large array",
        payload: {
          type: "runtime.large",
          items: Array.from({ length: 13 }, (_, index) => `item-${index + 1}`),
        },
      },
      {
        index: 12,
        type: "runtime.fields",
        category: "runtime" as const,
        label: "Runtime fields",
        summary: "many fields",
        payload: Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`field${index + 1}`, `value-${index + 1}`])),
      },
      {
        index: 13,
        type: "runtime.embedded",
        category: "runtime" as const,
        label: "Runtime embedded",
        summary: "embedded structure string",
        payload: { type: "runtime.embedded", output: "stdout {\"apiKey\":\"sk-live\"}" },
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
    expect(screen.getByText("Operations snapshot")).toBeInTheDocument();
    expect(screen.getByText("2 sources")).toBeInTheDocument();
    expect(screen.getByText("2 runs")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(screen.getByText("1 failing")).toBeInTheDocument();
    expect(screen.getAllByText("stale")[0]).toBeInTheDocument();
    await waitFor(() => expect(fetchTraceabilityRun).toHaveBeenCalledWith("agent-a", "run-a"));
    expect(await screen.findByText("Event mix")).toBeInTheDocument();
    expect(screen.getByText("3 thinking")).toBeInTheDocument();
    expect(screen.getByText("1 tool")).toBeInTheDocument();
    expect(screen.getByText("2 messages")).toBeInTheDocument();
    expect(screen.getByText("8 runtime")).toBeInTheDocument();
    expect(screen.getByLabelText("Traceability layout").className).toContain("xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]");
    expect(screen.getByText("Source context")).toBeInTheDocument();
    expect(screen.getByText("Config path")).toBeInTheDocument();
    expect(screen.getByText("/repo/a/mono-agent.config.json")).toBeInTheDocument();
    expect(screen.getByText("Source metadata")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("personal-agent")).toBeInTheDocument();
    expect(screen.getByText("Run insights")).toBeInTheDocument();
    expect(screen.getByText("Input Tokens")).toBeInTheDocument();
    expect(screen.getByText("Output Tokens")).toBeInTheDocument();
    expect(screen.getByText("Provider session")).toBeInTheDocument();
    expect(screen.getByText("session-a")).toBeInTheDocument();
    expect(screen.getByText("Runtime warnings")).toBeInTheDocument();
    expect(screen.getByText("retry recovered")).toBeInTheDocument();
    expect(await screen.findByText("Assistant thoughts")).toBeInTheDocument();
    expect(screen.getAllByText("I should inspect files.").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("#1-#3 · 3 events")).toBeInTheDocument();
    expect(await screen.findByText("Tool: Read")).toBeInTheDocument();
    expect(screen.getByText("Tool Name")).toBeInTheDocument();
    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("/repo/a/notes.md")).toBeInTheDocument();
    expect(screen.getAllByText("#4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Assistant message")).toBeInTheDocument();
    expect(screen.getAllByText("Visible response").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("#5-#6 · 2 events")).toBeInTheDocument();
    expect(screen.getAllByText("Runtime notice").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("[WARN] retrying provider").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Runtime event with 2 fields.")).toBeInTheDocument();
    expect(screen.getAllByText("Phase").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("retry")).toBeInTheDocument();
    expect(screen.getByText("Runtime event with structured text.")).toBeInTheDocument();
    expect(screen.getAllByText("Structured text value").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Text with structured data omitted.").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Showing first 12 of 13 items.")).toBeInTheDocument();
    expect(screen.getByText("Showing first 20 fields. Additional fields omitted.")).toBeInTheDocument();
    expect(screen.getAllByText("Event fields").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("11 rows from 14 events")).toBeInTheDocument();
    expect(screen.queryByText(/Raw JSON/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/JSON payload/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Combined payload preview/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/"toolName"/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/"phase"/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/apiKey/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-live/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/private-value/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/nested-token/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/"path"/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/tmp\/a/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bearer secret/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/"model"/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Field 21")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "agent-b" } });
    await waitFor(() => expect(fetchTraceabilityRun).toHaveBeenCalledWith("agent-b", "run-b"));
    expect(screen.queryByRole("button", { name: /run-a/u })).not.toBeInTheDocument();
    expect(screen.getAllByText("run-b")[0]).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "succeeded" } });
    expect(screen.getByText(/No runs match/u)).toBeInTheDocument();
  });

  it("sanitizes trace-originated labels and bounds large event payloads", async () => {
    const rawSourceId = "{\"source\":\"agent-json\"}";
    const rawRunId = "{\"run\":\"large\"}";
    const rawSource = {
      ...sourceA,
      sourceId: rawSourceId,
      label: "{\"agent\":\"Agent A\"}",
      artifactDir: "artifact {\"path\":\"/tmp/trace\"}",
      transports: ["telegram {\"token\":\"secret\"}"],
      warnings: ["source warning {\"secret\":\"value\"}"],
    };
    const rawRun = {
      ...runA,
      source: rawSource,
      runId: rawRunId,
      conversationId: "thread {\"id\":123}",
      failureKind: "{\"apiKey\":\"sk-live\"}",
      eventCount: 1,
      runtimeWarnings: ["runtime warning {\"secret\":\"value\"}"],
    };
    const largePayload = {
      type: "runtime.large",
      items: Array.from({ length: 1_000 }, (_, index) => `item-${index + 1}`),
      "{\"payloadKey\":\"secret\"}": "payload value",
      ...Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [`field${index + 1}`, index === 999 ? "last-value" : `value-${index + 1}`]),
      ),
    };
    const rawDetail = {
      source: rawSource,
      run: {
        summary: rawRun,
        warnings: ["run warning {\"secret\":\"value\"}"],
        events: [
          {
            index: 0,
            type: "{\"type\":\"runtime.large\"}",
            category: "runtime" as const,
            label: "{\"label\":\"Runtime large\"}",
            summary: "{\"summary\":\"large payload\"}",
            payload: largePayload,
          },
        ],
      },
    };
    const fetchTraceabilityRuns = vi.fn<OperatorConsoleClient["fetchTraceabilityRuns"]>().mockResolvedValue({
      enabled: true,
      registryDir: "registry {\"path\":\"/repo/.mono-agent\"}",
      sources: [rawSource],
      runs: [rawRun],
      warnings: ["registry warning {\"secret\":\"value\"}"],
    } satisfies TraceabilityRunsResponse);
    const fetchTraceabilityRun = vi.fn<OperatorConsoleClient["fetchTraceabilityRun"]>().mockResolvedValue({
      enabled: true,
      detail: rawDetail,
    } satisfies TraceabilityRunResponse);

    render(<TraceabilityView client={makeStubClient({ fetchTraceabilityRuns, fetchTraceabilityRun })} />);

    await waitFor(() => expect(fetchTraceabilityRun).toHaveBeenCalledWith(rawSourceId, rawRunId));
    expect(screen.getAllByText("Structured text value").length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText("Text with structured data omitted.").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Runtime event with 20+ fields.")).toBeInTheDocument();
    expect(screen.getAllByText("Showing first 20 fields. Additional fields omitted.").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Showing first 12 of 1,000 items.")).toBeInTheDocument();
    expect(screen.getByText("Field 15")).toBeInTheDocument();
    expect(screen.queryByText("Field 16")).not.toBeInTheDocument();
    expect(screen.queryByText("last-value")).not.toBeInTheDocument();
    expect(screen.queryByText("item-999")).not.toBeInTheDocument();
    expect(screen.queryByText(/\{\s*"/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/"\s*:/u)).not.toBeInTheDocument();

    for (const element of Array.from(document.querySelectorAll("[title]"))) {
      const title = element.getAttribute("title") ?? "";
      expect(title).not.toMatch(/\{\s*"/u);
      expect(title).not.toMatch(/"\s*:/u);
    }
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

  it("shows an explicit empty run queue when traceability is enabled without runs", async () => {
    const fetchTraceabilityRuns = vi.fn<OperatorConsoleClient["fetchTraceabilityRuns"]>().mockResolvedValue({
      enabled: true,
      sources: [sourceA],
      runs: [],
    } satisfies TraceabilityRunsResponse);
    const fetchTraceabilityRun = vi.fn<OperatorConsoleClient["fetchTraceabilityRun"]>();

    render(<TraceabilityView client={makeStubClient({ fetchTraceabilityRuns, fetchTraceabilityRun })} />);

    expect(await screen.findByText("No runs have been recorded yet.")).toBeInTheDocument();
    expect(fetchTraceabilityRun).not.toHaveBeenCalled();
  });
});

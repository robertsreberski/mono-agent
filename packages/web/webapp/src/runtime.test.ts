import { describe, expect, it } from "vitest";
import {
  canSendInConsole,
  canUploadInConsole,
  coalesceMonitorWakeMessages,
  convertWebMessage,
} from "./runtime";
import { projectProcessJobPresentation } from "./process-job-presentation";
import { agent, attachment, monitor, processJob, thread } from "./test/fixtures";
import type { WebMessage } from "./types";

const processJobReceipt = (
  job = processJob(),
  overrides: Record<string, unknown> = {},
) => ({
  schema: "mono-agent.process-job-start-receipt.v1",
  jobId: job.jobId,
  tool: job.tool,
  state: job.timestamps.startedAt === null ? "queued" : "running",
  startedAt: job.timestamps.startedAt,
  maxRuntimeMs: job.limits.maxRuntimeMs,
  ...overrides,
});

const launchPart = (job = processJob(), toolCallId = `launch-${job.jobId}`) => ({
  type: "tool-call" as const,
  toolCallId,
  toolName: job.tool,
  status: "complete" as const,
  structuredResult: processJobReceipt(job),
});

const message = (overrides: Partial<WebMessage> = {}): WebMessage => ({
  id: "message-1",
  threadId: "thread-1",
  role: "user",
  parts: [],
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status: "complete",
  ...overrides,
});

const monitorWake = (
  id: string,
  projection = monitor(),
  overrides: Partial<WebMessage> = {},
): WebMessage => message({
  id,
  threadId: "thread-1",
  turnId: `turn-${id}`,
  role: "assistant",
  parts: [{
    type: "monitor-activity",
    monitors: [{ projection, deliveryKeys: [`monitor:${projection.monitorId}:${String(projection.counters.seq)}`] }],
  }],
  attachments: [],
  createdAt: `2026-07-17T10:00:0${id}.000Z`,
  updatedAt: `2026-07-17T10:00:1${id}.000Z`,
  finishedAt: `2026-07-17T10:00:1${id}.000Z`,
  status: "complete",
  ...overrides,
});

describe("coalesceMonitorWakeMessages", () => {
  it("does not coalesce across a project transition anchor", () => {
    const first = monitorWake("1");
    const anchor = monitorWake("2", monitor(), { projectTransitions: [{ id: 1, afterMessageId: "2", turnId: "turn-2", before: null, after: { id: "p", name: "P", color: "blue" }, createdAt: "2026-09-12T00:00:00Z" }] });
    const last = monitorWake("3");
    const result = coalesceMonitorWakeMessages([first, anchor, last]);
    expect(result.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(convertWebMessage(anchor).metadata?.custom?.projectTransitions).toEqual(anchor.projectTransitions);
  });
  it("uses the newest same-Monitor wake as one chronological presentation carrier", () => {
    const firstProjection = monitor({
      description: "First batch",
      counters: { ...monitor().counters, seq: 1, batchesDelivered: 1 },
    });
    const secondProjection = monitor({
      description: "Second batch",
      counters: { ...monitor().counters, seq: 2, batchesDelivered: 2 },
    });
    const terminalProjection = monitor({
      description: "Terminal batch",
      state: "exited",
      timestamps: { ...monitor().timestamps, completedAt: "2026-07-17T10:00:13.000Z" },
      counters: { ...monitor().counters, seq: 3, batchesDelivered: 3 },
      exitCode: 0,
    });
    const first = monitorWake("1", firstProjection, {
      parts: [
        { type: "reasoning", text: "Check the underlying source." },
        { type: "tool-call", toolCallId: "read-1", toolName: "Read", status: "complete" },
        {
          type: "monitor-activity",
          monitors: [{ projection: firstProjection, deliveryKeys: ["monitor:first"] }],
        },
      ],
    });
    const second = monitorWake("2", secondProjection);
    const terminal = monitorWake("3", terminalProjection, {
      turnId: "turn-terminal",
      updatedAt: "2026-07-17T10:00:30.000Z",
      finishedAt: "2026-07-17T10:00:30.000Z",
      parts: [
        {
          type: "monitor-activity",
          monitors: [{ projection: terminalProjection, deliveryKeys: ["monitor:terminal"] }],
        },
        { type: "text", text: "The watch finished normally." },
      ],
    });

    const shaped = coalesceMonitorWakeMessages([first, second, terminal]);

    expect(shaped).toHaveLength(1);
    expect(shaped[0]).toMatchObject({
      id: "3",
      turnId: "turn-terminal",
      status: "complete",
      updatedAt: "2026-07-17T10:00:30.000Z",
      finishedAt: "2026-07-17T10:00:30.000Z",
    });
    expect(shaped[0]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-call",
      "monitor-activity",
      "monitor-activity",
      "monitor-activity",
      "text",
    ]);
    expect(shaped[0]?.parts.flatMap((part) =>
      part.type === "monitor-activity" ? part.monitors.map((entry) => entry.projection.description) : [],
    )).toEqual(["First batch", "Second batch", "Terminal batch"]);
    expect(first.parts).toHaveLength(3);
    expect(second.parts).toHaveLength(1);
  });

  it("recomputes a streaming carrier from raw messages without duplicating its terminal update", () => {
    const first = monitorWake("1", monitor({
      description: "First batch",
      counters: { ...monitor().counters, seq: 1, batchesDelivered: 1 },
    }));
    const runningProjection = monitor({
      description: "Streaming batch",
      counters: { ...monitor().counters, seq: 2, batchesDelivered: 2 },
    });
    const running = monitorWake("2", runningProjection, {
      status: "running",
      finishedAt: undefined,
    });

    const streaming = coalesceMonitorWakeMessages([first, running]);
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ id: "2", status: "running", turnId: "turn-2" });
    expect(streaming[0]?.parts).toHaveLength(2);

    const terminalProjection = monitor({
      description: "Terminal batch",
      state: "exited",
      timestamps: { ...monitor().timestamps, completedAt: "2026-07-17T10:00:20.000Z" },
      counters: { ...monitor().counters, seq: 2, batchesDelivered: 2 },
      exitCode: 0,
    });
    const settled = monitorWake("2", terminalProjection);
    const completed = coalesceMonitorWakeMessages([first, settled]);

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id: "2", status: "complete", turnId: "turn-2" });
    expect(completed[0]?.parts.flatMap((part) =>
      part.type === "monitor-activity" && part.monitors[0]?.projection.state === "exited" ? [part] : [],
    )).toHaveLength(1);
  });

  it("does not fold a later wake past a visible same-Monitor reply", () => {
    const first = monitorWake("1");
    const visible = monitorWake("2", monitor({ description: "Important batch" }), {
      parts: [
        {
          type: "monitor-activity",
          monitors: [{ projection: monitor({ description: "Important batch" }), deliveryKeys: ["monitor:important"] }],
        },
        { type: "text", text: "The queue needs attention." },
      ],
    });
    const later = monitorWake("3", monitor({ description: "Later batch" }));

    const shaped = coalesceMonitorWakeMessages([first, visible, later]);

    expect(shaped).toHaveLength(2);
    expect(shaped.map((entry) => entry.id)).toEqual(["2", "3"]);
    expect(shaped[0]?.parts.at(-1)).toEqual({ type: "text", text: "The queue needs attention." });
  });

  it.each([
    ["different Monitor", monitorWake("2", monitor({ monitorId: "different-monitor" }))],
    ["mixed Monitor ids", monitorWake("2", monitor(), {
      parts: [{
        type: "monitor-activity" as const,
        monitors: [
          { projection: monitor(), deliveryKeys: ["monitor:first"] },
          { projection: monitor({ monitorId: "different-monitor" }), deliveryKeys: ["monitor:second"] },
        ],
      }],
    })],
    ["identity-less legacy activity", monitorWake("2", monitor(), {
      parts: [{ type: "monitor-activity" as const, monitors: [] }],
    })],
    ["malformed Monitor id", monitorWake("2", monitor(), {
      parts: [{
        type: "monitor-activity" as const,
        monitors: [{
          projection: { ...monitor(), monitorId: "   " },
          deliveryKeys: ["monitor:malformed"],
        }],
      }],
    })],
    ["process job", monitorWake("2", monitor(), {
      parts: [
        { type: "monitor-activity" as const, monitors: [{ projection: monitor(), deliveryKeys: ["monitor:two"] }] },
        { type: "process-job" as const, job: processJob() },
      ],
    })],
    ["message attachment", monitorWake("2", monitor(), {
      attachments: [attachment("upload")],
    })],
    ["error", monitorWake("2", monitor(), {
      parts: [
        { type: "monitor-activity" as const, monitors: [{ projection: monitor(), deliveryKeys: ["monitor:two"] }] },
        { type: "error" as const, code: "provider_failed", message: "Provider failed." },
      ],
    })],
    ["model fallback", monitorWake("2", monitor(), {
      attribution: {
        requested: { model: "fixture:a", effort: "high" },
        attempted: { model: "fixture:b", effort: "high", effectiveEffort: "off" },
        executed: { model: "fixture:b", effort: "high", effectiveEffort: "off" },
        disposition: "fallback" as const,
        transitions: [{ from: "fixture:a", to: "fixture:b", reason: "overloaded" }],
        retries: [],
      },
    })],
    ["reply attachment", monitorWake("2", monitor(), {
      parts: [
        { type: "monitor-activity" as const, monitors: [{ projection: monitor(), deliveryKeys: ["monitor:two"] }] },
        {
          type: "attachment" as const,
          id: "reply",
          artifactId: "artifact",
          name: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
          integrityId: `sha256:${"a".repeat(64)}`,
        },
      ],
    })],
    ["Monitor start receipt", monitorWake("2", monitor(), {
      parts: [
        { type: "tool-call" as const, toolCallId: "monitor-start", toolName: "Monitor", status: "complete" as const },
        { type: "monitor-activity" as const, monitors: [{ projection: monitor(), deliveryKeys: ["monitor:two"] }] },
      ],
    })],
    ["nested AskUser", monitorWake("2", monitor(), {
      parts: [
        {
          type: "subagent" as const,
          toolCallId: "agent-one",
          name: "worker",
          status: "complete" as const,
          calls: [{ toolCallId: "ask-one", toolName: "mcp__interaction__AskUser", status: "complete" as const }],
        },
        { type: "monitor-activity" as const, monitors: [{ projection: monitor(), deliveryKeys: ["monitor:two"] }] },
      ],
    })],
  ])("keeps %s as a presentation boundary", (_name, boundary) => {
    expect(coalesceMonitorWakeMessages([monitorWake("1"), boundary])).toHaveLength(2);
  });

  it.each(["user", "system", "assistant"] as const)(
    "does not join across an intervening %s message",
    (role) => {
      const separator = message({
        id: "separator",
        role,
        parts: role === "assistant" ? [{ type: "text", text: "Ordinary reply." }] : [],
      });
      const shaped = coalesceMonitorWakeMessages([
        monitorWake("1"),
        separator,
        monitorWake("2"),
      ]);
      expect(shaped.map((entry) => entry.id)).toEqual(["1", "separator", "2"]);
    },
  );

  it("keeps a receipt-bearing background launch as its own Monitor wake boundary", () => {
    const job = processJob();
    const launchWake = monitorWake("2", monitor(), {
      parts: [
        launchPart(job, "background-launch"),
        { type: "monitor-activity", monitors: [{ projection: monitor(), deliveryKeys: ["monitor:two"] }] },
      ],
    });
    expect(coalesceMonitorWakeMessages([monitorWake("1"), launchWake]).map(({ id }) => id)).toEqual(["1", "2"]);
    const withoutReceipt = {
      ...launchWake,
      parts: launchWake.parts.map((part) => part.type === "tool-call" ? { ...part, structuredResult: undefined } : part),
    };
    expect(coalesceMonitorWakeMessages([monitorWake("1"), withoutReceipt])).toHaveLength(1);
  });
});

describe("projectProcessJobPresentation", () => {
  const directAttribution = {
    requested: { model: "provider:selected" },
    attempted: { model: "provider:selected" },
    executed: { model: "provider:selected" },
    disposition: "requested" as const,
    transitions: [],
    retries: [],
  };

  it("extracts a job-only carrier without mutating it or retaining hidden ordinary attribution", () => {
    const source = message({
      role: "assistant",
      parts: [{ type: "process-job", job: processJob() }],
      attribution: directAttribution,
    });

    const projected = projectProcessJobPresentation([source], { selectedModel: "provider:selected" });

    expect(projected.messages).toEqual([]);
    expect(projected.jobs).toEqual([{ messageId: source.id, part: source.parts[0] }]);
    expect(source.parts).toHaveLength(1);
  });

  it("retains exceptional attribution, message errors, attachments, and rich sibling parts", () => {
    const visibleAttribution = message({
      id: "attributed",
      role: "assistant",
      parts: [{ type: "process-job", job: processJob({ jobId: "job-attributed" }) }],
      attribution: directAttribution,
    });
    const failed = message({
      id: "failed",
      role: "assistant",
      status: "failed",
      parts: [{ type: "process-job", job: processJob({ jobId: "job-failed" }) }],
    });
    const rich = message({
      id: "rich",
      role: "assistant",
      parts: [
        { type: "process-job", job: processJob({ jobId: "job-rich" }) },
        { type: "text", text: "The report is ready." },
        { type: "error", code: "artifact_warning", message: "One artifact expired." },
      ],
      attachments: [attachment("reply")],
    });

    const projected = projectProcessJobPresentation(
      [visibleAttribution, failed, rich],
      { selectedModel: "provider:other" },
    );

    expect(projected.messages.map(({ id }) => id)).toEqual(["attributed", "failed", "rich"]);
    expect(projected.messages[0]?.parts).toEqual([]);
    expect(projected.messages[1]?.parts).toEqual([]);
    expect(projected.messages[2]?.parts.map(({ type }) => type)).toEqual(["text", "error"]);
    expect(projected.messages[2]?.attachments).toEqual(rich.attachments);
  });

  it("keeps first-slot order while deduping each job to its newest monotonic projection and response", () => {
    const complete = processJob({ jobId: "job-one" });
    const running = processJob({
      jobId: "job-one",
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      output: { ...complete.output, stdoutBytes: 2, preview: "go" },
      exitCode: null,
      durationMs: null,
    });
    const stale = processJob({
      ...running,
      state: "starting",
      output: { ...running.output, stdoutBytes: 0, preview: "" },
    });
    const other = processJob({ jobId: "job-two", tool: "Bash", summary: "second" });
    const projected = projectProcessJobPresentation([
      message({ id: "first", role: "assistant", parts: [{ type: "process-job", job: running }] }),
      message({ id: "second", role: "assistant", parts: [{ type: "process-job", job: other }] }),
      message({ id: "stale", role: "assistant", parts: [{ type: "process-job", job: stale }] }),
      message({
        id: "settled",
        role: "assistant",
        parts: [{ type: "process-job", job: complete, responseText: "Completed normally." }],
      }),
    ]);

    expect(projected.messages).toEqual([]);
    expect(projected.jobs.map(({ messageId, part }) => [messageId, part.job.jobId, part.job.state]))
      .toEqual([
        ["first", "job-one", "succeeded"],
        ["second", "job-two", "succeeded"],
      ]);
    expect(projected.jobs[0]?.part.responseText).toBe("Completed normally.");
  });

  it("drops blank and transport-only siblings but preserves visible telemetry", () => {
    const hidden = message({
      id: "hidden",
      role: "assistant",
      parts: [
        { type: "process-job", job: processJob({ jobId: "hidden-job" }) },
        { type: "text", text: "  " },
        { type: "telemetry", event: "runtime_telemetry", data: { kind: "usage" } },
      ],
    });
    const visible = message({
      id: "visible",
      role: "assistant",
      parts: [
        { type: "process-job", job: processJob({ jobId: "visible-job" }) },
        { type: "telemetry", event: "context_compaction", data: {} },
      ],
    });

    expect(projectProcessJobPresentation([hidden, visible]).messages.map(({ id }) => id))
      .toEqual(["visible"]);
  });

  it("attributes real start and terminal facts only to the exact receipt-bearing response", () => {
    const job = processJob();
    const origin = message({
      id: "origin",
      threadId: "thread",
      role: "assistant",
      parts: [launchPart(job, "launch-one"), { type: "text", text: "Answer." }],
    });
    const carrier = message({
      id: "carrier",
      threadId: "thread",
      role: "assistant",
      parts: [{ type: "process-job", job }],
    });

    const projected = projectProcessJobPresentation([origin, carrier], { threadId: "thread" });

    expect(projected.messages.map(({ id }) => id)).toEqual(["origin"]);
    expect(projected.eventsByMessageId.get("origin")).toEqual([
      expect.objectContaining({ id: `process-job:${job.jobId}:started`, toolCallId: "launch-one", phase: "started", occurredAt: job.timestamps.startedAt }),
      expect.objectContaining({ id: `process-job:${job.jobId}:terminal`, toolCallId: "launch-one", phase: "terminal", state: "succeeded", occurredAt: job.timestamps.completedAt, durationMs: 2_000, exitCode: 0 }),
    ]);
    expect(projected.eventsByMessageId.has("carrier")).toBe(false);
  });

  it("keeps the start at launch but moves the terminal event to the chronological wake", () => {
    const job = processJob();
    const origin = message({
      id: "origin",
      threadId: "thread",
      role: "assistant",
      parts: [launchPart(job, "launch-one")],
    });
    const wake = message({
      id: "wake",
      threadId: "thread",
      role: "assistant",
      parts: [{
        type: "process-job-wake",
        jobId: job.jobId,
        deliveryKey: job.wake.deliveryKey,
        disposition: "follow_up",
      }],
    });
    const card = message({
      id: "card",
      threadId: "thread",
      role: "assistant",
      parts: [{ type: "process-job", job }],
    });

    const projected = projectProcessJobPresentation([origin, wake, card], { threadId: "thread" });
    expect(projected.eventsByMessageId.get("origin")).toEqual([
      expect.objectContaining({ phase: "started", toolCallId: "launch-one" }),
    ]);
    expect(convertWebMessage(wake, { processJobs: projected.jobsById }).content).toEqual([
      expect.objectContaining({
        type: "data-process-job-event",
        data: expect.objectContaining({ phase: "terminal", jobId: job.jobId, state: "succeeded" }),
      }),
    ]);
  });

  it.each([
    "succeeded", "failed", "timed_out", "cancelled", "spawn_failed", "queue_expired", "interrupted",
  ] as const)("derives the %s terminal outcome without inventing a missing completion", (state) => {
    const job = processJob({
      state,
      timestamps: { ...processJob().timestamps, startedAt: null, completedAt: null },
      durationMs: null,
      exitCode: null,
    });
    const projected = projectProcessJobPresentation([
      message({ id: "origin", threadId: "thread", role: "assistant", parts: [launchPart(job)] }),
      message({ id: "card", threadId: "thread", role: "assistant", parts: [{ type: "process-job", job }] }),
    ], { threadId: "thread" });
    expect(projected.eventsByMessageId.get("origin")).toEqual([
      expect.objectContaining({ phase: "terminal", state }),
    ]);
    expect(projected.eventsByMessageId.get("origin")?.[0]).not.toHaveProperty("occurredAt");
  });

  it.each(["queued", "starting"] as const)("does not invent a start for %s admission", (state) => {
    const job = processJob({
      state,
      timestamps: { ...processJob().timestamps, startedAt: null, completedAt: null },
      durationMs: null,
      exitCode: null,
    });
    const projected = projectProcessJobPresentation([
      message({ id: "origin", threadId: "thread", role: "assistant", parts: [launchPart(job)] }),
      message({ id: "card", threadId: "thread", role: "assistant", parts: [{ type: "process-job", job }] }),
    ], { threadId: "thread" });
    expect(projected.eventsByMessageId.size).toBe(0);
  });

  it("suppresses conflicting start evidence and contradictory completion time", () => {
    const job = processJob({
      timestamps: { ...processJob().timestamps, completedAt: "2026-07-17T09:59:59.000Z" },
    });
    const origin = message({
      id: "origin",
      threadId: "thread",
      role: "assistant",
      parts: [{ ...launchPart(job), structuredResult: processJobReceipt(job, { startedAt: "2026-07-17T10:00:02.000Z" }) }],
    });
    const projected = projectProcessJobPresentation([
      origin,
      message({ id: "card", threadId: "thread", role: "assistant", parts: [{ type: "process-job", job }] }),
    ], { threadId: "thread" });
    expect(projected.eventsByMessageId.get("origin")).toEqual([
      expect.objectContaining({ phase: "terminal", state: "succeeded" }),
    ]);
    expect(projected.eventsByMessageId.get("origin")?.[0]).not.toHaveProperty("occurredAt");
  });

  it("fails closed for ambiguous, wrong-thread, and legacy prose-only launch identity", () => {
    const job = processJob();
    const twoReceipts = ["one", "two"].map((id) => message({
      id,
      threadId: "thread",
      role: "assistant",
      parts: [launchPart(job, `launch-${id}`)],
    }));
    const card = message({ id: "card", threadId: "thread", role: "assistant", parts: [{ type: "process-job", job }] });
    expect(projectProcessJobPresentation([...twoReceipts, card], { threadId: "thread" }).eventsByMessageId.size).toBe(0);
    expect(projectProcessJobPresentation([twoReceipts[0]!, card], { threadId: "other" }).eventsByMessageId.size).toBe(0);
    const legacy = message({
      id: "legacy",
      threadId: "thread",
      role: "assistant",
      parts: [{ ...launchPart(job), structuredResult: undefined, result: JSON.stringify({ job_id: job.jobId }) }],
    });
    expect(projectProcessJobPresentation([legacy, card], { threadId: "thread" }).eventsByMessageId.size).toBe(0);
  });
});

describe("inline steer", () => {
  const steerPart = {
    type: "steer" as const,
    inputId: "input-1",
    messageId: "user-1",
    text: "Use the API instead, with the full operator prose intact",
    receivedAt: "2026-09-12T10:00:01.000Z",
    quote: { text: "the sync approach", messageId: "assistant-source" },
  };
  const appliedUser = (overrides: Partial<WebMessage> = {}): WebMessage => message({
    id: "user-1",
    threadId: "thread",
    role: "user",
    liveInputStatus: "applied",
    parts: [{ type: "text", text: steerPart.text }],
    ...overrides,
  });
  const steeredAssistant = (overrides: Partial<WebMessage> = {}): WebMessage => message({
    id: "assistant-1",
    threadId: "thread",
    role: "assistant",
    status: "complete",
    finishedAt: "2026-07-17T10:00:12.000Z",
    parts: [
      { type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete" },
      steerPart,
      { type: "tool-call", toolCallId: "t2", toolName: "Write", status: "complete" },
      { type: "text", text: "Done." },
    ],
    ...overrides,
  });

  it("converts a steer marker to a band-breaking data part carrying the full text", () => {
    const content = convertWebMessage(steeredAssistant({ status: "running" })).content as readonly {
      readonly type: string; readonly data?: { readonly text?: unknown; readonly quote?: unknown };
    }[];
    // Streaming keeps arrival order: the marker sits between the two calls.
    expect(content.map((part) => part.type)).toEqual(["tool-call", "data-steer", "tool-call", "text"]);
    expect(content[1]).toMatchObject({
      type: "data-steer",
      data: expect.objectContaining({ text: steerPart.text, quote: steerPart.quote }),
    });
  });

  it("holds activity before the steer before it and activity after it after it, answer last", () => {
    const content = convertWebMessage(steeredAssistant()).content as readonly { readonly type: string }[];
    expect(content.map((part) => part.type)).toEqual(["tool-call", "data-steer", "tool-call", "text"]);
    expect(content.at(-1)).toMatchObject({ type: "text" });
  });

  it("folds interim prose into notes inside its own segment rather than across the steer", () => {
    const content = convertWebMessage(steeredAssistant({
      parts: [
        { type: "text", text: "First I will look." },
        { type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete" },
        steerPart,
        { type: "text", text: "Now with the steer." },
        { type: "tool-call", toolCallId: "t2", toolName: "Write", status: "complete" },
        { type: "text", text: "Done." },
      ],
    })).content as readonly { readonly type: string }[];
    expect(content.map((part) => part.type)).toEqual([
      "data-note",
      "tool-call",
      "data-steer",
      "data-note",
      "tool-call",
      "text",
    ]);
  });

  it("keeps genuinely unknown data parts after the answer, not wedged at the steer", () => {
    const content = convertWebMessage(steeredAssistant({
      parts: [
        { type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete" },
        steerPart,
        { type: "error", message: "Agent error" },
        { type: "text", text: "Done." },
      ],
    })).content as readonly { readonly type: string }[];
    expect(content.map((part) => part.type)).toEqual(["tool-call", "data-steer", "text", "data-error"]);
  });

  it("drops the standalone bubble exactly once while its marker is loaded", () => {
    const projected = projectProcessJobPresentation(
      [appliedUser(), steeredAssistant()],
      { threadId: "thread" },
    );
    expect(projected.messages.map(({ id }) => id)).toEqual(["assistant-1"]);
  });

  it("keeps the standalone bubble when the marker's assistant message is paged out", () => {
    const projected = projectProcessJobPresentation([appliedUser()], { threadId: "thread" });
    expect(projected.messages.map(({ id }) => id)).toEqual(["user-1"]);
  });

  it("keeps two steers in one turn as two barriers, each with its own segment", () => {
    const secondSteer = { ...steerPart, inputId: "input-2", messageId: "user-2", text: "And keep the retry budget" };
    const secondUser = appliedUser({ id: "user-2", parts: [{ type: "text", text: secondSteer.text }] });
    const assistant = steeredAssistant({
      parts: [
        { type: "text", text: "First I will look." },
        { type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete" },
        steerPart,
        { type: "tool-call", toolCallId: "t2", toolName: "Write", status: "complete" },
        secondSteer,
        { type: "text", text: "Now with both steers." },
        { type: "tool-call", toolCallId: "t3", toolName: "Bash", status: "complete" },
        { type: "text", text: "Done." },
      ],
    });
    const content = convertWebMessage(assistant).content as readonly {
      readonly type: string; readonly data?: { readonly inputId?: unknown };
    }[];
    expect(content.map((part) => part.type)).toEqual([
      "data-note",
      "tool-call",
      "data-steer",
      "tool-call",
      "data-steer",
      "data-note",
      "tool-call",
      "text",
    ]);
    expect(content.filter((part) => part.type === "data-steer").map((part) => part.data?.inputId))
      .toEqual(["input-1", "input-2"]);
    // Both standalone bubbles go, each by its own marker.
    const projected = projectProcessJobPresentation([appliedUser(), secondUser, assistant], { threadId: "thread" });
    expect(projected.messages.map(({ id }) => id)).toEqual(["assistant-1"]);
  });

  it("keeps non-applied follow-ups standalone even beside an unrelated marker", () => {
    const pending = appliedUser({ id: "user-2", liveInputStatus: "pending" });
    const projected = projectProcessJobPresentation(
      [pending, appliedUser(), steeredAssistant()],
      { threadId: "thread" },
    );
    expect(projected.messages.map(({ id }) => id)).toEqual(["user-2", "assistant-1"]);
  });
});

describe("convertWebMessage", () => {
  it("derives transient run-attribution visibility from the selected model", () => {
    const requested = {
      requested: { model: "provider:requested" },
      attempted: { model: "provider:executed" },
      executed: { model: "provider:executed" },
      disposition: "requested" as const,
      transitions: [],
      retries: [],
    };
    const attributed = message({ role: "assistant", attribution: requested });

    expect(convertWebMessage(
      attributed,
      { selectedModel: "provider:selected" },
    ).metadata?.custom?.showRunAttribution).toBe(true);
    expect(convertWebMessage(
      attributed,
      { selectedModel: "provider:executed" },
    ).metadata?.custom?.showRunAttribution).toBe(false);
    expect(convertWebMessage(attributed).metadata?.custom?.showRunAttribution).toBe(false);
    expect(convertWebMessage(message()).metadata?.custom?.showRunAttribution).toBe(false);
    expect(convertWebMessage(message({
      role: "assistant",
      attribution: { ...requested, disposition: "fallback" },
    })).metadata?.custom?.showRunAttribution).toBe(true);
  });

  it("maps a retained process job and rich reply siblings into named data parts", () => {
    const job = processJob();
    const converted = convertWebMessage(message({
      role: "assistant",
      parts: [
        { type: "process-job", job, responseText: "Completed normally." },
        {
          type: "attachment",
          id: "job-attachment",
          artifactId: "job-artifact",
          name: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
          integrityId: `sha256:${"a".repeat(64)}`,
          contentUrl: "/api/v1/threads/thread-1/messages/message-1/reply-attachments/job-attachment/content?token=access",
        },
        { type: "failure", id: "job-failure", code: "artifact_missing", message: "File expired." },
      ],
    }));
    expect(converted.content).toEqual([
      {
        type: "data-process-job",
        data: { type: "process-job", job, responseText: "Completed normally." },
      },
      expect.objectContaining({
        type: "data-reply-attachment",
        data: expect.objectContaining({ id: "job-attachment", artifactId: "job-artifact" }),
      }),
      {
        type: "data-reply-failure",
        data: { type: "failure", id: "job-failure", code: "artifact_missing", message: "File expired." },
      },
    ]);
  });

  it.each(["running", "complete", "failed", "cancelled", "interrupted"] as const)(
    "keeps launch lifecycle rows adjacent for a %s response",
    (status) => {
      const job = processJob();
      const source = message({
        role: "assistant",
        status,
        parts: [launchPart(job, "launch"), { type: "text", text: "After launch." }],
      });
      const events = [
        { schema: "mono-agent.process-job-activity-event.v1" as const, id: `process-job:${job.jobId}:started`, toolCallId: "launch", jobId: job.jobId, tool: job.tool, summary: job.summary, phase: "started" as const, state: job.state, occurredAt: job.timestamps.startedAt! },
        { schema: "mono-agent.process-job-activity-event.v1" as const, id: `process-job:${job.jobId}:terminal`, toolCallId: "launch", jobId: job.jobId, tool: job.tool, summary: job.summary, phase: "terminal" as const, state: job.state, occurredAt: job.timestamps.completedAt! },
      ];
      const content = convertWebMessage(source, { processJobEvents: events }).content as readonly { readonly type: string }[];
      const types = content.map((part) => part.type);
      expect(types).toEqual(["tool-call", "data-process-job-event", "data-process-job-event", "text"]);
    },
  );

  it("separates consecutive receipt-bearing launches while ordinary adjacent calls still cluster", () => {
    const job = processJob();
    const second = processJob({ jobId: "job-two" });
    const launches = message({ role: "assistant", parts: [launchPart(job, "one"), launchPart(second, "two")] });
    const events = [job, second].flatMap((item, index) => [{
      schema: "mono-agent.process-job-activity-event.v1" as const,
      id: `process-job:${item.jobId}:started`,
      toolCallId: index === 0 ? "one" : "two",
      jobId: item.jobId,
      tool: item.tool,
      summary: item.summary,
      phase: "started" as const,
      state: item.state,
      occurredAt: item.timestamps.startedAt!,
    }, {
      schema: "mono-agent.process-job-activity-event.v1" as const,
      id: `process-job:${item.jobId}:terminal`,
      toolCallId: index === 0 ? "one" : "two",
      jobId: item.jobId,
      tool: item.tool,
      summary: item.summary,
      phase: "terminal" as const,
      state: item.state,
      occurredAt: item.timestamps.completedAt!,
    }]);
    const launchContent = convertWebMessage(launches, { processJobEvents: events }).content as readonly { readonly type: string }[];
    expect(launchContent.map((part) => part.type))
      .toEqual(["tool-call", "data-process-job-event", "data-process-job-event", "tool-call", "data-process-job-event", "data-process-job-event"]);

    const ordinary = message({ role: "assistant", parts: [
      { type: "tool-call", toolCallId: "one", toolName: "Exec", status: "complete" },
      { type: "tool-call", toolCallId: "two", toolName: "Exec", status: "complete" },
    ] });
    const ordinaryContent = convertWebMessage(ordinary).content as readonly { readonly type: string }[];
    expect(ordinaryContent.map((part) => part.type)).toEqual(["data-tool-cluster"]);
  });

  it("preserves attachment-only user messages without manufacturing text or running state", () => {
    const converted = convertWebMessage(
      message({
        attachments: [
          attachment("document", {
            name: "brief.pdf",
            contentType: "application/pdf",
            contentUrl: "/api/v1/uploads/document/content",
            uploaded: true,
          }),
        ],
      }),
    );

    expect(converted.content).toEqual([]);
    expect(converted).not.toHaveProperty("status");
    expect(converted.attachments?.[0]).toMatchObject({
      type: "document",
      content: [
        {
          type: "file",
          data: "/api/v1/uploads/document/content",
          filename: "brief.pdf",
        },
      ],
    });
  });

  it("maps image content URLs into safe persisted image attachment content", () => {
    const converted = convertWebMessage(
      message({
        attachments: [
          attachment("image", {
            name: "chart.png",
            contentType: "image/png",
            kind: "image",
            contentUrl: "/api/v1/uploads/image/content",
            uploaded: true,
          }),
        ],
      }),
    );

    expect(converted.attachments?.[0]?.content).toEqual([
      {
        type: "image",
        image: "/api/v1/uploads/image/content",
        filename: "chart.png",
      },
    ]);
  });

  it("guards that address against anything else the payload might carry", () => {
    // No path produces this today; the guard exists because the address is the
    // browser's cache key for bytes marked immutable for a year, and a token or
    // another origin reaching an <img src> would re-download them per response.
    const converted = convertWebMessage(
      message({
        attachments: [
          attachment("image", {
            name: "chart.png",
            contentType: "image/png",
            kind: "image",
            contentUrl: "https://cdn.example/chart.png?expires=1234567890&token=rotates",
            uploaded: true,
          }),
        ],
      }),
    );

    expect(converted.attachments?.[0]?.content).toEqual([
      { type: "image", image: "/api/v1/uploads/image/content", filename: "chart.png" },
    ]);
  });

  it("preserves visible parts while keeping persisted telemetry out of assistant-ui content", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "running",
        parts: [
          { type: "reasoning", text: "Inspecting" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "inspect",
            args: { depth: 2 },
            result: { ok: true },
            status: "complete",
            history: {
              recordId: "sth1_result",
              sequence: 2,
              persistence: "persisted",
              terminalState: "success",
              untrusted: true,
            },
          },
          { type: "telemetry", event: "usage_update", data: { tokens: { input: 10 } } },
          { type: "text", text: "Ready" },
        ],
      }),
    );

    expect(Array.isArray(converted.content)).toBe(true);
    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-call",
      "text",
    ]);
    expect(converted.content.find((part) => part.type === "tool-call")).toMatchObject({
      // `artifact` is an envelope, not the history record itself: it also carries an MCP
      // tool's structuredContent, which the AskUser card needs alongside the history.
      artifact: {
        history: {
          recordId: "sth1_result",
          sequence: 2,
          persistence: "persisted",
          terminalState: "success",
          untrusted: true,
        },
      },
    });
    expect(converted.status).toEqual({ type: "running" });
  });

  it("rejoins prose a stored telemetry part split in half", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        // Exactly what a turn stored before the runtime stopped splitting text
        // across invisible telemetry: one sentence, broken mid-word.
        parts: [
          { type: "text", text: "I'm re" },
          { type: "telemetry", event: "usage_update", data: { tokens: { input: 10 } } },
          { type: "text", text: "ally sorry" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([{ type: "text", text: "I'm really sorry" }]);
  });

  it("keeps Monitor activity compact without splitting one streamed word", () => {
    const projection = monitor();
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "complete",
      parts: [
        { type: "text", text: "The worker is re" },
        {
          type: "monitor-activity",
          monitors: [{ projection, deliveryKeys: ["monitor:one", "monitor:two"] }],
        },
        { type: "text", text: "ady." },
      ],
    }));

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([
      {
        type: "data-monitor-activity",
        data: {
          type: "monitor-activity",
          monitors: [{ projection, deliveryKeys: ["monitor:one", "monitor:two"] }],
        },
      },
      { type: "text", text: "The worker is ready." },
    ]);
  });

  it("uses assistant message boundaries to keep Monitor wake responses separate", () => {
    const boundary = {
      type: "telemetry" as const,
      event: "runtime_telemetry",
      data: { type: "runtime_telemetry", kind: "assistant_message_boundary" },
    };
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "complete",
      parts: [
        { type: "text", text: "Initial response." },
        boundary,
        {
          type: "monitor-activity",
          monitors: [{ projection: monitor(), deliveryKeys: ["monitor:one", "monitor:two"] }],
        },
        { type: "text", text: "First update." },
        boundary,
        { type: "text", text: "Second update." },
      ],
    }));

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "data-note",
      "data-monitor-activity",
      "data-note",
      "text",
    ]);
    expect(converted.content[0]).toEqual({ type: "data-note", data: { text: "Initial response." } });
    expect(converted.content[2]).toEqual({ type: "data-note", data: { text: "First update." } });
    expect(converted.content[3]).toEqual({ type: "text", text: "Second update." });
  });

  it("collapses legacy Monitor steering rows and uses context usage as their response boundary", () => {
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "cancelled",
      parts: [
        { type: "text", text: "First update." },
        {
          type: "tool-call",
          toolCallId: "live-input:monitor:first",
          toolName: "Steered: Monitor update",
          status: "complete",
        },
        {
          type: "telemetry",
          event: "runtime_telemetry",
          data: { type: "runtime_telemetry", kind: "context_usage" },
        },
        { type: "text", text: "Second update." },
        {
          type: "tool-call",
          toolCallId: "live-input:monitor:second",
          toolName: "Steered: Monitor update",
          status: "complete",
        },
      ],
    }));

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([
      { type: "text", text: "First update." },
      {
        type: "data-monitor-activity",
        data: { type: "monitor-activity", monitors: [], legacyUpdateCount: 2 },
      },
      { type: "text", text: "Second update." },
    ]);
  });

  it("keeps text either side of a delegation apart", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "text", text: "Let me check. " },
          { type: "subagent", toolCallId: "call-1", name: "researcher", status: "complete", calls: [] },
          { type: "text", text: "You have 12 tasks." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "data-note",
      "data-subagent",
      "text",
    ]);
  });

  it("folds a settled turn into one run of activity over the answer", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "reasoning", text: "Planning" },
          { type: "text", text: "Let me look at the inbox." },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "complete" },
          { type: "text", text: "Now the calendar." },
          { type: "tool-call", toolCallId: "t2", toolName: "Calendar", args: {}, status: "complete" },
          { type: "text", text: "Here is the summary." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    // Everything before the answer is adjacent, so the renderer coalesces it
    // into exactly one Activity disclosure instead of four interleaved ones.
    expect(converted.content.map((part) => part.type)).toEqual([
      "reasoning",
      "data-note",
      "tool-call",
      "data-note",
      "tool-call",
      "text",
    ]);
    expect(converted.content.at(0)).toEqual({ type: "reasoning", text: "Planning" });
    expect(converted.content.at(1)).toEqual({ type: "data-note", data: { text: "Let me look at the inbox." } });
    expect(converted.content.at(-1)).toEqual({ type: "text", text: "Here is the summary." });
  });

  it("leaves a running turn interleaved, because the answer is not written yet", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "running",
        parts: [
          { type: "text", text: "Let me look at the inbox." },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "running" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["text", "tool-call"]);
  });

  it("treats a turn cancelled mid-tool as all activity rather than inventing an answer", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "cancelled",
        parts: [
          { type: "reasoning", text: "Planning" },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "running" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["reasoning", "tool-call"]);
    expect(converted.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it.each(["cancelled", "failed", "interrupted"] as const)(
    "keeps a %s turn in arrival order, because its last prose is not an answer",
    (status) => {
      const converted = convertWebMessage(
        message({
          role: "assistant",
          status,
          parts: [
            { type: "text", text: "Let me look at the inbox." },
            { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "running" },
          ],
        }),
      );

      // A turn that never reached a final answer has only narration; hoisting
      // the tool above it would invert the chronology and dress the narration
      // up as the answer.
      if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
      expect(converted.content.map((part) => part.type)).toEqual(["text", "tool-call"]);
    },
  );

  it("keeps a run failure after the answer instead of letting it split the activity log", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "failed" },
          { type: "error", code: "provider_unavailable", message: "The agent run failed." },
          { type: "text", text: "I could not reach Gmail." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual([
      "tool-call",
      "text",
      "data-error",
    ]);
  });

  it("preserves distinct stable ids for repeated reply failures", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "failure", id: "failure-same-call-a", code: "app_resource_invalid", message: "First failure." },
          { type: "failure", id: "failure-same-call-b", code: "app_resource_invalid", message: "Second failure." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([
      expect.objectContaining({ type: "data-reply-failure", data: expect.objectContaining({ id: "failure-same-call-a" }) }),
      expect.objectContaining({ type: "data-reply-failure", data: expect.objectContaining({ id: "failure-same-call-b" }) }),
    ]);
  });

  it("drops blank interim prose rather than folding an empty note into the log", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          { type: "text", text: "  \n " },
          { type: "tool-call", toolCallId: "t1", toolName: "Gmail", args: {}, status: "complete" },
          { type: "text", text: "Done." },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["tool-call", "text"]);
  });

  it("keeps a settled user message exactly as stored", () => {
    const converted = convertWebMessage(
      message({
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Go ahead with group A." }],
      }),
    );

    expect(converted.content).toEqual([{ type: "text", text: "Go ahead with group A." }]);
  });

  it("skips a part type this bundle does not know instead of corrupting the transcript", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        // A precached console can outlive a server upgrade by a whole release.
        parts: [{ type: "from-a-newer-server" } as never, { type: "text", text: "Ready" }],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([{ type: "text", text: "Ready" }]);
  });

  it("converts a delegation into one named data part that keeps its nested calls", () => {
    const converted = convertWebMessage(
      message({
        role: "assistant",
        status: "complete",
        parts: [
          {
            type: "subagent",
            toolCallId: "call-1",
            name: "researcher",
            label: "read the router",
            status: "complete",
            executionMs: 12_400,
            result: "<subagent: researcher · ok>",
            calls: [
              { toolCallId: "agent:call-1:t1", toolName: "Read", args: { file_path: "/repo/a.ts" }, status: "complete" },
            ],
          },
          { type: "text", text: "Ready" },
        ],
      }),
    );

    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.map((part) => part.type)).toEqual(["data-subagent", "text"]);
    // assistant-ui tool-call parts carry no children, so the whole group has to
    // survive as one payload or the nesting is lost on the way to the renderer.
    expect(converted.content[0]).toMatchObject({
      type: "data-subagent",
      data: {
        name: "researcher",
        label: "read the router",
        status: "complete",
        calls: [{ toolCallId: "agent:call-1:t1", toolName: "Read" }],
      },
    });
  });

  it("keeps server-owned run attribution in assistant metadata", () => {
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "complete",
      attribution: {
        requested: { model: "primary" },
        executed: { model: "fallback", effectiveEffort: "xhigh" },
        disposition: "fallback",
        transitions: [{ from: "primary", to: "fallback", reason: "overloaded" }],
        retries: [],
      },
    }));

    expect(converted.metadata?.custom).toMatchObject({
      runStatus: "complete",
      attribution: {
        requested: { model: "primary" },
        executed: { model: "fallback", effectiveEffort: "xhigh" },
        disposition: "fallback",
      },
    });
  });

  it("exposes only canonical compaction telemetry as a named assistant-ui data part", () => {
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "running",
      parts: [
        { type: "telemetry", event: "usage_update", data: { tokens: { input: 10 } } },
        {
          type: "telemetry",
          event: "runtime_telemetry",
          data: {
            type: "runtime_telemetry",
            kind: "context_compaction",
            data: {
              operationId: "compact-1",
              status: "running",
              sdk: "pi",
              trigger: "proactive",
            },
          },
        },
      ],
    }));

    expect(converted.content).toEqual([
      {
        type: "data-context-compaction",
        data: {
          type: "runtime_telemetry",
          kind: "context_compaction",
          data: {
            operationId: "compact-1",
            status: "running",
            sdk: "pi",
            trigger: "proactive",
          },
        },
      },
    ]);
  });

  it("maps a persisted quote into assistant-ui message metadata", () => {
    const converted = convertWebMessage(message({
      quote: { text: "Quoted response", messageId: "source-message" },
      parts: [{ type: "text", text: "Follow up" }],
    }));

    expect(converted.metadata?.custom?.quote).toEqual({
      text: "Quoted response",
      messageId: "source-message",
    });
    expect(converted.content).toEqual([{ type: "text", text: "Follow up" }]);
  });

  it("exposes live follow-up delivery state as message metadata", () => {
    const converted = convertWebMessage(message({
      liveInputStatus: "queued",
      parts: [{ type: "text", text: "Use the smaller scope" }],
    }));

    expect(converted.metadata?.custom?.liveInputStatus).toBe("queued");
  });
  it("exposes the turn's finish stamp as message metadata, and nothing while running", () => {
    const base = {
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Done." }],
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:12.000Z",
    };
    const settled = convertWebMessage(message({ ...base, status: "complete", finishedAt: "2026-09-04T10:00:12.000Z" }));
    expect(settled.createdAt).toEqual(new Date("2026-09-04T10:00:00.000Z"));
    expect(settled.metadata?.custom?.finishedAt).toBe("2026-09-04T10:00:12.000Z");

    const running = convertWebMessage(message({ ...base, status: "running" }));
    expect(running.metadata?.custom).not.toHaveProperty("finishedAt");
  });
});

describe("runtime capability gates", () => {
  const activeThread = thread("thread", "agent");

  it("keeps degraded agents send-capable while they are connected", () => {
    expect(canSendInConsole("live", agent("agent", { status: "degraded" }), activeThread)).toBe(true);
  });

  it("disables sending offline, while reconnecting, and for archived/read-only threads", () => {
    expect(canSendInConsole("live", agent("agent", { status: "offline" }), activeThread)).toBe(false);
    expect(canSendInConsole("reconnecting", agent("agent"), activeThread)).toBe(false);
    expect(
      canSendInConsole(
        "live",
        agent("agent"),
        thread("archived", "agent", { archivedAt: "2026-07-17T12:00:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      canSendInConsole("live", agent("agent"), thread("readonly", "agent", { canSend: false })),
    ).toBe(false);
  });

  it("uses the same connection and capability checks for attachments", () => {
    expect(canUploadInConsole("live", agent("agent"), activeThread)).toBe(true);
    expect(canUploadInConsole("offline", agent("agent"), activeThread)).toBe(false);
    expect(canUploadInConsole("reconnecting", agent("agent"), activeThread)).toBe(false);
    expect(
      canUploadInConsole("live", agent("agent", { supportsAttachments: false }), activeThread),
    ).toBe(false);
    expect(
      canUploadInConsole("live", agent("agent"), thread("no-files", "agent", { canUpload: false })),
    ).toBe(false);
  });
});


it("renders a normalized Monitor answer below reasoning and activity", () => {
  const converted = convertWebMessage(message({ role: "assistant", parts: [
    { type: "monitor-activity", monitors: [{ projection: monitor(), deliveryKeys: ["monitor:one:1"] }] },
    { type: "reasoning", text: "Inspecting the pane." },
    { type: "text", text: "The worker is ready for Robert's review." },
    { type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "assistant_message_boundary" } },
    { type: "reasoning", text: "No new update." },
    { type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "assistant_message_boundary" } },
  ] }));
  if (typeof converted.content === "string") throw new Error("Expected structured content");
  expect(converted.content.at(-1)).toEqual({ type: "text", text: "The worker is ready for Robert's review." });
  expect(converted.content.filter((part) => part.type === "reasoning")).toEqual([
    { type: "reasoning", text: "Inspecting the pane." }, { type: "reasoning", text: "No new update." },
  ]);
  expect(converted.content.some((part) => part.type === "data-monitor-activity")).toBe(true);
  expect(converted.content.some((part) => part.type === "data-note")).toBe(false);
});

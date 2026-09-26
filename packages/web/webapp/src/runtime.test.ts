import { describe, expect, it } from "vitest";
import {
  canSendInConsole,
  canUploadInConsole,
  convertWebMessage,
} from "./runtime";
import { projectProcessJobPresentation } from "./process-job-presentation";
import { agent, attachment, processJob, thread } from "./test/fixtures";
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

    const projected = projectProcessJobPresentation([source]);

    expect(projected.messages).toEqual([]);
    expect(projected.jobs).toEqual([{ messageId: source.id, part: source.parts[0] }]);
    expect(source.parts).toHaveLength(1);
  });

  it("retains exceptional attribution, message errors, attachments, and rich sibling parts", () => {
    const visibleAttribution = message({
      id: "attributed",
      role: "assistant",
      parts: [{ type: "process-job", job: processJob({ jobId: "job-attributed" }) }],
      attribution: { ...directAttribution, disposition: "fallback" as const },
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

    const projected = projectProcessJobPresentation([visibleAttribution, failed, rich]);

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

describe("live input placement", () => {
  // The store orders every turn-bound user row before that turn's assistant
  // row, so this is the order a follow-up sent mid-run arrives in.
  const turnOne = (): readonly WebMessage[] => [
    message({ id: "user-1", threadId: "thread", turnId: "turn-1", role: "user", parts: [{ type: "text", text: "Start" }] }),
    message({
      id: "assistant-1",
      threadId: "thread",
      turnId: "turn-1",
      role: "assistant",
      status: "running",
      parts: [{ type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete" }],
    }),
  ];
  const followUp = (overrides: Partial<WebMessage> = {}): WebMessage => message({
    id: "user-steer",
    threadId: "thread",
    turnId: "turn-1",
    role: "user",
    liveInputStatus: "pending",
    parts: [{ type: "text", text: "Also check the retry budget" }],
    ...overrides,
  });
  const placement = (messages: readonly WebMessage[]): readonly string[] =>
    projectProcessJobPresentation(messages, { threadId: "thread" }).messages.map(({ id }) => id);

  it("holds a follow-up below the turn it is steering rather than above its work", () => {
    const [opening, running] = turnOne();
    expect(placement([opening!, followUp(), running!])).toEqual(["user-1", "assistant-1", "user-steer"]);
  });

  it("keeps that position for every status the bubble survives in", () => {
    for (const status of ["pending", "queued", "cancelled", "uncertain"] as const) {
      const [opening, running] = turnOne();
      expect(placement([opening!, followUp({ liveInputStatus: status }), running!]))
        .toEqual(["user-1", "assistant-1", "user-steer"]);
    }
  });

  it("keeps several follow-ups in the order they were sent", () => {
    const [opening, running] = turnOne();
    const first = followUp({ id: "steer-1" });
    const second = followUp({ id: "steer-2", liveInputStatus: "queued" });
    expect(placement([opening!, first, second, running!]))
      .toEqual(["user-1", "assistant-1", "steer-1", "steer-2"]);
  });

  it("stays inside its own turn when a later turn is loaded below it", () => {
    const [opening, running] = turnOne();
    const settled = message({ ...running!, status: "complete", parts: [{ type: "text", text: "Done." }] });
    const later = message({ id: "user-2", threadId: "thread", turnId: "turn-2", role: "user", parts: [{ type: "text", text: "Next" }] });
    expect(placement([opening!, followUp({ liveInputStatus: "cancelled" }), settled, later]))
      .toEqual(["user-1", "assistant-1", "user-steer", "user-2"]);
  });

  it("leaves the message that opened the turn where it is", () => {
    const [opening, running] = turnOne();
    expect(placement([opening!, running!])).toEqual(["user-1", "assistant-1"]);
  });

  it("keeps the server position when the steered turn has no other loaded message", () => {
    const later = message({ id: "user-2", threadId: "thread", turnId: "turn-2", role: "user", parts: [{ type: "text", text: "Next" }] });
    expect(placement([followUp(), later])).toEqual(["user-steer", "user-2"]);
    expect(placement([followUp({ turnId: undefined }), later])).toEqual(["user-steer", "user-2"]);
  });

  it("still renders an applied follow-up in place through its inline marker", () => {
    const [opening] = turnOne();
    const applied = followUp({ liveInputStatus: "applied", id: "user-steer" });
    const assistant = message({
      id: "assistant-1",
      threadId: "thread",
      turnId: "turn-1",
      role: "assistant",
      status: "complete",
      parts: [
        { type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete" },
        {
          type: "steer",
          inputId: "input-1",
          messageId: "user-steer",
          text: "Also check the retry budget",
          receivedAt: "2026-09-12T10:00:01.000Z",
        },
        { type: "text", text: "Done." },
      ],
    });
    expect(placement([opening!, applied, assistant])).toEqual(["user-1", "assistant-1"]);
  });
});

describe("convertWebMessage", () => {
  it("marks run attribution visible only for a run that deviated from its request", () => {
    const ran = {
      requested: { model: "provider:requested", effort: "high" },
      attempted: { model: "provider:requested", effort: "high", effectiveEffort: "high" },
      executed: { model: "provider:requested", effort: "high", effectiveEffort: "high" },
      disposition: "requested" as const,
      transitions: [],
      retries: [],
    };

    expect(convertWebMessage(message({ role: "assistant", attribution: ran }))
      .metadata?.custom?.showRunAttribution).toBe(false);
    expect(convertWebMessage(message()).metadata?.custom?.showRunAttribution).toBe(false);
    expect(convertWebMessage(message({
      role: "assistant",
      attribution: { ...ran, disposition: "fallback" },
    })).metadata?.custom?.showRunAttribution).toBe(true);
    expect(convertWebMessage(message({
      role: "assistant",
      attribution: { ...ran, retries: [{ model: "provider:requested", retryIndex: 1 }] },
    })).metadata?.custom?.showRunAttribution).toBe(true);
    expect(convertWebMessage(message({
      role: "assistant",
      status: "failed",
      attribution: { ...ran, executed: undefined, attempted: { model: "provider:other" } },
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
    "folds the launch call into its start row for a %s response",
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
      // One row for the launch (the started event carries its arguments) plus
      // the later terminal fact, then the answer.
      expect(types).toEqual(["data-process-job-event", "data-process-job-event", "text"]);
    },
  );

  it("folds the paired launch arguments into the started event", () => {
    const job = processJob();
    const launch = {
      ...launchPart(job, "launch"),
      args: { command: "node worker.js --launch", description: "Generate the report" },
    };
    const source = message({ role: "assistant", parts: [launch] });
    const events = [
      { schema: "mono-agent.process-job-activity-event.v1" as const, id: `process-job:${job.jobId}:started`, toolCallId: "launch", jobId: job.jobId, tool: job.tool, summary: job.summary, phase: "started" as const, state: job.state, occurredAt: job.timestamps.startedAt! },
    ];
    const content = convertWebMessage(source, { processJobEvents: events }).content as readonly {
      readonly type: string; readonly data?: Record<string, unknown>;
    }[];
    expect(content.map((part) => part.type)).toEqual(["data-process-job-event"]);
    expect(content[0]?.data).toMatchObject({
      id: `process-job:${job.jobId}:started`,
      phase: "started",
      launchArgs: { command: "node worker.js --launch", description: "Generate the report" },
    });
  });

  it("carries a truncated launch preview with its size so the row can offer a repair", () => {
    const job = processJob();
    const launch = {
      ...launchPart(job, "launch"),
      args: "HEAD-".repeat(8),
      argsTruncated: true as const,
      argsBytes: 20 * 1_024,
    };
    const source = message({ role: "assistant", parts: [launch] });
    const events = [
      { schema: "mono-agent.process-job-activity-event.v1" as const, id: `process-job:${job.jobId}:started`, toolCallId: "launch", jobId: job.jobId, tool: job.tool, summary: job.summary, phase: "started" as const, state: job.state, occurredAt: job.timestamps.startedAt! },
    ];
    const content = convertWebMessage(source, { processJobEvents: events }).content as readonly {
      readonly type: string; readonly data?: Record<string, unknown>;
    }[];
    expect(content.map((part) => part.type)).toEqual(["data-process-job-event"]);
    expect(content[0]?.data).toMatchObject({
      phase: "started",
      launchArgsTruncated: true,
      launchArgsBytes: 20 * 1_024,
    });
  });

  it("keeps the launch tool-call row when only a terminal event exists", () => {
    const job = processJob();
    const source = message({ role: "assistant", parts: [launchPart(job, "launch")] });
    const events = [
      { schema: "mono-agent.process-job-activity-event.v1" as const, id: `process-job:${job.jobId}:terminal`, toolCallId: "launch", jobId: job.jobId, tool: job.tool, summary: job.summary, phase: "terminal" as const, state: job.state, occurredAt: job.timestamps.completedAt! },
    ];
    const content = convertWebMessage(source, { processJobEvents: events }).content as readonly { readonly type: string }[];
    // No valid start produced a started event, so the launch row survives next
    // to the later terminal fact.
    expect(content.map((part) => part.type)).toEqual(["tool-call", "data-process-job-event"]);
  });

  it("keeps a failed launch as an ordinary error tool-call row", () => {
    const job = processJob();
    const failedLaunch = { ...launchPart(job, "launch"), status: "failed" as const };
    const source = message({ role: "assistant", parts: [failedLaunch] });
    const events = [
      { schema: "mono-agent.process-job-activity-event.v1" as const, id: `process-job:${job.jobId}:started`, toolCallId: "launch", jobId: job.jobId, tool: job.tool, summary: job.summary, phase: "started" as const, state: job.state, occurredAt: job.timestamps.startedAt! },
    ];
    const content = convertWebMessage(source, { processJobEvents: events }).content as readonly { readonly type: string }[];
    expect(content.map((part) => part.type)).toEqual(["tool-call", "data-process-job-event"]);
  });

  it("keeps an unpaired launch tool-call row without inventing an event", () => {
    const job = processJob();
    const source = message({ role: "assistant", parts: [launchPart(job, "launch")] });
    const content = convertWebMessage(source).content as readonly { readonly type: string }[];
    expect(content.map((part) => part.type)).toEqual(["tool-call"]);
  });

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
    // Each launch folds into its own started row; the later terminal fact stays
    // beside it. Ordinary same-tool calls still cluster.
    expect(launchContent.map((part) => part.type))
      .toEqual(["data-process-job-event", "data-process-job-event", "data-process-job-event", "data-process-job-event"]);

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

  it.each(["complete", "running", "cancelled", "failed", "interrupted"] as const)(
    "joins text split by a thought for %s replies", (status) => {
      const converted = convertWebMessage(message({ role: "assistant", status, parts: [
        { type: "text", text: "Tot" },
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "ally fair." },
      ] }));
      if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
      // The later text joins into the earlier part, so the reader always sees
      // one sentence; only the settled fold moves the thought row above it.
      expect(converted.content).toEqual(status === "complete" ? [
        { type: "reasoning", text: "hmm" }, { type: "text", text: "Totally fair." },
      ] : [
        { type: "text", text: "Totally fair." }, { type: "reasoning", text: "hmm" },
      ]);
    },
  );

  it.each(["running", "complete"] as const)(
    "drops a punctuation-only thought instead of rendering a step for %s replies", (status) => {
      const converted = convertWebMessage(message({
        role: "assistant",
        status,
        parts: [
          { type: "text", text: "The" },
          { type: "reasoning", text: "." },
          { type: "text", text: " targeted search only surfaced invoice threads." },
        ],
      }));
      if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
      // One sentence, no thought row — and with nothing else to group, no
      // empty activity card either.
      expect(converted.content).toEqual([
        { type: "text", text: "The targeted search only surfaced invoice threads." },
      ]);
    },
  );

  it.each(["", "   ", ".", "**", "… —"] as const)(
    "treats %j as a thought with no readable content", (text) => {
      const converted = convertWebMessage(message({
        role: "assistant",
        status: "running",
        parts: [{ type: "reasoning", text }],
      }));
      if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
      expect(converted.content).toEqual([]);
    },
  );

  it("keeps a thought that carries real content, punctuation included", () => {
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "running",
      parts: [
        { type: "text", text: "The" },
        { type: "reasoning", text: ". Let me check the inbox" },
        { type: "text", text: " targeted search continues." },
      ],
    }));
    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([
      { type: "text", text: "The targeted search continues." },
      { type: "reasoning", text: ". Let me check the inbox" },
    ]);
  });

  it("keeps an emoji-only thought as readable content", () => {
    const converted = convertWebMessage(message({
      role: "assistant",
      status: "running",
      parts: [{ type: "reasoning", text: "🤔" }],
    }));
    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content).toEqual([{ type: "reasoning", text: "🤔" }]);
  });

  it("keeps answer fragments together across reasoning, without joining tool narration", () => {
    const converted = convertWebMessage(message({
      role: "assistant", status: "complete",
      parts: [
        { type: "text", text: "Looking." },
        { type: "tool-call", toolCallId: "t1", toolName: "Search", args: {}, status: "complete" },
        { type: "reasoning", text: "Checking" },
        { type: "text", text: "Tot" },
        { type: "reasoning", text: "Hmm" },
        { type: "text", text: "ally" },
        { type: "reasoning", text: "More" },
        { type: "text", text: " " },
        { type: "reasoning", text: "Done" },
        { type: "text", text: "fair — yes." },
      ],
    }));
    if (!Array.isArray(converted.content)) throw new Error("Expected structured content");
    expect(converted.content.filter((part) => part.type === "text"))
      .toEqual([{ type: "text", text: "Totally fair — yes." }]);
    expect(converted.content.filter((part) => part.type === "data-note"))
      .toEqual([{ type: "data-note", data: { text: "Looking." } }]);
    expect(converted.content.filter((part) => part.type === "reasoning")).toHaveLength(4);
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


describe("restart proposal placement", () => {
  it("places the card directly after the settled answer, before other rich parts and outside activity", () => {
    const converted = convertWebMessage(message({ role: "assistant", parts: [
      { type: "tool-call", toolCallId: "read", toolName: "Read", status: "complete" },
      { type: "text", text: "The answer." },
      { type: "failure", id: "old", code: "unsupported_destination", message: "Other rich part." },
      { type: "restart_proposal", id: "proposal-1", reason: "Restart now", restartable: { state: "available" } },
    ] }));
    expect((converted.content as readonly { type: string }[]).map((part) => part.type)).toEqual([
      "tool-call", "text", "data-restart-proposal", "data-reply-failure",
    ]);
  });
});

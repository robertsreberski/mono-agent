import type * as W from "../../src/contracts.js";
import type { WebApiDtos } from "../../src/api-contract.js";

const at = "2030-01-02T12:00:00.000Z";
const thread = {
  id: "thread-example", sourceId: "agent-example", title: "Morgan's sample project",
  archivedAt: null, projectId: null, tagIds: [], createdAt: at, updatedAt: at,
  revision: 1, messageCount: 3, runState: { status: "idle" }, canSend: true,
  canUpload: true, runModel: null, runEffort: null,
} satisfies W.WebThread;
const tag = { id: "tag-example", sourceId: thread.sourceId, name: "Examples", color: "blue",
  createdAt: at, updatedAt: at, revision: 1 } satisfies W.WebTag;
const project = { id: "project-example", sourceId: thread.sourceId, name: "Sample project", context: "Fictional examples only.",
  archivedAt: null, createdAt: at, updatedAt: at, revision: 1, conversationCount: 1, runningCount: 0,
  monthUsd: null, monthKnownUsd: 0.02 } satisfies W.WebProject;
const attachment = { id: "upload-example", name: "example.txt", contentType: "text/plain", sizeBytes: 7,
  kind: "document", status: "staged", uploaded: false, createdAt: at } satisfies W.WebAttachment;
const upkeep = { version: 1, usageIncluded: false, operationId: "upkeep-example", runId: "run-example", conversationId: "conversation-example", model: "fictional:extractor-b", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null } as const;
const parts = [
  { type: "text", text: "Hello, Morgan." },
  { type: "reasoning", text: "Consider the example." },
  { type: "reply_options", id: "options-example", options: ["Continue", "Stop"] },
  { type: "restart_proposal", id: "restart-example", reason: "Apply example settings.", restartable: { state: "available" } },
  { type: "tool-call", toolCallId: "call-example", toolName: "Read", args: { path: "example.txt" }, result: "Example", status: "complete" },
  { type: "subagent", toolCallId: "delegate-example", name: "reviewer", status: "complete", calls: [], costUsd: null, knownCostUsd: 0.01 },
  { type: "process-job", job: {
    schema: "mono-agent.process-job-projection.v1", jobId: "job-example", tool: "Exec", state: "succeeded", summary: "Build example",
    origin: { conversationId: thread.id, channel: "web", runId: "turn-example", historyBoundary: "message-example", bucket: null },
    timestamps: { admittedAt: at, queueDeadlineAt: at, startedAt: at, runtimeDeadlineAt: at, completedAt: at },
    limits: { maxRuntimeMs: 60000, maxOutputBytes: 4096, previewChars: 200, chainDepth: 0 },
    output: { stdoutBytes: 7, stderrBytes: 0, truncated: false, preview: "Example", stdoutRef: null, stderrRef: null },
    wake: { state: "delivered", attempts: 1, deliveryKey: "wake-example", lastAttemptAt: at },
    exitCode: 0, signal: null, durationMs: 10, cancelRequested: false, lastError: null,
  } },
  { type: "scheduled-wake", occurrenceId: "occurrence-example", scheduledAt: at, firedAt: at, timezone: "UTC", message: "Check the example." },
  { type: "process-job-wake", jobId: "job-example", deliveryKey: "wake-example", disposition: "steered" },
  { type: "steer", inputId: "input-example", messageId: "message-user", text: "Use the small example.", receivedAt: at },
  { type: "telemetry", event: "runtime_warning", kind: "degraded_native_context", data: { message: "Example warning" } },
  { type: "error", code: "example_error", message: "Example unavailable." },
  { type: "attachment", id: "reply-example", artifactId: "artifact-example", name: "example.txt", mediaType: "text/plain", sizeBytes: 7, integrityId: "example-digest" },
  { type: "mcp_app", id: "app-example", invocationId: "invocation-example", connectionId: "connection-example", serverName: "example", toolName: "example", resourceUri: "ui://example/view", mediaType: "text/html;profile=mcp-app", protocolVersion: "2026-01-26" },
  { type: "failure", id: "failure-example", code: "artifact_missing", message: "Example artifact unavailable." },
  { type: "conversation-marker", at, kind: "model", before: { model: null, effort: null }, after: { model: "example/model", effort: "low" } },
  { type: "conversation-marker", at, kind: "project", before: null, after: { id: project.id, name: project.name, color: "blue" } },
  { type: "conversation-marker", at, kind: "resumed", previousMessageAt: at, idleMs: 60000 },
  { type: "conversation-marker", at, kind: "compaction", operationId: "compact-example", trigger: "manual", status: "succeeded", tokensBefore: 200, tokensAfter: 100 },
  { type: "cron-reply-context", schema: "mono-agent.web.cron-reply-context.v1", untrusted: true,
    source: { sourceId: thread.sourceId, jobId: "cron-example", runId: "cron-run-example" },
    run: { sequence: 1, trigger: "scheduled", status: "succeeded", scheduledAt: at, orderedAt: at },
    snapshot: { capturedAt: at, kind: "summary", sourceTruncationKnown: true, sourceFieldsTruncated: [], maxBytes: 4096,
      originalErrorBytes: 0, retainedErrorBytes: 0, originalResultBytes: 7, retainedResultBytes: 7, truncatedFields: [] },
    result: { text: "Example" }, failure: {}, prefix: "Example cron result", rawJson: "{}", rawText: "Example cron result {}" },
] satisfies readonly W.WebMessagePart[];
const message = { id: "message-example", threadId: thread.id, turnId: "turn-example", role: "assistant", parts,
  attachments: [], createdAt: at, updatedAt: at, finishedAt: at, status: "complete", seq: 1 } satisfies W.WebMessage;
const messages: readonly W.WebMessage[] = [
  { ...message, id: "message-user", role: "user", parts: [{ type: "text", text: "Show an example." }], attachments: [{ ...attachment, status: "committed", uploaded: true }] },
  message,
  { ...message, id: "message-system", role: "system", parts: [{ type: "text", text: "Example notice." }] },
];
const delta = { messageId: message.id, baseSeq: 1, seq: 2, status: "complete", updatedAt: at,
  ops: [{ op: "append", index: 0, delta: " Welcome." }] } satisfies W.WebMessageDelta;
const payloads = {
  ready: { version: 1 }, "agents.changed": undefined, "cron.changed": { sourceId: thread.sourceId },
  "threads.changed": { thread }, "thread.changed": { thread }, "tags.changed": { tag },
  "projects.changed": { project }, "message.changed": { messageId: message.id, updatedAt: at },
  "message.delta": delta, "turn.changed": { turn: thread.runState }, "attachment.changed": { attachment },
  "push.pending": { eventId: "push-example", threadId: thread.id, ackToken: "fictional-ack-token" },
} satisfies W.WebEventPayloadMap;

function fixture<K extends keyof WebApiDtos>(name: string, type: K, value: WebApiDtos[K]) {
  return { name, type, value };
}

export const FIXTURES = [
  fixture("upkeep-message", "ApiMessage", { message: { ...message, parts: [{ type: "telemetry", event: "runtime_telemetry", kind: "continuity_upkeep", data: { kind: "continuity_upkeep", data: { accounting: upkeep } } }] } }),
  fixture("upkeep-thread-usage", "ApiThreadUsage", { usage: { total: { costUsd: null, knownCostUsd: 0.01, costPartial: true }, upkeep: { operations: 1, pending: true, costUsd: null, knownCostUsd: 0, costPartial: true, tokensPartial: true }, byModel: [{ model: "fictional:answer-a", costUsd: 0.01 }, { model: upkeep.model, costUsd: null, knownCostUsd: 0 }], computedAt: at } }),
  fixture("upkeep-running", "ApiActiveThreads", { threads: [{ ...thread, runState: { status: "running", activity: { toolCallCount: 0, phase: "working", cumulativeUsd: null, knownCostUsd: 0.01, upkeep: { operations: 1, pending: true, models: [upkeep.model], costUsd: null, knownCostUsd: 0 } } } }], runningCounts: { [thread.sourceId]: 1 }, total: 1, truncated: false }),
  fixture("bootstrap", "ApiBootstrap", { version: 1, console: { hostName: "console.example.ts.net", displayName: "Example console", theme: "evergreen" },
    push: { applicationServerKey: "fictional-public-key", keyFingerprint: "example", serviceWorkerVersion: 2 },
    agents: [{ sourceId: thread.sourceId, label: "Example agent", status: "online", pinned: false, supportsAttachments: true, runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } }, updatedAt: at }],
    threads: [thread], threadsSourceId: thread.sourceId, threadsNextCursor: null, tags: [tag], projects: [project], projectsSourceId: thread.sourceId,
    limits: { maxFileBytes: 20971520, maxFilesPerTurn: 10, maxTurnBytes: 67108864, accept: ["text/plain"] } }),
  fixture("thread-page", "ApiThreadPage", { threads: [thread], nextCursor: "opaque-example-cursor" }),
  fixture("thread-detail", "ApiThreadDetail", { thread, messages }),
  fixture("message-page", "ApiMessagePage", { messages }),
  fixture("upload-create-request", "ApiCreateUpload", { name: attachment.name, contentType: attachment.contentType, sizeBytes: 7 }),
  fixture("upload-create", "ApiUpload", { attachment }),
  fixture("submission-request", "ApiStartSubmission", { submissionId: "submission-example", text: "Show an example.", attachmentIds: [attachment.id] }),
  fixture("submission-receipt", "ApiSubmissionReceipt", { submissionId: "submission-example", threadId: thread.id, outcome: "turn", messageId: "message-user", turnId: "turn-example", turn: thread.runState }),
  fixture("ask", "ApiAsk", { ask: { interactionId: "ask-example", message: "Choose an example", questions: [{ id: "question-example", header: "Example", question: "Which size?", multiSelect: false,
    options: [{ id: "small", label: "Small", description: "A short example" }] }], answers: [], activeQuestionIndex: 0, status: "pending", createdAt: at, expiresAt: null } }),
  fixture("ask-answer", "ApiAnswerAsk", { interactionId: "ask-example", answers: [{ questionId: "question-example", selectedOptionIds: ["small"] }] }),
  fixture("wake-schedule", "ApiWakeSchedule", { schedule: { scheduleId: "schedule-example", threadId: thread.id, sourceId: thread.sourceId,
    definition: { kind: "weekly", timezone: "UTC", days: [1, 3], times: ["09:00"], message: "Review the example.", compactFirst: false }, state: "active", revision: 1, nextFireAt: "2030-01-07T09:00:00.000Z", lastOutcome: null, createdAt: at } }),
  fixture("project", "ApiProject", { project }), fixture("tag", "ApiTag", { tag }),
  fixture("provider-usage", "ApiProviderUsage", { schema: "mono-agent.provider-usage.v1", providers: [{ providerId: "anthropic", label: "Claude", fetchedAt: at, stale: false,
    windows: [{ kind: "session", label: "Session", usedPercent: 25, periodMs: 18000000, resetsAt: "2030-01-02T15:00:00.000Z" }] }] }),
  fixture("cron-overview", "ApiCronOverview", { generatedAt: at, actionsEnabled: true, jobs: [{ jobId: "cron-example", conversationId: "cron-conversation-example", threadId: "cron-thread-example",
    expression: "0 9 * * 1", timezone: "UTC", configured: true, declaredEnabled: true, effectiveEnabled: true, health: "healthy" }] }),
  ...Object.entries(payloads).map(([type, payload], index) => ({ name: `event-${type}`, type: "ApiEvent" as const,
    value: { id: `event-${index}`, version: 1, type, at, ...(type === "ready" || type === "agents.changed" ? {} : { threadId: thread.id }),
      ...(payload === undefined ? {} : { payload }) } })),
  fixture("event-agent-pin", "ApiEvent", { id: "event-pin", version: 1, type: "agents.changed", at, payload: { sourceId: thread.sourceId, pinned: true } }),
  fixture("event-tag-removed", "ApiEvent", { id: "event-tag-remove", version: 1, type: "tags.changed", at, payload: { tagId: tag.id, removed: true } }),
  fixture("event-project-removed", "ApiEvent", { id: "event-project-remove", version: 1, type: "projects.changed", at, payload: { projectId: project.id, removed: true } }),
  fixture("event-attachment-removed", "ApiEvent", { id: "event-upload-remove", version: 1, type: "attachment.changed", at, payload: { attachmentId: attachment.id, removed: true } }),
  fixture("compaction", "ApiCompaction", { status: "skipped", operationId: "compaction-example", trigger: "manual", reason: "nothing_to_compact" }),
  fixture("event-threads-invalidation", "ApiEvent", { id: "event-invalidate", version: 1, type: "threads.changed", at }),
  fixture("event-thread-removed", "ApiEvent", { id: "event-remove", version: 1, type: "thread.changed", at, threadId: thread.id, payload: { threadId: thread.id, removed: true } }),
];

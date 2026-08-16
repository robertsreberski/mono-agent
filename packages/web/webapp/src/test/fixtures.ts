import type {
  AgentSummary,
  Bootstrap,
  ThreadSummary,
  UploadLimits,
  WebAttachment,
  ProcessJobProjection,
} from "../types";

export const uploadLimits: UploadLimits = {
  maxFileBytes: 20,
  maxFilesPerTurn: 10,
  maxTurnBytes: 100,
  accept: ["image/png", "text/markdown", "text/csv", "application/pdf"],
};

export const attachment = (
  id: string,
  overrides: Partial<WebAttachment> = {},
): WebAttachment => ({
  id,
  name: `${id}.txt`,
  contentType: "text/plain",
  sizeBytes: 4,
  kind: "document",
  status: "staged",
  uploaded: false,
  createdAt: "2026-07-17T10:00:00.000Z",
  ...overrides,
});

export const agent = (
  sourceId: string,
  overrides: Partial<AgentSummary> = {},
): AgentSummary => ({
  sourceId,
  label: sourceId.toUpperCase(),
  status: "online",
  pinned: false,
  supportsAttachments: true,
  models: ["provider/model"],
  defaultModel: "provider/model",
  updatedAt: "2026-07-17T10:00:00.000Z",
  ...overrides,
});

export const thread = (
  id: string,
  sourceId: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary => ({
  id,
  sourceId,
  title: id,
  archivedAt: null,
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  revision: 1,
  messageCount: 0,
  runState: { status: "idle" },
  canSend: true,
  canUpload: true,
  ...overrides,
});

export const processJob = (
  overrides: Partial<ProcessJobProjection> = {},
): ProcessJobProjection => ({
  schema: "mono-agent.process-job-projection.v1",
  jobId: "11111111-1111-4111-8111-111111111111",
  tool: "Exec",
  state: "succeeded",
  summary: "node worker.js --safe-summary",
  origin: {
    conversationId: "web:thread",
    channel: "web",
    runId: "run-one",
    historyBoundary: "web:thread",
    bucket: null,
  },
  timestamps: {
    admittedAt: "2026-07-17T10:00:00.000Z",
    queueDeadlineAt: "2026-07-17T10:05:00.000Z",
    startedAt: "2026-07-17T10:00:01.000Z",
    runtimeDeadlineAt: "2026-07-17T10:30:01.000Z",
    completedAt: "2026-07-17T10:00:03.000Z",
  },
  limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1_048_576, previewChars: 2_000, chainDepth: 0 },
  output: {
    stdoutBytes: 5,
    stderrBytes: 0,
    truncated: false,
    preview: "done\n",
    stdoutRef: "artifacts/11111111-1111-4111-8111-111111111111/stdout.log",
    stderrRef: "artifacts/11111111-1111-4111-8111-111111111111/stderr.log",
  },
  wake: {
    state: "delivered",
    attempts: 1,
    deliveryKey: "process-job:11111111-1111-4111-8111-111111111111",
    lastAttemptAt: "2026-07-17T10:00:04.000Z",
  },
  exitCode: 0,
  signal: null,
  durationMs: 2_000,
  cancelRequested: false,
  lastError: null,
  ...overrides,
});

export const bootstrap = (
  agents: Bootstrap["agents"],
  threads: Bootstrap["threads"],
  currentThreadId?: string,
): Bootstrap => ({
  version: 1,
  console: { hostName: "test-host", theme: "evergreen" },
  push: {
    applicationServerKey: "B".repeat(87),
    keyFingerprint: "test-fingerprint",
    serviceWorkerVersion: 2,
  },
  agents,
  threads,
  currentThreadId,
  limits: uploadLimits,
});

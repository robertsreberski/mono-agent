import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessJobProjection, ProcessJobState } from "@mono-agent/agent-contracts";

import type { DiscoveredOperatorAgent } from "../discovery.js";
import type { WebSkillRegistry } from "../contracts.js";

type OperatorSkillRegistry =
  | Extract<WebSkillRegistry, { readonly status: "ready" }>
  | { readonly status: "error"; readonly items: readonly [] };

export async function temporaryRoot(prefix = "mono-agent-web-"): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export function fakeDiscoveredAgent(overrides: Partial<DiscoveredOperatorAgent> = {}): DiscoveredOperatorAgent {
  return {
    source: {
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: "/tmp/agent-one-artifacts",
      pid: 123,
      status: "running",
      health: "running",
      startedAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T09:00:00.000Z",
      warnings: [],
    },
    baseUrl: "http://127.0.0.1:45123/gui",
    ...overrides,
  };
}

export function fakeProcessJob(options: {
  readonly state?: ProcessJobState;
  readonly conversationId?: string;
  readonly jobId?: string;
  readonly wakeState?: "pending" | "delivered" | "failed";
  readonly preview?: string;
} = {}): ProcessJobProjection {
  const state = options.state ?? "running";
  const terminal = ["succeeded", "failed", "timed_out", "cancelled", "spawn_failed", "queue_expired", "interrupted"]
    .includes(state);
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: options.jobId ?? "11111111-1111-4111-8111-111111111111",
    tool: "Exec",
    state,
    summary: "node worker.js --safe-summary",
    origin: {
      conversationId: options.conversationId ?? "web:thread-one",
      channel: "web",
      runId: "run-one",
      historyBoundary: options.conversationId ?? "web:thread-one",
      bucket: null,
    },
    timestamps: {
      admittedAt: "2026-07-21T09:00:00.000Z",
      queueDeadlineAt: "2026-07-21T09:05:00.000Z",
      startedAt: state === "queued" ? null : "2026-07-21T09:00:01.000Z",
      runtimeDeadlineAt: state === "queued" ? null : "2026-07-21T09:30:01.000Z",
      completedAt: terminal ? "2026-07-21T09:00:03.000Z" : null,
    },
    limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1_048_576, previewChars: 2_000, chainDepth: 0 },
    output: {
      stdoutBytes: terminal ? 5 : 0,
      stderrBytes: 0,
      truncated: false,
      preview: options.preview ?? (terminal ? "done\n" : ""),
      stdoutRef: "artifacts/11111111-1111-4111-8111-111111111111/stdout.log",
      stderrRef: "artifacts/11111111-1111-4111-8111-111111111111/stderr.log",
    },
    wake: {
      state: options.wakeState ?? "pending",
      attempts: options.wakeState === undefined ? 0 : 1,
      deliveryKey: `process-job:${options.jobId ?? "11111111-1111-4111-8111-111111111111"}`,
      lastAttemptAt: options.wakeState === undefined ? null : "2026-07-21T09:00:04.000Z",
    },
    exitCode: state === "succeeded" ? 0 : null,
    signal: null,
    durationMs: terminal ? 2_000 : null,
    cancelRequested: state === "cancelled",
    lastError: state === "failed" ? { code: "process_job_failed", message: "Exited with code 1." } : null,
  };
}

export function fakeMemoryCapability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    backend: "builtin",
    tier: "bujo",
    status: "ready",
    read: true,
    actions: true,
    graph: "captured",
    ...overrides,
  };
}

export function fakeMemoryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "memory-1",
    revision: "a".repeat(64),
    lifecycle: "active",
    type: "note",
    status: "open",
    text: "Prefers concise summaries",
    salience: 0.8,
    isInsight: true,
    createdAt: "2026-08-24T10:00:00.000Z",
    accessCount: 2,
    tags: ["preference"],
    ...overrides,
  };
}

export function fakeMemoryOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-08-24T10:00:00.000Z",
    capability: fakeMemoryCapability(),
    counts: {
      total: 1,
      active: 1,
      superseded: 0,
      forgotten: 0,
      byType: { task: 0, event: 0, note: 1 },
    },
    access: { totalCount: 2, accessedRecords: 1 },
    ...overrides,
  };
}

export function fakeMemoryOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "operation-1",
    action: "edit",
    recordId: "memory-1",
    status: "queued",
    createdAt: "2026-08-24T10:01:00.000Z",
    updatedAt: "2026-08-24T10:01:00.000Z",
    resultRecordId: "memory-2",
    ...overrides,
  };
}

export function operatorFetch(options: {
  readonly turns?: (body: Record<string, unknown>) => string | ReadableStream<Uint8Array>;
  readonly supportsAttachments?: boolean;
  readonly supportsHistoryAppend?: boolean;
  readonly supportsAskUser?: boolean;
  readonly supportsAskById?: boolean;
  readonly supportsLiveInput?: boolean;
  readonly supportsReplyAttachments?: boolean;
  readonly supportsMcpApps?: boolean;
  readonly supportsJobs?: boolean;
  readonly jobs?: readonly ProcessJobProjection[];
  readonly onJobRequest?: (jobId: string, authorization: string | null) => void;
  readonly jobForRequest?: (jobId: string) => ProcessJobProjection | undefined;
  readonly skills?: OperatorSkillRegistry;
  readonly pendingAsk?: Record<string, unknown> | null;
  readonly exactAsks?: Readonly<Record<string, Record<string, unknown> | null>>;
  readonly cronOverview?: Record<string, unknown>;
  readonly cronRuns?: Record<string, unknown>;
  readonly cronRun?: Record<string, unknown>;
  readonly cronConfigView?: Record<string, unknown>;
  readonly onCronMutation?: (url: string, body: Record<string, unknown>) => Record<string, unknown>;
  readonly memoryCapability?: unknown;
  readonly onMemoryRequest?: (
    url: string,
    init: RequestInit | undefined,
    body: Record<string, unknown> | undefined,
  ) => Response | undefined | Promise<Response | undefined>;
  readonly onAskSubmit?: (body: Record<string, unknown>) => void;
  readonly onTurn?: (body: Record<string, unknown>) => void;
  readonly onLiveInput?: (
    conversationId: string,
    body: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly onVerbatim?: (conversationId: string, body: Record<string, unknown>) => void | Promise<void>;
  readonly onReplyArtifact?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  readonly onMcpAppResource?: (url: string, init?: RequestInit) => Record<string, unknown>;
  readonly onMcpAppRequest?: (
    url: string,
    body: Record<string, unknown>,
    init?: RequestInit,
  ) => unknown | Response;
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/info")) {
      return Response.json({
        schema: 1,
        label: "Agent One",
        model: "provider/default",
        effort: "medium",
        models: ["provider/default", "provider/fallback"],
        modelOptions: {
          "provider/default": {
            effortLevels: ["low", "medium", "high"],
            reasoning: true,
            contextWindow: 128_000,
          },
          "provider/fallback": { effortLevels: ["low", "high"], reasoning: true },
        },
        ...(options.skills === undefined ? {} : { skills: options.skills }),
        capabilities: {
          attachments: options.supportsAttachments ?? true,
          ...(options.supportsHistoryAppend === true ? { historyAppend: true } : {}),
          askUser: options.supportsAskUser ?? false,
          ...(options.supportsAskById === true ? { askById: true } : {}),
          liveInput: options.supportsLiveInput ?? false,
          ...(options.supportsReplyAttachments === true
            ? { replyAttachments: { version: 1, maxBytes: 20 * 1024 * 1024 } }
            : {}),
          ...(options.supportsMcpApps === true
            ? {
                mcpApps: {
                  bridgeVersion: 1,
                  versions: ["2026-01-26"],
                  mimeTypes: ["text/html;profile=mcp-app"],
                },
              }
            : {}),
          ...(options.cronOverview === undefined
            ? {}
            : { cron: { read: true, actions: options.onCronMutation !== undefined } }),
          ...(options.memoryCapability === undefined ? {} : { memory: options.memoryCapability }),
          ...(options.supportsJobs === true ? { jobs: true } : {}),
        },
      });
    }
    if (url.includes("/v1/memory")) {
      const pathname = new URL(url).pathname;
      const recordRoute = /\/v1\/memory\/records\/([^/]+)(?:\/(forget|restore))?$/u.exec(pathname);
      const requestedRecordId = recordRoute?.[1] === undefined ? undefined : decodeURIComponent(recordRoute[1]);
      const operationRoute = /\/v1\/memory\/operations\/([^/]+)$/u.exec(pathname);
      const requestedOperationId = operationRoute?.[1] === undefined
        ? undefined
        : decodeURIComponent(operationRoute[1]);
      const body = init?.body === undefined
        ? undefined
        : JSON.parse(String(init.body)) as Record<string, unknown>;
      const custom = await options.onMemoryRequest?.(url, init, body);
      if (custom !== undefined) return custom;
      if (url.endsWith("/v1/memory")) {
        return Response.json({ overview: fakeMemoryOverview() });
      }
      if (url.includes("/v1/memory/operations/")) {
        return Response.json({
          operation: fakeMemoryOperation({
            status: "succeeded",
            ...(requestedOperationId === undefined ? {} : { id: requestedOperationId }),
          }),
        });
      }
      if (url.endsWith("/graph") || url.includes("/graph?")) {
        return Response.json({ graph: { fidelity: "captured", nodes: [], edges: [] } });
      }
      if (url.endsWith("/forget") && body?.confirmationToken === undefined) {
        return Response.json({
          kind: "confirmation_required",
          confirmation: {
            token: "confirm-forget",
            expiresAt: "2026-08-24T10:06:00.000Z",
            message: "Confirm this memory action?",
          },
        }, { status: 428 });
      }
      if (init?.method === "PATCH" || init?.method === "POST") {
        const action = url.endsWith("/forget") ? "forget" : url.endsWith("/restore") ? "restore" : "edit";
        return Response.json({
          kind: "queued",
          operation: fakeMemoryOperation({
            action,
            ...(requestedRecordId === undefined ? {} : { recordId: requestedRecordId }),
            ...(action === "forget" ? { resultRecordId: undefined } : {}),
          }),
        }, { status: 202 });
      }
      if (/\/v1\/memory\/records\/[^/?]+(?:\?|$)/u.test(url)) {
        return Response.json({
          record: fakeMemoryRecord(requestedRecordId === undefined ? {} : { id: requestedRecordId }),
          history: [],
        });
      }
      return Response.json({ records: [fakeMemoryRecord()] });
    }
    if (url.endsWith("/v1/cron")) {
      return options.cronOverview === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(options.cronOverview);
    }
    if (url.endsWith("/v1/cron/config-view")) {
      return Response.json({ configView: options.cronConfigView ?? { id: "cron", label: "Cron", status: "active", fields: [] } });
    }
    if (/\/v1\/cron\/jobs\/[^/]+\/runs\/[^/?]+(?:\?|$)/u.test(url)) {
      return Response.json({ run: options.cronRun ?? {} });
    }
    if (url.includes("/v1/cron/jobs/") && url.includes("/runs")) {
      return Response.json(options.cronRuns ?? { runs: [] });
    }
    if (url.includes("/v1/cron/jobs/") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const response = options.onCronMutation?.(url, body);
      return response === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(response, { status: response.kind === "confirmation_required" ? 428 : 200 });
    }
    if (url.includes("/v1/interactions/")) {
      const interactionId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      return Response.json({ ask: options.exactAsks?.[interactionId] ?? null });
    }
    const jobMatch = /\/v1\/jobs\/([^/?]+)$/u.exec(url);
    if (jobMatch?.[1] !== undefined) {
      const jobId = decodeURIComponent(jobMatch[1]);
      options.onJobRequest?.(jobId, new Headers(init?.headers).get("authorization"));
      const job = options.jobForRequest === undefined
        ? options.jobs?.find((candidate) => candidate.jobId === jobId)
        : options.jobForRequest(jobId);
      return job === undefined
        ? Response.json({ error: { code: "process_job_not_found", message: "Process job was not found." } }, { status: 404 })
        : Response.json(job);
    }
    if (url.endsWith("/v1/turns")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      options.onTurn?.(body);
      const responseBody = options.turns?.(body) ?? [
        JSON.stringify({ kind: "append", delta: "Hello " }),
        JSON.stringify({ kind: "event", event: { type: "assistant_thought", text: "Reasoning" } }),
        JSON.stringify({ kind: "append", delta: "world" }),
        JSON.stringify({ kind: "finish", finalText: "Hello world" }),
        "",
      ].join("\n");
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/cancel")) {
      return Response.json({ cancelled: true }, { status: 202 });
    }
    if (url.includes("/reply-artifacts/")) {
      return await options.onReplyArtifact?.(url, init) ?? new Response("not found", { status: 404 });
    }
    if (url.includes("/mcp-apps/") && url.endsWith("/requests")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const result = options.onMcpAppRequest?.(url, body, init) ?? null;
      return result instanceof Response ? result : Response.json({ result });
    }
    if (url.includes("/mcp-apps/")) {
      const resource = options.onMcpAppResource?.(url, init);
      return resource === undefined ? new Response("not found", { status: 404 }) : Response.json(resource);
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/live-input")) {
      const encodedConversationId = url.slice(
        url.lastIndexOf("/v1/conversations/") + "/v1/conversations/".length,
        -"/live-input".length,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const result = await options.onLiveInput?.(decodeURIComponent(encodedConversationId), body)
        ?? { status: "applied", runId: "run-1" };
      return Response.json(result, { status: 200 });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/verbatim")) {
      const encodedConversationId = url.slice(
        url.lastIndexOf("/v1/conversations/") + "/v1/conversations/".length,
        -"/verbatim".length,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await options.onVerbatim?.(decodeURIComponent(encodedConversationId), body);
      return Response.json({ recorded: true }, { status: 200 });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/ask")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        options.onAskSubmit?.(body);
        return Response.json({ accepted: true, snapshot: { ...options.pendingAsk, status: "answered" } });
      }
      return Response.json({ ask: options.pendingAsk ?? null });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

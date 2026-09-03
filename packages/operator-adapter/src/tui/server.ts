import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  MCP_APP_RESOURCE_MIME_TYPE,
  MCP_APP_SUPPORTED_VERSIONS,
  MAX_AGENT_REPLY_PARTS,
  BoundedHttpResponseWriter,
  agentAttachmentKindFromMimeType,
  closeServerBounded,
  createChannelUserCancelReason,
  decodeAgentAttachmentText,
  isAgentResponseCancelledError,
  parseProcessJobProjection,
  parseProcessJobProjections,
  serializeAgentStreamFrame,
  type AgentAttachment,
  type AgentMessageStream,
  type AgentReplyAttachmentPart,
  type AgentReplyPart,
  type AgentLiveInputOffer,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
  type AgentToolEnvironment,
  type ChannelAskAnswer,
  type ChannelInteractionHub,
  type ProcessJobOperator,
  type ProcessJobProjection,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  hostForUrl,
  isLoopbackHost,
  listen,
  MAX_INFO_BODY_BYTES,
  normalizeOptionalString,
  parseCronOperatorOverview,
  parseCronOperatorRunDetail,
  parseCronOperatorRunPage,
  readAuthorizationBearer,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import { DEFAULT_BASE_PATH, DEFAULT_HOST, DEFAULT_PORT, MAX_FRAME_BYTES, TUI_WIRE_SCHEMA } from "./constants.js";
import {
  CronOperatorError,
  MAX_CRON_OPERATOR_RESPONSE_BYTES,
  MAX_CRON_OPERATOR_RUN_PAGE,
  type CronOperatorActionInput,
  type CronOperatorService,
} from "./cron.js";
import { TuiAdapterError } from "./errors.js";
import type { RequestToolEnvironmentConfig } from "./config.js";

export interface TuiAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export type TuiSkillAvailability = "inlined" | "on-demand" | "unavailable";
export type TuiSkillUnavailableReason = "not-selected" | "read-skill-disabled" | "unsupported-name";

export interface TuiSkillInfo {
  readonly name: string;
  readonly description: string;
  readonly availability: TuiSkillAvailability;
  /** Canonical composer reference. Present only when this skill can be inserted. */
  readonly reference?: string;
  readonly unavailableReason?: TuiSkillUnavailableReason;
}

export type TuiSkillRegistry =
  | {
      readonly status: "ready";
      readonly items: readonly TuiSkillInfo[];
      readonly total: number;
      readonly truncated?: true;
    }
  | {
      readonly status: "error";
      readonly items: readonly [];
    };

/** Static facts surfaced by GET /v1/info so the TUI can label the session. */
export interface TuiModelOption {
  readonly effortLevels?: readonly string[];
  readonly reasoning?: boolean;
  readonly reasoningMode?: string;
  readonly label?: string;
  /** Known model context capacity, in tokens. Omitted when unknown. */
  readonly contextWindow?: number;
  /** Canonical provider id the model belongs to. */
  readonly provider?: string;
  /** Provider display label. */
  readonly providerLabel?: string;
}

/** One provider advertised in the bounded `/v1/info` provider catalog. */
export interface TuiProviderInfo {
  /** Canonical provider id, e.g. "anthropic". */
  readonly id: string;
  /** Human display label, e.g. "Anthropic". */
  readonly label: string;
  /** Number of models this provider advertises (post-narrowing, post-cap). */
  readonly modelCount: number;
  /** Present only when the advertised list was capped, so a UI can say "100 of 351". */
  readonly totalModelCount?: number;
  readonly source: "builtin" | "custom" | "discovered";
  /** The agent explicitly supports this provider: it is listed in `providers`,
   *  or a configured runtime route uses it. */
  readonly configured?: true;
}

/** One model served by the lazy `/v1/models` catalog endpoint. */
export interface TuiCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  readonly effortLevels?: readonly string[];
  readonly reasoningMode?: string;
}

/** A bounded, serializable model-catalog page produced by the injected provider. */
export interface TuiModelCatalogRequest {
  /** Provider-scoped listing. Mutually exclusive with `query`. */
  readonly provider?: string;
  /** Cross-provider text search. Mutually exclusive with `provider`. */
  readonly query?: string;
  /** Opaque pagination cursor returned by a previous page. */
  readonly cursor?: string;
  /** Page size, already bounded by the adapter to 1..maxPageSize. */
  readonly limit: number;
}

export interface TuiModelCatalogPage {
  readonly models: readonly TuiCatalogModel[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

/**
 * Injected model-catalog data source for GET /v1/models. The adapter validates,
 * bounds, and serializes; the channel composition layer supplies the data
 * (mirroring the `info` seam). Absent when the host does not serve a catalog,
 * in which case `/v1/models` 404s and `/v1/info` omits the `modelCatalog`
 * capability.
 */
export type TuiModelCatalogProvider = (request: TuiModelCatalogRequest) => TuiModelCatalogPage;

/** Static facts surfaced by GET /v1/info so the TUI can label the session. */
export interface TuiAdapterInfo {
  readonly label?: string;
  readonly model?: string;
  /**
   * The statically configured reasoning-effort level. Per-run overrides
   * (e.g. a per-trigger effort override on a given turn) do NOT flow through
   * here — those arrive via the `run_config` runtime_telemetry event instead.
   */
  readonly effort?: string;
  /**
   * The candidate models a TUI session may switch to — the host's primary model
   * first, then each configured fallback, as canonical reference strings. Absent
   * on older agents; the TUI tolerates that and offers no model picker.
   */
  readonly models?: readonly string[];
  /**
   * Per-model reasoning/effort metadata, keyed by the same canonical ref
   * strings that appear in `models`. Local-provider models resolve a precise
   * `reasoningMode` (`"effort"` with graded `effortLevels`, `"toggle"` for
   * binary thinking, or `"none"`); cloud models degrade to `{ reasoning: true }`
   * with no mode/levels so the TUI falls back to the global effort enum. Absent
   * on older agents; the TUI tolerates that and offers no model-aware picker.
   */
  readonly modelOptions?: Record<string, TuiModelOption>;
  /** Bounded provider catalog so the TUI can browse beyond the configured shortlist. */
  readonly providers?: readonly TuiProviderInfo[];
  /** Bounded active-agent skill registry. Absent only on older producers. */
  readonly skills?: TuiSkillRegistry;
}

export interface TuiAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  readonly apiKey?: string;
  /** Optional loopback-only boundary for ACP request-scoped process-tool env. */
  readonly requestToolEnvironment?: RequestToolEnvironmentConfig;
  readonly responder: AgentResponder;
  readonly logger?: TuiAdapterLogger;
  /**
   * Static info, OR a provider invoked fresh on every GET /v1/info. Discovery
   * of local-provider models can change after the adapter starts (an endpoint
   * started later, or restarted); a provider lets `/v1/info` reflect that
   * without a restart. The channel composition layer is responsible for
   * caching/rate-limiting any expensive work the provider does — this adapter
   * just calls it (and awaits it) on every request.
   */
  readonly info?: TuiAdapterInfo | (() => TuiAdapterInfo | Promise<TuiAdapterInfo>);
  /**
   * Optional lazy model-catalog data source served through GET /v1/models.
   * Absent when the host does not expose a browsable catalog. The adapter
   * validates/bounds/serializes every request and response; the supplier
   * returns already-bounded, deterministic pages.
   */
  readonly modelCatalog?: TuiModelCatalogProvider;
  /**
   * Invoked when the already-listening HTTP server dies (e.g. EADDRINUSE
   * appearing later, socket-level failure). The hosting channel driver maps
   * this to its onFailure hook so the channel flips to "failed" instead of
   * silently serving nothing.
   */
  readonly onServerError?: (reason: string) => void;
  /** In-process bridge state used by the web console's structured AskUser form. */
  readonly interaction?: ChannelInteractionHub;
  /** Agent-owned cron truth and controls. Absent on older/non-cron hosts. */
  readonly cron?: CronOperatorService;
  /** Owner-authorized process-job control plane; omitted when unavailable. */
  readonly processJobs?: ProcessJobOperator;
  /** Independent owner bearer for process-job routes. Required with processJobs. */
  readonly processJobsBearer?: string;
}

export interface TuiAdapterStartResult {
  readonly url: string;
  readonly baseUrl: string;
  readonly infoUrl: string;
  readonly turnsUrl: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

const MAX_TURN_BODY_BYTES = 96 * 1024 * 1024;
const MAX_MODEL_CATALOG_PAGE_SIZE = 200;
const DEFAULT_MODEL_CATALOG_PAGE_SIZE = 100;
const MAX_MODEL_CATALOG_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_CATALOG_PROVIDER_BYTES = 256;
const MAX_MODEL_CATALOG_QUERY_BYTES = 512;
const MAX_MODEL_CATALOG_CURSOR_BYTES = 4 * 1024;
const MAX_VERBATIM_BODY_BYTES = 2 * 1024 * 1024;
const MAX_VERBATIM_TEXT_CHARACTERS = 200_000;
const MAX_VERBATIM_TEXT_BYTES = 1024 * 1024;
const MAX_LIVE_INPUT_BODY_BYTES = 32 * 1024;
const MAX_PROCESS_JOBS_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_WEB_ATTACHMENTS = 10;
const MAX_WEB_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_TOOL_ENVIRONMENT_KEYS = 32;
const MAX_REQUEST_TOOL_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const MAX_REQUEST_TOOL_ENVIRONMENT_TOTAL_BYTES = 64 * 1024;
const MAX_REQUEST_TOOL_ENVIRONMENT_PATHS = 4;
const MAX_CRON_ACTION_BODY_BYTES = 32 * 1024;
const MAX_REPLY_ARTIFACT_ID_BYTES = 128;
const MAX_REPLY_ARTIFACT_CONVERSATION_BYTES = 4 * 1024;
const MAX_MCP_APP_IDENTITY_BYTES = 4 * 1024;
const MAX_MCP_APP_REQUEST_BYTES = 64 * 1024;
const REPLY_ARTIFACT_DRAIN_TIMEOUT_MS = 30_000;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set(
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST.map((mimeType) => mimeType.toLowerCase()),
);

export async function startTuiAdapter(options: TuiAdapterOptions): Promise<TuiAdapterStartResult> {
  if (typeof options.responder?.respond !== "function") {
    throw new TuiAdapterError("invalid_config", "startTuiAdapter requires a responder with respond().");
  }
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const apiKey = normalizeOptionalString(options.apiKey);
  const processJobsBearer = normalizeOptionalString(options.processJobsBearer);
  if ((options.processJobs === undefined) !== (processJobsBearer === undefined)) {
    throw new TuiAdapterError(
      "invalid_config",
      "processJobs and processJobsBearer must be configured together.",
    );
  }
  if (options.requestToolEnvironment !== undefined && !isLoopbackHost(host)) {
    throw new TuiAdapterError(
      "unsafe_host",
      "Request tool environment requires a loopback-only TUI adapter bind.",
      { host },
    );
  }
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new TuiAdapterError(
      "unsafe_host",
      "TUI adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));

  const app = express();
  const server = createServer(app);
  const activeTurns = new Set<AbortController>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const infoPath = `${basePath}/v1/info`;
  const modelsPath = `${basePath}/v1/models`;
  const turnsPath = `${basePath}/v1/turns`;
  const cancelPath = `${basePath}/v1/conversations/:conversationId/cancel`;
  const verbatimPath = `${basePath}/v1/conversations/:conversationId/verbatim`;
  const liveInputPath = `${basePath}/v1/conversations/:conversationId/live-input`;
  const replyArtifactPath = `${basePath}/v1/conversations/:conversationId/reply-artifacts/:artifactId`;
  const mcpAppPath = `${basePath}/v1/conversations/:conversationId/mcp-apps/:invocationId`;
  const mcpAppRequestPath = `${mcpAppPath}/requests`;
  const askPath = `${basePath}/v1/conversations/:conversationId/ask`;
  const interactionPath = `${basePath}/v1/interactions/:interactionId`;
  const cronOverviewPath = `${basePath}/v1/cron`;
  const cronRunsPath = `${basePath}/v1/cron/jobs/:jobId/runs`;
  const cronRunDetailPath = `${basePath}/v1/cron/jobs/:jobId/runs/:runId`;
  const cronConfigViewPath = `${basePath}/v1/cron/config-view`;
  const cronRunNowPath = `${basePath}/v1/cron/jobs/:jobId/run`;
  const cronEnabledPath = `${basePath}/v1/cron/jobs/:jobId/effective-enabled`;
  const jobsPath = `${basePath}/v1/jobs`;
  const jobPath = `${basePath}/v1/jobs/:jobId`;
  const jobCancelPath = `${basePath}/v1/jobs/:jobId/cancel`;

  app.get(infoPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    const cronInfo = options.cron === undefined
      ? Promise.resolve({ kind: "absent" } as const)
      : Promise.resolve()
        .then(async () => await options.cron!.overview())
        .then((overview) => ({ kind: "available", overview } as const))
        .catch((error: unknown) => {
          // Cron is an additive capability, never the agent-liveness probe. A
          // stopped registry or failed control store must not turn /v1/info into
          // a 500 that makes the whole agent appear unreachable.
          options.logger?.error?.("Cron operator overview failed during TUI info.", {
            error: errorToMessage(error),
          });
          return { kind: "degraded" } as const;
        });
    void Promise.all([resolveInfo(options.info), cronInfo])
      .then(([info, cronState]) => {
        sendBoundedInfo(res, {
          schema: TUI_WIRE_SCHEMA,
          pid: process.pid,
          capabilities: {
            attachments: true,
            ...(typeof options.responder.openReplyArtifact === "function"
              ? { replyAttachments: { version: 1, maxBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES } }
              : {}),
            ...(typeof options.responder.loadMcpApp === "function"
              && typeof options.responder.requestMcpApp === "function"
              ? {
                  mcpApps: {
                    bridgeVersion: 1,
                    versions: MCP_APP_SUPPORTED_VERSIONS,
                    mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
                  },
                }
              : {}),
            ...(typeof options.responder.offerLiveInput === "function" ? { liveInput: true } : {}),
            ...(typeof options.responder.deliverVerbatim === "function" ? { historyAppend: true } : {}),
            ...(options.interaction === undefined ? {} : { askUser: true }),
            ...(typeof options.interaction?.getAsk === "function" ? { askById: true } : {}),
            ...(cronState.kind === "absent"
              ? {}
              : cronState.kind === "degraded"
                ? { cron: { status: "degraded", read: false, actions: false } }
                : {
                    cron: {
                      status: cronState.overview.degradedReason === undefined ? "ready" : "degraded",
                      read: true,
                      actions: cronState.overview.degradedReason === undefined
                        && apiKey !== undefined
                        && cronState.overview.actionsEnabled === true,
                    },
                  }),
            ...(options.processJobs === undefined || processJobsBearer === undefined ? {} : { jobs: true }),
            ...(options.requestToolEnvironment === undefined ? {} : { toolEnvironment: true }),
            ...(options.modelCatalog === undefined
              ? {}
              : { modelCatalog: { version: 1, maxPageSize: MAX_MODEL_CATALOG_PAGE_SIZE } }),
          },
          ...(info?.label === undefined ? {} : { label: info.label }),
          ...(info?.model === undefined ? {} : { model: info.model }),
          ...(info?.effort === undefined ? {} : { effort: info.effort }),
          ...(info?.models === undefined || info.models.length === 0 ? {} : { models: info.models }),
          ...(info?.modelOptions === undefined || Object.keys(info.modelOptions).length === 0
            ? {}
            : { modelOptions: info.modelOptions }),
          ...(info?.skills === undefined ? {} : { skills: info.skills }),
          ...(info?.providers === undefined || info.providers.length === 0 ? {} : { providers: info.providers }),
        }, options.logger);
      })
      .catch((error: unknown) => {
        options.logger?.error?.("TUI info provider failed.", { error: errorToMessage(error) });
        sendJsonError(res, 500, error);
      });
  });

  app.get(modelsPath, (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    if (options.modelCatalog === undefined) {
      sendJsonError(res, 404, new TuiAdapterError("invalid_request", "The model catalog is unavailable."));
      return;
    }
    let request: TuiModelCatalogRequest;
    try {
      request = normalizeModelCatalogRequest(req);
    } catch (error) {
      next(error);
      return;
    }
    let page: TuiModelCatalogPage;
    try {
      // The catalog is a trust boundary only in the sense that the provider is
      // host-owned; a throwing supplier must still fail as a server error
      // rather than silently serving an empty catalog (see the "totality"
      // contract in the composition layer — that layer never throws).
      page = options.modelCatalog(request);
    } catch (error) {
      next(error);
      return;
    }
    try {
      sendBoundedModelCatalog(res, page);
    } catch (error) {
      next(error);
    }
  });

  app.get(jobsPath, (req, res, next) => {
    if (!authorize(req, res, processJobsBearer)) return;
    if (options.processJobs === undefined || processJobsBearer === undefined) {
      sendJsonError(res, 404, new TuiAdapterError("invalid_request", "Process jobs are unavailable."));
      return;
    }
    void options.processJobs.list()
      .then((jobs) => sendBoundedJobs(res, jobs))
      .catch(next);
  });

  app.get(jobPath, (req, res, next) => {
    if (!authorize(req, res, processJobsBearer)) return;
    if (options.processJobs === undefined || processJobsBearer === undefined) {
      sendJsonError(res, 404, new TuiAdapterError("invalid_request", "Process jobs are unavailable."));
      return;
    }
    const jobId = normalizeOptionalString(typeof req.params.jobId === "string" ? req.params.jobId : undefined);
    if (jobId === undefined || jobId.length > 256) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "A bounded jobId is required."));
      return;
    }
    void options.processJobs.get(jobId)
      .then((job) => {
        if (job === undefined) {
          res.status(404).json({ error: { code: "process_job_not_found", message: "Process job was not found." } });
        } else {
          sendBoundedJob(res, job);
        }
      })
      .catch(next);
  });

  app.post(jobCancelPath, (req, res, next) => {
    if (!authorize(req, res, processJobsBearer)) return;
    if (options.processJobs === undefined || processJobsBearer === undefined) {
      sendJsonError(res, 404, new TuiAdapterError("invalid_request", "Process jobs are unavailable."));
      return;
    }
    const jobId = normalizeOptionalString(typeof req.params.jobId === "string" ? req.params.jobId : undefined);
    if (jobId === undefined || jobId.length > 256) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "A bounded jobId is required."));
      return;
    }
    void options.processJobs.cancel(jobId)
      .then((job) => sendBoundedJob(res, job))
      .catch((error: unknown) => {
        const code = typeof error === "object" && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "process_job_not_found") {
          res.status(404).json({ error: { code, message: errorToMessage(error) } });
        } else if (code === "process_job_conflict") {
          res.status(409).json({ error: { code, message: errorToMessage(error) } });
        } else {
          next(error);
        }
      });
  });

  // Keep the enlarged parser scoped to turn submission. 64 MiB of decoded
  // files expands to about 85.4 MiB in base64, while info/cancel stay bodyless.
  app.post(turnsPath, express.json({ limit: MAX_TURN_BODY_BYTES }), (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    void handleTurn(req, res).catch((error: unknown) => {
      options.logger?.error?.("TUI turn failed before response.", { error: errorToMessage(error) });
      if (!res.headersSent) {
        sendJsonError(res, error instanceof TuiAdapterError && error.code === "invalid_request" ? 400 : 500, error);
      }
    });
  });

  app.post(cancelPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    const rawConversationId = req.params.conversationId;
    const conversationId = normalizeOptionalString(
      typeof rawConversationId === "string" ? rawConversationId : undefined,
    );
    if (conversationId === undefined) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "conversationId is required."));
      return;
    }
    if (typeof options.responder.cancel !== "function") {
      sendJsonError(res, 501, new TuiAdapterError("invalid_request", "This responder does not support cancel."));
      return;
    }
    options.responder.cancel(conversationId, createChannelUserCancelReason("TUI"));
    options.interaction?.cancelAsks(conversationId);
    res.status(202).json({ cancelled: conversationId });
  });

  app.get(replyArtifactPath, (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    if (typeof options.responder.openReplyArtifact !== "function") {
      sendJsonError(res, 404, new TuiAdapterError("invalid_request", "Reply artifacts are unavailable."));
      return;
    }
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    const artifactId = normalizeOptionalString(
      typeof req.params.artifactId === "string" ? req.params.artifactId : undefined,
    );
    const expectedIntegrityId = normalizeOptionalString(req.header("x-mono-agent-integrity-id"));
    if (
      conversationId === undefined
      || artifactId === undefined
      || Buffer.byteLength(conversationId, "utf8") > MAX_REPLY_ARTIFACT_CONVERSATION_BYTES
      || Buffer.byteLength(artifactId, "utf8") > MAX_REPLY_ARTIFACT_ID_BYTES
    ) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "A valid conversation and artifact id are required."));
      return;
    }
    void options.responder.openReplyArtifact({
      conversationId,
      reference: { scheme: "mono-agent-artifact", id: artifactId },
      ...(expectedIntegrityId === undefined ? {} : { expectedIntegrityId }),
    }).then(async (opened) => {
      setReplyArtifactHeaders(res, opened.attachment);
      let streamed = 0;
      for await (const chunk of opened.body) {
        streamed += chunk.byteLength;
        if (streamed > opened.attachment.sizeBytes) {
          throw new TuiAdapterError("invalid_request", "Reply artifact exceeded its declared size.");
        }
        await writeBinaryChunk(res, chunk);
      }
      if (streamed !== opened.attachment.sizeBytes) {
        throw new TuiAdapterError("invalid_request", "Reply artifact stream ended before its declared size.");
      }
      res.end();
    }).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const code = codeOf(error);
      const status = code === "artifact_forbidden" || code === "artifact_missing" || code === "artifact_expired"
        ? 404
        : code === "artifact_integrity_failed" ? 409 : 500;
      sendJsonError(res, status, error);
    }).catch(next);
  });

  app.get(mcpAppPath, (req, res) => {
    if (!authorize(req, res, apiKey)) return;
    if (typeof options.responder.loadMcpApp !== "function") {
      sendJsonError(res, 404, new TuiAdapterError("invalid_request", "MCP Apps are unavailable."));
      return;
    }
    const identity = normalizeMcpAppIdentity(req);
    if (identity === undefined) {
      sendJsonError(res, 400, new TuiAdapterError(
        "invalid_request",
        "A valid conversation, invocation, and connection id are required.",
      ));
      return;
    }
    void options.responder.loadMcpApp(identity).then((resource) => {
      setPrivateMcpAppHeaders(res);
      res.status(200).json(resource);
    }).catch((error: unknown) => sendMcpAppError(res, error));
  });

  app.post(
    mcpAppRequestPath,
    express.json({ limit: MAX_MCP_APP_REQUEST_BYTES, strict: true }),
    (req, res) => {
      if (!authorize(req, res, apiKey)) return;
      if (typeof options.responder.requestMcpApp !== "function") {
        sendJsonError(res, 404, new TuiAdapterError("invalid_request", "MCP Apps are unavailable."));
        return;
      }
      const identity = normalizeMcpAppIdentity(req);
      const body = isRecord(req.body) ? req.body : undefined;
      const method = body?.method;
      const params = body?.params;
      const confirmed = body?.confirmed;
      if (
        identity === undefined
        || (method !== "resources/read"
          && method !== "tools/call"
          && method !== "ui/open-link"
          && method !== "ui/update-model-context")
        || (confirmed !== undefined && typeof confirmed !== "boolean")
      ) {
        sendJsonError(res, 400, new TuiAdapterError("invalid_request", "The MCP App bridge request is invalid."));
        return;
      }
      void options.responder.requestMcpApp({
        ...identity,
        method,
        ...(params === undefined ? {} : { params }),
        ...(confirmed === undefined ? {} : { confirmed }),
      }).then((result) => {
        setPrivateMcpAppHeaders(res);
        res.status(200).json({ result });
      }).catch((error: unknown) => sendMcpAppError(res, error));
    },
  );

  app.post(verbatimPath, express.json({ limit: MAX_VERBATIM_BODY_BYTES, strict: true }), (req, res, next) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    let body: NormalizedVerbatimBody;
    try {
      body = normalizeVerbatimBody(req.params.conversationId, req.body);
    } catch (error) {
      next(error);
      return;
    }
    if (typeof options.responder.deliverVerbatim !== "function") {
      sendJsonError(
        res,
        501,
        new TuiAdapterError("invalid_request", "This responder does not support history append."),
      );
      return;
    }
    void options.responder.deliverVerbatim(body.conversationId, body.text, {
      idempotencyKey: body.idempotencyKey,
    }).then(() => {
      res.status(200).json({ recorded: true, conversationId: body.conversationId });
    }).catch(next);
  });

  app.post(liveInputPath, express.json({ limit: MAX_LIVE_INPUT_BODY_BYTES, strict: true }), (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    const body = typeof req.body === "object" && req.body !== null
      ? req.body as Record<string, unknown>
      : {};
    if (
      conversationId === undefined
      || typeof body.id !== "string"
      || body.id.trim().length === 0
      || typeof body.text !== "string"
      || body.text.trim().length === 0
      || body.text.length > AGENT_LIVE_INPUT_MAX_CHARACTERS
      || typeof body.receivedAt !== "string"
      || Number.isNaN(Date.parse(body.receivedAt))
      || (body.deliveryKey !== undefined
        && (typeof body.deliveryKey !== "string"
          || body.deliveryKey.trim().length === 0
          || body.deliveryKey.length > 1_024))
    ) {
      next(new TuiAdapterError(
        "invalid_request",
        `Live input requires id, receivedAt, and 1-${String(AGENT_LIVE_INPUT_MAX_CHARACTERS)} text characters.`,
      ));
      return;
    }
    if (typeof options.responder.offerLiveInput !== "function") {
      res.status(200).json({ status: "unavailable", reason: "unsupported" });
      return;
    }
    let offer: AgentLiveInputOffer;
    try {
      offer = options.responder.offerLiveInput({
        conversationId,
        id: body.id,
        text: body.text,
        receivedAt: body.receivedAt,
        ...(typeof body.deliveryKey === "string" ? { deliveryKey: body.deliveryKey } : {}),
      });
    } catch (error) {
      next(error);
      return;
    }
    if (offer.status === "unavailable") {
      res.status(200).json(offer);
      return;
    }
    void offer.settled.then((settlement) => {
      res.status(200).json(settlement);
    }).catch(next);
  });

  app.get(askPath, (req, res) => {
    if (!authorize(req, res, apiKey)) return;
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    if (conversationId === undefined) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "conversationId is required."));
      return;
    }
    void Promise.resolve(options.interaction?.getPendingAsk(conversationId))
      .then((ask) => res.status(200).json({ ask: ask ?? null }))
      .catch((error: unknown) => sendJsonError(res, 500, error));
  });

  app.post(askPath, express.json({ limit: "64kb" }), (req, res) => {
    if (!authorize(req, res, apiKey)) return;
    const conversationId = normalizeOptionalString(
      typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
    );
    const body = typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : {};
    if (
      conversationId === undefined
      || typeof body.interactionId !== "string"
      || !Array.isArray(body.answers)
      || options.interaction === undefined
    ) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "A supported interactionId and answers are required."));
      return;
    }
    void Promise.resolve(options.interaction.submitAskAnswers({
      conversationId,
      interactionId: body.interactionId,
      answers: body.answers as readonly ChannelAskAnswer[],
    })).then((result) => {
      res.status(200).json(result);
    }).catch((error: unknown) => sendJsonError(res, 500, error));
  });

  app.get(interactionPath, (req, res) => {
    if (!authorize(req, res, apiKey)) return;
    const interactionId = normalizeOptionalString(
      typeof req.params.interactionId === "string" ? req.params.interactionId : undefined,
    );
    if (interactionId === undefined) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "interactionId is required."));
      return;
    }
    if (typeof options.interaction?.getAsk !== "function") {
      sendJsonError(res, 501, new TuiAdapterError("invalid_request", "Exact interaction lookup is unsupported."));
      return;
    }
    void Promise.resolve(options.interaction.getAsk(interactionId))
      .then((ask) => res.status(200).json({ ask: ask ?? null }))
      .catch((error: unknown) => sendJsonError(res, 500, error));
  });

  app.get(cronOverviewPath, (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    if (options.cron === undefined) {
      sendJsonError(res, 404, new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404));
      return;
    }
    void Promise.resolve(options.cron.overview())
      .then((overview) => sendBoundedCronJson(res, 200, parseCronOperatorOverview(overview)))
      .catch(next);
  });

  app.get(cronRunsPath, (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    if (options.cron === undefined) {
      sendJsonError(res, 404, new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404));
      return;
    }
    try {
      const jobId = cronJobId(req.params.jobId);
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_CRON_OPERATOR_RUN_PAGE) {
        throw new CronOperatorError(
          "invalid_request",
          `limit must be 1-${String(MAX_CRON_OPERATOR_RUN_PAGE)}.`,
          400,
        );
      }
      const before = typeof req.query.before === "string" && req.query.before.length > 0
        ? req.query.before
        : undefined;
      if (before !== undefined && Buffer.byteLength(before, "utf8") > 4_096) {
        throw new CronOperatorError("invalid_request", "before cursor is too large.", 400);
      }
      void Promise.resolve(options.cron.runs({ jobId, limit: rawLimit, ...(before === undefined ? {} : { before }) }))
        .then((page) => sendBoundedCronJson(res, 200, parseCronOperatorRunPage(page)))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get(cronRunDetailPath, (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    if (options.cron === undefined) {
      sendJsonError(res, 404, new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404));
      return;
    }
    try {
      const jobId = cronJobId(req.params.jobId);
      const runId = cronRunId(req.params.runId);
      void Promise.resolve(options.cron.run({ jobId, runId }))
        .then((run) => sendBoundedCronJson(res, 200, { run: parseCronOperatorRunDetail(run) }))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get(cronConfigViewPath, (req, res, next) => {
    if (!authorize(req, res, apiKey)) return;
    if (options.cron === undefined) {
      sendJsonError(res, 404, new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404));
      return;
    }
    void Promise.resolve(options.cron.configView())
      .then((configView) => res.status(200).json({ configView }))
      .catch(next);
  });

  app.post(cronRunNowPath, express.json({ limit: MAX_CRON_ACTION_BODY_BYTES, strict: true }), (req, res, next) => {
    if (!authorize(req, res, apiKey) || !requireCronActionKey(res, apiKey)) return;
    if (options.cron === undefined) {
      sendJsonError(res, 404, new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404));
      return;
    }
    try {
      const jobId = cronJobId(req.params.jobId);
      const action = cronActionInput(req.body);
      void Promise.resolve(options.cron.runNow(jobId, action))
        .then((result) => sendCronMutation(res, result))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post(cronEnabledPath, express.json({ limit: MAX_CRON_ACTION_BODY_BYTES, strict: true }), (req, res, next) => {
    if (!authorize(req, res, apiKey) || !requireCronActionKey(res, apiKey)) return;
    if (options.cron === undefined) {
      sendJsonError(res, 404, new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404));
      return;
    }
    try {
      const jobId = cronJobId(req.params.jobId);
      if (!isRecord(req.body) || typeof req.body.enabled !== "boolean") {
        throw new CronOperatorError("invalid_request", "enabled must be a boolean.", 400);
      }
      const action = cronActionInput(req.body);
      void Promise.resolve(options.cron.setEffectiveEnabled(jobId, req.body.enabled, action))
        .then((result) => sendCronMutation(res, result))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const parserStatus = (error as { status?: unknown } | null)?.status;
    const parserType = (error as { type?: unknown } | null)?.type;
    if (parserStatus === 413 || parserType === "entity.too.large") {
      sendJsonError(res, 413, error);
      return;
    }
    // 400 only for client mistakes (invalid_request, body-parse SyntaxError);
    // anything else is a server-side failure and must read as one.
    if (error instanceof CronOperatorError) {
      sendJsonError(res, error.status, error);
      return;
    }
    const isClientError =
      codeOf(error) === "invalid_request" ||
      (error instanceof SyntaxError && (error as { status?: unknown }).status === 400);
    sendJsonError(res, isClientError ? 400 : 500, error);
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new TuiAdapterError("start_failed", "TUI adapter failed to listen.", { reason }),
    noAddress: () => new TuiAdapterError("start_failed", "TUI adapter did not receive a TCP address."),
  });

  async function closeRejectedServer(): Promise<void> {
    stopping = true;
    for (const controller of activeTurns) controller.abort(new Error("TUI adapter rejected its actual bound address."));
    await closeServerBounded(server);
    activeTurns.clear();
  }

  const boundNonLoopback = !isLoopbackHost(address.address);
  if (boundNonLoopback && options.allowNonLoopback !== true) {
    await closeRejectedServer();
    throw new TuiAdapterError(
      "unsafe_host",
      "TUI adapter resolved a loopback host to a non-loopback bind address.",
      { host, boundAddress: address.address, boundPort: address.port },
    );
  }
  if (boundNonLoopback && options.requestToolEnvironment !== undefined) {
    await closeRejectedServer();
    throw new TuiAdapterError(
      "unsafe_host",
      "Request tool environment requires the resolved TUI adapter bind to remain loopback-only.",
      { host, boundAddress: address.address, boundPort: address.port },
    );
  }

  server.on("error", (error) => {
    options.onServerError?.(errorToMessage(error));
  });
  const boundPort = address.port;
  const url = `http://${hostForUrl(host)}:${boundPort}`;

  async function handleTurn(req: Request, res: Response): Promise<void> {
    const body = normalizeTurnBody(req.body, options.requestToolEnvironment);
    const controller = new AbortController();
    activeTurns.add(controller);
    if (stopping) controller.abort(new Error("TUI adapter is stopping."));
    const requestId = randomUUID();
    const request: AgentRequestBase = {
      conversationId: body.conversationId,
      text: body.text,
      abortSignal: controller.signal,
      metadata: requestMetadata(body, requestId),
      ...(body.attachments === undefined || body.attachments.length === 0
        ? {}
        : { attachments: body.attachments }),
      ...(body.toolEnvironment === undefined ? {} : { toolEnvironment: body.toolEnvironment }),
    };

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("TUI client disconnected."));
      }
    });

    const stream = new NdjsonMessageStream(res, (error) => controller.abort(error));
    try {
      const response: AgentResponse = await options.responder.respond(request, stream);
      await stream.writeFrame({
        kind: "finish",
        ...(response.text === undefined ? {} : { finalText: response.text }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
        ...(response.parts === undefined || response.parts.length === 0 ? {} : { parts: response.parts }),
      });
    } catch (error) {
      const cancelled = isAgentResponseCancelledError(error) || controller.signal.aborted;
      const code = codeOf(error);
      await stream.writeFrame({
        kind: "error",
        message: errorToMessage(error),
        ...(code === undefined ? {} : { code }),
        cancelled,
      }).catch(() => undefined);
    } finally {
      activeTurns.delete(controller);
      res.end();
    }
  }

  return {
    url,
    baseUrl: `${url}${basePath}`,
    infoUrl: `${url}${infoPath}`,
    turnsUrl: `${url}${turnsPath}`,
    host,
    port: boundPort,
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        for (const controller of activeTurns) controller.abort(new Error("TUI adapter stopped."));
        await closeServerBounded(server);
        activeTurns.clear();
      })();
      return stopPromise;
    },
  };
}

/**
 * Serializes each AgentMessageStream callback as one NDJSON frame. Writes honor
 * the response's backpressure signal and carry a bounded pending-byte budget,
 * so a slow client cannot grow the process heap without limit. Oversized event
 * frames are reduced or replaced with a marker to meet the exported UTF-8 byte
 * cap. Append text is split losslessly; other text fields are deterministically
 * truncated, and terminal rich parts that cannot fit are replaced by an
 * explicit failure marker.
 */
class NdjsonMessageStream implements AgentMessageStream {
  private readonly writer: BoundedHttpResponseWriter;

  constructor(private readonly res: Response, onWriteFailure: (error: Error) => void) {
    this.writer = new BoundedHttpResponseWriter(res, { onFailure: onWriteFailure });
  }

  async writeFrame(frame: AgentStreamWireFrame): Promise<void> {
    if (this.res.writableEnded) {
      return;
    }
    const boundedFrame = frame.kind === "finish" ? capFinishReplyParts(frame) : frame;
    const line = serializeAgentStreamFrame(boundedFrame);
    if (Buffer.byteLength(line, "utf8") <= MAX_FRAME_BYTES) {
      await this.writer.write(line);
      return;
    }
    if (boundedFrame.kind === "append") {
      for (const chunk of splitTextForWireFrame("append", boundedFrame.delta)) {
        await this.writer.write(serializeAgentStreamFrame({ kind: "append", delta: chunk }));
      }
      return;
    }
    const capped = boundedFrame.kind === "event"
      ? serializeCappedEventFrame(boundedFrame.event, line)
      : boundedFrame.kind === "finish"
        ? serializeCappedFinishFrame(line)
        : boundedFrame.kind === "status" || boundedFrame.kind === "replace" || boundedFrame.kind === "error"
          ? serializeCappedTextFrame(boundedFrame)
          : serializeAgentStreamFrame({
              kind: "error",
              code: "frame_too_large",
              message: "A transport frame exceeded the maximum size.",
            });
    await this.writer.write(capped);
  }

  async status(text: string): Promise<void> {
    await this.writeFrame({ kind: "status", text });
  }

  async append(delta: string): Promise<void> {
    await this.writeFrame({ kind: "append", delta });
  }

  async replace(text: string): Promise<void> {
    await this.writeFrame({ kind: "replace", text });
  }

  async event(event: AgentStreamEvent): Promise<void> {
    await this.writeFrame({ kind: "event", event });
  }

  async finish(): Promise<void> {
    // The terminal "finish" frame is written by handleTurn from the responder's
    // AgentResponse (which carries metadata); mid-stream finish() is a no-op.
  }
}

function capFinishReplyParts(
  frame: Extract<AgentStreamWireFrame, { kind: "finish" }>,
): Extract<AgentStreamWireFrame, { kind: "finish" }> {
  const parts = frame.parts;
  if (parts === undefined || parts.length <= MAX_AGENT_REPLY_PARTS) return frame;
  const omitted = parts.length - (MAX_AGENT_REPLY_PARTS - 1);
  return {
    ...frame,
    parts: [
      ...parts.slice(0, MAX_AGENT_REPLY_PARTS - 1),
      {
        type: "failure",
        id: "wire-rich-parts-over-limit",
        code: "reply_part_too_large",
        message: `${omitted} rich reply part${omitted === 1 ? " was" : "s were"} omitted because the reply exceeded the 20-part transport limit.`,
      },
    ],
  };
}

/**
 * Prepare a stable reducer for the payload-bearing event variants whose shape
 * the operator adapter preserves under truncation. The input is the parsed
 * snapshot of the already serialized frame, so getters/toJSON hooks from the
 * provider event cannot run again on every size probe. Other event variants
 * use the bounded oversized-event marker directly.
 */
function prepareEventReducer(
  event: AgentStreamEvent,
): ((maxPayloadChars: number) => AgentStreamEvent) | undefined {
  if (!isPayloadReducibleEventType(event.type)) {
    return undefined;
  }
  const metadata = { ...event.metadata, truncated: true };
  if (event.type === "tool_call_progress") {
    const partialResult = serializeUnknown(event.partialResult);
    return (maxPayloadChars) => ({
      ...event,
      partialResult: truncatePreparedText(partialResult, maxPayloadChars),
      metadata,
    });
  }
  if (event.type === "tool_call_completed") {
    const content = serializeUnknown(event.content);
    const argumentsText = event.arguments === undefined
      ? undefined
      : serializeUnknown(event.arguments);
    return (maxPayloadChars) => ({
      ...event,
      content: truncatePreparedText(content, maxPayloadChars),
      ...(argumentsText === undefined
        ? {}
        : { arguments: truncatePreparedText(argumentsText, maxPayloadChars) }),
      metadata,
    });
  }
  if (event.type === "tool_call_started") {
    const argumentsText = serializeUnknown(event.arguments);
    return (maxPayloadChars) => ({
      ...event,
      arguments: truncatePreparedText(argumentsText, maxPayloadChars),
      metadata,
    });
  }
  if (event.type === "assistant_thought") {
    return (maxPayloadChars) => ({
      ...event,
      text: event.text.slice(0, maxPayloadChars),
      metadata,
    });
  }
  return undefined;
}

function isPayloadReducibleEventType(type: string): boolean {
  return type === "assistant_thought"
    || type === "tool_call_started"
    || type === "tool_call_progress"
    || type === "tool_call_completed";
}

/**
 * Reject non-reducible variants before parsing their oversized payload, then
 * stabilize reducible variants from the already serialized frame and probe the
 * minimal candidate before binary search. The search never reserializes the
 * original unbounded provider object, and an oversized invariant field/metadata
 * object falls back after one minimal probe. Measuring each bounded candidate
 * keeps multibyte text, JSON escaping, metadata, and the trailing newline inside
 * the byte contract.
 */
function serializeCappedEventFrame(
  originalEvent: AgentStreamEvent,
  serializedFrame: string,
): string {
  if (!isPayloadReducibleEventType(originalEvent.type)) {
    return serializeOversizedEventMarker(originalEvent.type);
  }
  const event = (JSON.parse(serializedFrame) as Extract<
    AgentStreamWireFrame,
    { kind: "event" }
  >).event;
  const reduceEvent = prepareEventReducer(event);
  if (reduceEvent === undefined) {
    return serializeOversizedEventMarker(event.type);
  }

  const minimal = serializeAgentStreamFrame({ kind: "event", event: reduceEvent(0) });
  if (Buffer.byteLength(minimal, "utf8") > MAX_FRAME_BYTES) {
    return serializeOversizedEventMarker(event.type);
  }

  let lower = 1;
  let upper = MAX_FRAME_BYTES;
  let best = minimal;

  while (lower <= upper) {
    const maxPayloadChars = Math.floor((lower + upper) / 2);
    const candidate = serializeAgentStreamFrame({
      kind: "event",
      event: reduceEvent(maxPayloadChars),
    });
    if (Buffer.byteLength(candidate, "utf8") <= MAX_FRAME_BYTES) {
      best = candidate;
      lower = maxPayloadChars + 1;
    } else {
      upper = maxPayloadChars - 1;
    }
  }

  return best;
}

function serializeOversizedEventMarker(originalType: string): string {
  return serializeAgentStreamFrame({
    kind: "event",
    event: {
      type: "runtime_telemetry",
      kind: "oversized_event",
      data: { originalType: originalType.slice(0, 128) },
      metadata: { truncated: true },
    },
  });
}

function serializeCappedFinishFrame(serializedFrame: string): string {
  const snapshot = JSON.parse(serializedFrame) as Extract<AgentStreamWireFrame, { kind: "finish" }>;
  const safeMetadata = compactFinishMetadata(snapshot.metadata);
  const base: Extract<AgentStreamWireFrame, { kind: "finish" }> = {
    kind: "finish",
    ...(safeMetadata === undefined ? {} : { metadata: safeMetadata }),
  };
  const parts = snapshot.parts ?? [];
  const allPartsFrame = {
    ...base,
    ...(parts.length === 0 ? {} : { parts }),
  };
  const allPartsWithoutText = serializeAgentStreamFrame(allPartsFrame);
  if (Buffer.byteLength(allPartsWithoutText, "utf8") <= MAX_FRAME_BYTES) {
    const withText = serializeFinishWithCappedText(allPartsFrame, snapshot.finalText);
    if (Buffer.byteLength(withText, "utf8") <= MAX_FRAME_BYTES) return withText;
  }

  const failure: AgentReplyPart = {
    type: "failure",
    id: "wire-rich-parts-truncated",
    code: "reply_part_too_large",
    message: "One or more rich reply parts were omitted because the terminal frame exceeded 256 KiB.",
  };
  let frame = {
    ...base,
    ...(snapshot.finalText === undefined ? {} : { finalText: snapshot.finalText }),
    parts: [failure] as AgentReplyPart[],
  };
  let line = serializeAgentStreamFrame(frame);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES && snapshot.finalText !== undefined) {
    frame = {
      ...frame,
      finalText: `${largestTextThatFits(
        snapshot.finalText,
        (candidate) => serializeAgentStreamFrame({ ...frame, finalText: `${candidate}… [truncated]` }),
      )}… [truncated]`,
    };
  }
  const accepted: AgentReplyPart[] = [];
  for (const part of parts) {
    const candidate = serializeAgentStreamFrame({ ...frame, parts: [...accepted, part, failure] });
    if (Buffer.byteLength(candidate, "utf8") <= MAX_FRAME_BYTES) {
      accepted.push(part);
    }
  }
  line = serializeAgentStreamFrame({
    ...frame,
    parts: [...accepted, failure],
  });
  return Buffer.byteLength(line, "utf8") <= MAX_FRAME_BYTES
    ? line
    : serializeAgentStreamFrame({ kind: "finish", metadata: { truncated: true } });
}

function serializeFinishWithCappedText(
  frame: Extract<AgentStreamWireFrame, { kind: "finish" }>,
  finalText: string | undefined,
): string {
  if (finalText === undefined) return serializeAgentStreamFrame(frame);
  const complete = serializeAgentStreamFrame({ ...frame, finalText });
  if (Buffer.byteLength(complete, "utf8") <= MAX_FRAME_BYTES) return complete;
  const suffix = "… [truncated]";
  const text = largestTextThatFits(finalText, (candidate) => serializeAgentStreamFrame({
    ...frame,
    finalText: `${candidate}${suffix}`,
  }));
  return serializeAgentStreamFrame({ ...frame, finalText: `${text}${suffix}` });
}

function compactFinishMetadata(
  metadata: Extract<AgentStreamWireFrame, { kind: "finish" }>["metadata"],
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const compact: Record<string, unknown> = { truncated: true };
  for (const key of ["runId", "conversationId", "requestId"] as const) {
    const value = metadata[key];
    if (typeof value === "string") compact[key] = value.slice(0, 512);
  }
  return compact;
}

function serializeCappedTextFrame(
  frame: Extract<AgentStreamWireFrame, { kind: "status" | "replace" | "error" }>,
): string {
  const suffix = "… [truncated]";
  if (frame.kind === "error") {
    const text = largestTextThatFits(frame.message, (candidate) => serializeAgentStreamFrame({
      ...frame,
      message: `${candidate}${suffix}`,
    }));
    return serializeAgentStreamFrame({ ...frame, message: `${text}${suffix}` });
  }
  const text = largestTextThatFits(frame.text, (candidate) => serializeAgentStreamFrame({
    ...frame,
    text: `${candidate}${suffix}`,
  }));
  return serializeAgentStreamFrame({ ...frame, text: `${text}${suffix}` });
}

function splitTextForWireFrame(kind: "append", text: string): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = largestTextThatFits(
      remaining,
      (candidate) => serializeAgentStreamFrame({ kind, delta: candidate }),
    );
    if (chunk.length === 0) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

function largestTextThatFits(text: string, serialize: (candidate: string) => string): string {
  let lower = 0;
  let upper = text.length;
  let best = "";
  while (lower <= upper) {
    let length = Math.floor((lower + upper) / 2);
    if (length > 0 && isHighSurrogate(text.charCodeAt(length - 1))) length -= 1;
    const candidate = text.slice(0, length);
    if (Buffer.byteLength(serialize(candidate), "utf8") <= MAX_FRAME_BYTES) {
      best = candidate;
      lower = Math.max(lower + 1, length + 1);
    } else {
      upper = length - 1;
    }
  }
  return best;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function serializeUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function truncatePreparedText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… [truncated]` : text;
}

function setReplyArtifactHeaders(res: Response, attachment: AgentReplyAttachmentPart): void {
  const asciiName = attachment.name
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/gu, "_")
    .slice(0, 180) || "attachment";
  const encodedName = encodeURIComponent(attachment.name).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
  res.status(200);
  const risky = /^(?:text\/(?:html|javascript|xml)|application\/(?:javascript|xhtml\+xml|xml)|image\/svg\+xml)$/iu
    .test(attachment.mediaType);
  res.setHeader("Content-Type", risky ? "application/octet-stream" : attachment.mediaType);
  if (risky) res.setHeader("X-Original-Content-Type", attachment.mediaType);
  res.setHeader("Content-Length", String(attachment.sizeBytes));
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Mono-Agent-Integrity-Id", attachment.integrityId);
}

async function writeBinaryChunk(res: Response, chunk: Uint8Array): Promise<void> {
  if (res.destroyed || res.writableEnded) throw new Error("Reply artifact client disconnected.");
  if (res.write(Buffer.from(chunk))) return;
  await new Promise<void>((resolveDrain, rejectDrain) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = (): void => { cleanup(); resolveDrain(); };
    const onClose = (): void => { cleanup(); rejectDrain(new Error("Reply artifact client disconnected.")); };
    const onError = (error: Error): void => { cleanup(); rejectDrain(error); };
    const timer = setTimeout(() => {
      cleanup();
      rejectDrain(new Error("Reply artifact response did not drain in time."));
    }, REPLY_ARTIFACT_DRAIN_TIMEOUT_MS);
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

function normalizeMcpAppIdentity(req: Request): {
  readonly conversationId: string;
  readonly invocationId: string;
  readonly connectionId: string;
} | undefined {
  const conversationId = normalizeOptionalString(
    typeof req.params.conversationId === "string" ? req.params.conversationId : undefined,
  );
  const invocationId = normalizeOptionalString(
    typeof req.params.invocationId === "string" ? req.params.invocationId : undefined,
  );
  const connectionId = normalizeOptionalString(req.header("x-mono-agent-mcp-connection-id"));
  if (
    conversationId === undefined
    || invocationId === undefined
    || connectionId === undefined
    || Buffer.byteLength(conversationId, "utf8") > MAX_MCP_APP_IDENTITY_BYTES
    || Buffer.byteLength(invocationId, "utf8") > MAX_MCP_APP_IDENTITY_BYTES
    || Buffer.byteLength(connectionId, "utf8") > MAX_MCP_APP_IDENTITY_BYTES
  ) return undefined;
  return { conversationId, invocationId, connectionId };
}

function setPrivateMcpAppHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendMcpAppError(res: Response, error: unknown): void {
  const code = codeOf(error);
  const status = code === "app_forbidden" || code === "app_missing" || code === "app_expired"
    ? 404
      : code === "app_request_too_large" ? 413
      : code === "app_tool_forbidden" || code === "app_resource_forbidden" || code === "app_open_link_forbidden" ? 403
        : code === "app_confirmation_required" ? 409
          : code === "app_audit_incomplete" ? 409
          : code === "app_rate_limited" ? 429
          : code === "app_connection_closed" ? 410
            : code === "app_audit_failed" ? 507
            : 500;
  setPrivateMcpAppHeaders(res);
  sendJsonError(res, status, error);
}

interface NormalizedTurnBody {
  readonly conversationId: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly client: "tui" | "web" | "acp";
  readonly processJobWakeDeliveryKey?: string;
  readonly attachments?: readonly AgentAttachment[];
  readonly toolEnvironment?: AgentToolEnvironment;
}

interface NormalizedVerbatimBody {
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

function normalizeVerbatimBody(rawConversationId: string | string[] | undefined, body: unknown): NormalizedVerbatimBody {
  const conversationId = normalizeOptionalString(
    typeof rawConversationId === "string" ? rawConversationId : undefined,
  );
  if (conversationId === undefined) {
    throw new TuiAdapterError("invalid_request", "conversationId is required.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TuiAdapterError("invalid_request", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : undefined;
  const idempotencyKey = normalizeOptionalString(
    typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined,
  );
  if (text === undefined || text.trim().length === 0) {
    throw new TuiAdapterError("invalid_request", "text is required.");
  }
  if (text.length > MAX_VERBATIM_TEXT_CHARACTERS || Buffer.byteLength(text, "utf8") > MAX_VERBATIM_TEXT_BYTES) {
    throw new TuiAdapterError("invalid_request", "text exceeds the history append limit.");
  }
  if (idempotencyKey === undefined || idempotencyKey.length > 512) {
    throw new TuiAdapterError("invalid_request", "idempotencyKey is required and must be at most 512 characters.");
  }
  return { conversationId, text, idempotencyKey };
}

function normalizeTurnBody(
  body: unknown,
  requestToolEnvironment: RequestToolEnvironmentConfig | undefined,
): NormalizedTurnBody {
  if (typeof body !== "object" || body === null) {
    throw new TuiAdapterError("invalid_request", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const conversationId = normalizeOptionalString(
    typeof record.conversationId === "string" ? record.conversationId : undefined,
  );
  if (conversationId === undefined) {
    throw new TuiAdapterError("invalid_request", "conversationId is required.");
  }
  if (record.text !== undefined && typeof record.text !== "string") {
    throw new TuiAdapterError("invalid_request", "text must be a string when provided.");
  }
  const text = typeof record.text === "string" ? record.text : "";
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  if (record.client !== undefined && record.client !== "tui" && record.client !== "web" && record.client !== "acp") {
    throw new TuiAdapterError("invalid_request", "client must be 'tui', 'web', or 'acp' when provided.");
  }
  const client = record.client === "acp"
    ? "acp"
    : record.client === "web" || (record.client === undefined && metadata.source === "web")
      ? "web"
      : "tui";
  const processJobWakeDeliveryKey = normalizeOptionalString(
    typeof record.processJobWakeDeliveryKey === "string"
      ? record.processJobWakeDeliveryKey
      : undefined,
  );
  if (processJobWakeDeliveryKey !== undefined
    && (client !== "web" || processJobWakeDeliveryKey.length > 1_024)) {
    throw new TuiAdapterError("invalid_request", "processJobWakeDeliveryKey is invalid.");
  }
  const attachments = normalizeTurnAttachments(record.attachments, client);
  const toolEnvironment = normalizeRequestToolEnvironment(
    record.toolEnvironment,
    client,
    requestToolEnvironment,
  );
  if (text.length === 0 && (attachments === undefined || attachments.length === 0)) {
    throw new TuiAdapterError("invalid_request", "text or at least one attachment is required.");
  }
  return {
    conversationId,
    text,
    metadata,
    client,
    ...(processJobWakeDeliveryKey === undefined ? {} : { processJobWakeDeliveryKey }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(toolEnvironment === undefined ? {} : { toolEnvironment }),
  };
}

function requestMetadata(body: NormalizedTurnBody, requestId: string): Record<string, unknown> {
  if (body.client === "tui") {
    return { ...body.metadata, source: "tui", tuiRequestId: requestId };
  }
  if (body.client === "acp") {
    return { ...body.metadata, source: "acp", acpRequestId: requestId };
  }

  const web = isRecord(body.metadata.web) ? body.metadata.web : undefined;
  const existingTui = isRecord(body.metadata.tui) ? body.metadata.tui : undefined;
  const overrideMirror = web === undefined
    ? undefined
    : {
        ...(typeof web.model === "string" ? { model: web.model } : {}),
        ...(typeof web.effort === "string" ? { effort: web.effort } : {}),
      };
  const tui = existingTui === undefined && (overrideMirror === undefined || Object.keys(overrideMirror).length === 0)
    ? undefined
    : { ...existingTui, ...overrideMirror };

  const metadata: Record<PropertyKey, unknown> = {
    ...body.metadata,
    web: web ?? {},
    ...(tui === undefined ? {} : { tui }),
    source: "web",
    webRequestId: requestId,
  };
  if (body.processJobWakeDeliveryKey !== undefined) {
    Object.defineProperty(metadata, Symbol.for("mono-agent.process-job-wake.delivery-key.v1"), {
      value: body.processJobWakeDeliveryKey,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return metadata as Record<string, unknown>;
}

function normalizeTurnAttachments(
  value: unknown,
  client: NormalizedTurnBody["client"],
): readonly AgentAttachment[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TuiAdapterError("invalid_request", "attachments must be an array when provided.");
  }
  if (client === "acp" && value.length > 0) {
    throw new TuiAdapterError("invalid_request", "ACP turns do not support attachments.");
  }
  if (client === "web" && value.length > MAX_WEB_ATTACHMENTS) {
    throw new TuiAdapterError(
      "invalid_request",
      `A web turn supports at most ${String(MAX_WEB_ATTACHMENTS)} attachments.`,
    );
  }

  let totalBytes = 0;
  const attachments = value.map((entry, index) => {
    const attachment = normalizeTurnAttachment(entry, index, client);
    totalBytes += attachment.sizeBytes ?? 0;
    return attachment;
  });
  if (client === "web" && totalBytes > MAX_WEB_ATTACHMENT_BYTES) {
    throw new TuiAdapterError(
      "invalid_request",
      `Web turn attachments exceed the ${String(MAX_WEB_ATTACHMENT_BYTES)}-byte aggregate limit.`,
    );
  }
  return attachments;
}

function normalizeRequestToolEnvironment(
  value: unknown,
  client: NormalizedTurnBody["client"],
  config: RequestToolEnvironmentConfig | undefined,
): AgentToolEnvironment | undefined {
  if (value === undefined) return undefined;
  if (client !== "acp") {
    throw new TuiAdapterError("invalid_request", "toolEnvironment is only supported for ACP turns.");
  }
  if (config === undefined) {
    throw new TuiAdapterError("invalid_request", "Request tool environment is not enabled for this agent.");
  }
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.values)) {
    throw new TuiAdapterError("invalid_request", "toolEnvironment must use schema 1 with a values object.");
  }
  const entries = Object.entries(value.values);
  if (entries.length > MAX_REQUEST_TOOL_ENVIRONMENT_KEYS) {
    throw new TuiAdapterError("invalid_request", "toolEnvironment contains too many values.");
  }
  const allowed = new Set(config.allowedKeys);
  const values: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, raw] of entries) {
    if (!allowed.has(key) || typeof raw !== "string" || raw.includes("\0")) {
      throw new TuiAdapterError("invalid_request", `toolEnvironment value '${key}' is not allowed.`);
    }
    const valueBytes = Buffer.byteLength(raw, "utf8");
    if (valueBytes > MAX_REQUEST_TOOL_ENVIRONMENT_VALUE_BYTES) {
      throw new TuiAdapterError("invalid_request", `toolEnvironment value '${key}' is too large.`);
    }
    totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
    values[key] = raw;
  }
  const rawPathPrepend = value.pathPrepend;
  if (rawPathPrepend !== undefined && !config.allowPathPrepend) {
    throw new TuiAdapterError("invalid_request", "toolEnvironment pathPrepend is not enabled.");
  }
  if (rawPathPrepend !== undefined && !Array.isArray(rawPathPrepend)) {
    throw new TuiAdapterError("invalid_request", "toolEnvironment pathPrepend must be an array.");
  }
  const pathPrepend = rawPathPrepend === undefined
    ? undefined
    : rawPathPrepend.map((entry) => {
        if (typeof entry !== "string" || !isAbsolute(entry) || entry.includes("\0")) {
          throw new TuiAdapterError("invalid_request", "toolEnvironment pathPrepend entries must be absolute paths.");
        }
        totalBytes += Buffer.byteLength(entry, "utf8");
        return entry;
      });
  if ((pathPrepend?.length ?? 0) > MAX_REQUEST_TOOL_ENVIRONMENT_PATHS) {
    throw new TuiAdapterError("invalid_request", "toolEnvironment pathPrepend contains too many paths.");
  }
  if (totalBytes > MAX_REQUEST_TOOL_ENVIRONMENT_TOTAL_BYTES) {
    throw new TuiAdapterError("invalid_request", "toolEnvironment exceeds the aggregate byte limit.");
  }
  return {
    schema: 1,
    values,
    ...(pathPrepend === undefined || pathPrepend.length === 0 ? {} : { pathPrepend }),
  };
}

function normalizeTurnAttachment(
  value: unknown,
  index: number,
  client: NormalizedTurnBody["client"],
): AgentAttachment {
  if (!isRecord(value)) {
    throw invalidAttachment(index, "must be a JSON object");
  }
  if (value.kind !== "image" && value.kind !== "document") {
    throw invalidAttachment(index, "kind must be 'image' or 'document'");
  }
  const mimeType = normalizeOptionalString(typeof value.mimeType === "string" ? value.mimeType : undefined);
  if (mimeType === undefined) {
    throw invalidAttachment(index, "mimeType is required");
  }
  const normalizedMimeType = mimeType.toLowerCase();
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    throw invalidAttachment(index, `MIME type '${mimeType}' is not allowed`);
  }
  if (value.kind !== agentAttachmentKindFromMimeType(normalizedMimeType)) {
    throw invalidAttachment(index, `kind does not match MIME type '${mimeType}'`);
  }
  if (typeof value.data !== "string" || !isCanonicalBase64(value.data)) {
    throw invalidAttachment(index, "data must be canonical base64");
  }
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.byteLength > DEFAULT_AGENT_ATTACHMENT_MAX_BYTES) {
    throw invalidAttachment(
      index,
      `decoded data exceeds the ${String(DEFAULT_AGENT_ATTACHMENT_MAX_BYTES)}-byte limit`,
    );
  }
  const name = optionalAttachmentString(value.name, index, "name");
  // Web uploads intentionally carry the bytes only. Reconstruct text after
  // decoding so a valid 64 MiB turn remains bounded by the 96 MiB JSON parser
  // and browser-supplied text can never disagree with the attachment bytes.
  // Legacy TUI callers retain their explicit extracted-text behavior.
  const text = client === "web"
    ? decodeAgentAttachmentText(normalizedMimeType, decoded)
    : optionalAttachmentString(value.text, index, "text");
  const declaredSizeBytes = optionalAttachmentNumber(value.sizeBytes, index, "sizeBytes");
  if (declaredSizeBytes !== undefined && declaredSizeBytes !== decoded.byteLength) {
    throw invalidAttachment(index, "sizeBytes does not match decoded data");
  }
  const durationSeconds = optionalAttachmentNumber(value.durationSeconds, index, "durationSeconds");

  return {
    kind: value.kind,
    mimeType,
    data: value.data,
    sizeBytes: decoded.byteLength,
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

function optionalAttachmentString(
  value: unknown,
  index: number,
  field: "name" | "text",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidAttachment(index, `${field} must be a string when provided`);
  }
  return value;
}

function optionalAttachmentNumber(
  value: unknown,
  index: number,
  field: "sizeBytes" | "durationSeconds",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidAttachment(index, `${field} must be a non-negative finite number when provided`);
  }
  return value;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  if (value.length === 0) {
    return true;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const payloadLength = value.length - padding;
  for (let index = 0; index < payloadLength; index += 1) {
    if (base64Value(value.charCodeAt(index)) === undefined) {
      return false;
    }
  }
  // Padding is only legal in the final quartet, and its unused bits must be
  // zero for the spelling to be canonical rather than merely decodable.
  if (padding === 2) {
    const tail = base64Value(value.charCodeAt(payloadLength - 1));
    return payloadLength >= 2 && tail !== undefined && (tail & 0b1111) === 0;
  }
  if (padding === 1) {
    const tail = base64Value(value.charCodeAt(payloadLength - 1));
    return payloadLength >= 3 && tail !== undefined && (tail & 0b11) === 0;
  }
  return true;
}

function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
}

function invalidAttachment(index: number, reason: string): TuiAdapterError {
  return new TuiAdapterError("invalid_request", `attachments[${String(index)}] ${reason}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveInfo(info: TuiAdapterOptions["info"]): Promise<TuiAdapterInfo | undefined> {
  if (typeof info === "function") {
    return await info();
  }
  return info;
}

function normalizeModelCatalogRequest(req: Request): TuiModelCatalogRequest {
  const rawProvider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  const provider = normalizeOptionalString(rawProvider);
  if (provider !== undefined && Buffer.byteLength(provider, "utf8") > MAX_MODEL_CATALOG_PROVIDER_BYTES) {
    throw new TuiAdapterError("invalid_request", "provider is too large.");
  }
  const rawQuery = typeof req.query.q === "string" ? req.query.q : undefined;
  const query = normalizeOptionalString(rawQuery);
  if (query !== undefined && Buffer.byteLength(query, "utf8") > MAX_MODEL_CATALOG_QUERY_BYTES) {
    throw new TuiAdapterError("invalid_request", "q is too large.");
  }
  const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const cursor = normalizeOptionalString(rawCursor);
  if (cursor !== undefined && Buffer.byteLength(cursor, "utf8") > MAX_MODEL_CATALOG_CURSOR_BYTES) {
    throw new TuiAdapterError("invalid_request", "cursor is too large.");
  }
  if (provider === undefined && query === undefined) {
    throw new TuiAdapterError("invalid_request", "provider or q is required.");
  }
  // `TuiModelCatalogRequest` documents the two modes as mutually exclusive and
  // suppliers honour that by servicing `provider` and ignoring `query`. Sending
  // both must therefore be a client error, not a silently provider-scoped page
  // that looks like it answered the search.
  if (provider !== undefined && query !== undefined) {
    throw new TuiAdapterError("invalid_request", "provider and q are mutually exclusive.");
  }
  const rawLimit = typeof req.query.limit === "string"
    ? Number(req.query.limit)
    : DEFAULT_MODEL_CATALOG_PAGE_SIZE;
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_MODEL_CATALOG_PAGE_SIZE) {
    throw new TuiAdapterError(
      "invalid_request",
      `limit must be 1-${String(MAX_MODEL_CATALOG_PAGE_SIZE)}.`,
    );
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(query === undefined ? {} : { query }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: rawLimit,
  };
}



/**
 * `/v1/info` fields the fence may shed, least load-bearing first. Every one of
 * them is already optional on the wire — the response literal omits each when
 * its source is absent — so shedding produces a body that is still valid at
 * schema 1, which matters because `TUI_WIRE_SCHEMA` is compared with `!==` and
 * cannot be bumped. `schema`, `pid` and `capabilities` are never sheddable:
 * they are the liveness and negotiation half of the response.
 */
const INFO_SHED_ORDER = [
  "modelOptions",
  "models",
  "providers",
  "skills",
  "label",
  "effort",
  "model",
] as const;

type SheddableInfoField = (typeof INFO_SHED_ORDER)[number];

/**
 * Send `/v1/info` under the byte contract its consumer enforces.
 *
 * Every contributor to this body carries its own producer-side budget (see the
 * budget table in `agent-app`'s `channel-drivers/tui.ts`, and
 * `MAX_SKILL_REGISTRY_BYTES` for skills) and those budgets sum to 960 KiB. This
 * is the last-resort fence behind them: without it the ONLY enforcement of the
 * 1 MiB cap lived in the consumer, so any producer-side miss took the agent
 * offline instead of degrading it.
 *
 * It measures the exact string it sends rather than estimating, and sends that
 * string rather than re-serializing, so what was measured is what goes on the
 * wire. Shedding is logged at error level: a body that reaches this fence is a
 * producer bug, and it must not disappear silently.
 */
function sendBoundedInfo(
  res: Response,
  body: Record<string, unknown>,
  logger: TuiAdapterLogger | undefined,
): void {
  const candidate: Record<string, unknown> = { ...body };
  const dropped: string[] = [];
  let serialized = serializeInfoBody(candidate);
  while (serialized === undefined) {
    const field = largestSheddableInfoField(candidate);
    // Each pass removes one field from a finite set, so this terminates.
    if (field === undefined) break;
    delete candidate[field];
    dropped.push(field);
    serialized = serializeInfoBody(candidate);
  }
  if (serialized !== undefined) {
    if (dropped.length > 0) {
      logger?.error?.("TUI info body exceeded its wire budget; fields were dropped.", {
        droppedFields: dropped.join(","),
      });
    }
    res.status(200).type("application/json").send(serialized);
    return;
  }
  // Nothing sheddable is left and the remainder still will not fit (or will not
  // serialize at all). Fall back to the fixed liveness floor: a schema-1 body
  // small by construction, which keeps the agent reachable and its capability
  // negotiation honest rather than answering 500 and reading as offline.
  logger?.error?.("TUI info body could not be bounded; served the minimal liveness body.", {
    droppedFields: dropped.join(","),
  });
  res.status(200).type("application/json").send(JSON.stringify({
    schema: TUI_WIRE_SCHEMA,
    pid: process.pid,
    capabilities: { attachments: true },
  }));
}

/**
 * The optional field costing the most bytes right now.
 *
 * Shedding the biggest field first means the fence removes what is ACTUALLY
 * oversized instead of four innocent projections queued ahead of it: a 1.5 MiB
 * `skills` registry costs the console its skills, not its model picker as well.
 * Ties break towards the front of `INFO_SHED_ORDER` (least load-bearing first),
 * so the choice is deterministic. A field whose own value will not serialize
 * sorts first of all — it is the reason the body cannot be measured at all.
 */
function largestSheddableInfoField(
  body: Record<string, unknown>,
): SheddableInfoField | undefined {
  let largest: SheddableInfoField | undefined;
  let largestBytes = -1;
  for (const field of INFO_SHED_ORDER) {
    if (!(field in body)) continue;
    const bytes = infoFieldBytes(body[field]);
    if (bytes > largestBytes) {
      largest = field;
      largestBytes = bytes;
    }
  }
  return largest;
}

/** Serialized size of one field value; `Infinity` when it cannot be serialized at all. */
function infoFieldBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? Buffer.byteLength(serialized, "utf8")
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Serialize the candidate body, or `undefined` when it does not fit or does not serialize. */
function serializeInfoBody(body: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return undefined;
  }
  // `JSON.stringify` yields undefined for a non-serializable top-level value.
  if (typeof serialized !== "string") return undefined;
  return Buffer.byteLength(serialized, "utf8") > MAX_INFO_BODY_BYTES ? undefined : serialized;
}

function sendBoundedModelCatalog(res: Response, page: TuiModelCatalogPage): void {
  const body = JSON.stringify(page);
  if (Buffer.byteLength(body, "utf8") > MAX_MODEL_CATALOG_RESPONSE_BYTES) {
    // The supplier is expected to pre-bound pages; hitting this fence is a
    // producer bug, not a client mistake, so it reads as a 500.
    throw new TuiAdapterError(
      "model_catalog_too_large",
      "Model catalog page exceeded its bounded wire contract.",
    );
  }
  res.status(200).type("application/json").send(body);
}

function cronJobId(value: string | readonly string[] | undefined): string {
  const raw = typeof value === "string" ? value : undefined;
  const jobId = normalizeOptionalString(raw);
  if (jobId === undefined || Buffer.byteLength(jobId, "utf8") > 512) {
    throw new CronOperatorError("invalid_request", "A valid cron job id is required.", 400);
  }
  return jobId;
}

function cronRunId(value: string | readonly string[] | undefined): string {
  const raw = typeof value === "string" ? value : undefined;
  const runId = normalizeOptionalString(raw);
  if (runId === undefined || Buffer.byteLength(runId, "utf8") > 4_096) {
    throw new CronOperatorError("invalid_request", "A valid cron run id is required.", 400);
  }
  return runId;
}

function cronActionInput(value: unknown): CronOperatorActionInput {
  if (!isRecord(value)) {
    throw new CronOperatorError("invalid_request", "A JSON action body is required.", 400);
  }
  const idempotencyKey = normalizeOptionalString(
    typeof value.idempotencyKey === "string" ? value.idempotencyKey : undefined,
  );
  if (idempotencyKey === undefined || Buffer.byteLength(idempotencyKey, "utf8") > 256) {
    throw new CronOperatorError("invalid_request", "A valid idempotencyKey is required.", 400);
  }
  const confirmationToken = normalizeOptionalString(
    typeof value.confirmationToken === "string" ? value.confirmationToken : undefined,
  );
  if (confirmationToken !== undefined && Buffer.byteLength(confirmationToken, "utf8") > 1_024) {
    throw new CronOperatorError("invalid_request", "confirmationToken is too large.", 400);
  }
  return { idempotencyKey, ...(confirmationToken === undefined ? {} : { confirmationToken }) };
}

function requireCronActionKey(res: Response, apiKey: string | undefined): boolean {
  if (apiKey !== undefined) return true;
  sendJsonError(
    res,
    403,
    new CronOperatorError("actions_disabled", "Cron actions require an operator API key.", 403),
  );
  return false;
}

function sendCronMutation(
  res: Response,
  result: { readonly kind: "confirmation_required"; readonly confirmation: unknown }
    | { readonly kind: "completed"; readonly value: unknown; readonly replayed: boolean },
): void {
  if (result.kind === "confirmation_required") {
    sendBoundedCronJson(res, 428, result);
    return;
  }
  sendBoundedCronJson(res, 200, result);
}

function sendBoundedCronJson(res: Response, status: number, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CRON_OPERATOR_RESPONSE_BYTES) {
    throw new CronOperatorError(
      "unavailable",
      "Cron operator response exceeded its bounded wire contract.",
      503,
    );
  }
  res.status(status).type("application/json").send(serialized);
}

function authorize(req: Request, res: Response, apiKey: string | undefined): boolean {
  if (apiKey === undefined) {
    return true;
  }
  const presented = readAuthorizationBearer(req.header("authorization"));
  if (presented !== undefined && bearerTokensEqual(presented, apiKey)) {
    return true;
  }
  res.status(401).json({ error: { message: "Invalid API key.", code: "invalid_api_key" } });
  return false;
}

function sendJsonError(res: Response, status: number, error: unknown): void {
  res.status(status).json({
    error: {
      message: errorToMessage(error),
      ...(codeOf(error) === undefined ? {} : { code: codeOf(error) }),
    },
  });
}

function sendBoundedJobs(res: Response, jobs: readonly unknown[]): void {
  const body = serializeBoundedJobs(jobs);
  if (body === undefined) {
    sendJsonError(
      res,
      413,
      new TuiAdapterError(
        "process_job_response_too_large",
        `Process-job list exceeds the ${String(MAX_PROCESS_JOBS_RESPONSE_BYTES)}-byte operator response bound.`,
      ),
    );
    return;
  }
  res.status(200).type("application/json").send(body);
}

function serializeBoundedJobs(jobs: readonly unknown[]): string | undefined {
  const parsed = parseProcessJobProjections(jobs);
  const selected = new Map<number, string>();
  let selectedCount = 0;
  let bodyBytes = Buffer.byteLength('{"jobs":[]}', "utf8");

  const add = (index: number, projection: ProcessJobProjection): boolean => {
    const serialized = JSON.stringify(projection);
    const nextBytes = bodyBytes
      + Buffer.byteLength(serialized, "utf8")
      + (selectedCount === 0 ? 0 : 1);
    if (nextBytes > MAX_PROCESS_JOBS_RESPONSE_BYTES) return false;
    selected.set(index, serialized);
    selectedCount += 1;
    bodyBytes = nextBytes;
    return true;
  };

  // The app can retain up to 32 starting/running and 64 queued records
  // alongside its terminal ceiling. Keep that complete control-plane view
  // even when large terminal projections require a smaller HTTP representation.
  for (const [index, projection] of parsed.entries()) {
    if (isActiveProcessJobProjection(projection) && !add(index, projection)) return undefined;
  }

  // Service lists are already newest-first. Select one deterministic terminal
  // prefix so a larger byte budget can only extend, never reshuffle, history.
  for (const [index, projection] of parsed.entries()) {
    if (isActiveProcessJobProjection(projection)) continue;
    if (!add(index, projection)) break;
  }

  const serialized = [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, projection]) => projection);
  return `{"jobs":[${serialized.join(",")}]}`;
}

function isActiveProcessJobProjection(projection: ProcessJobProjection): boolean {
  return projection.state === "queued"
    || projection.state === "starting"
    || projection.state === "running";
}

function sendBoundedJob(res: Response, job: unknown): void {
  const body = JSON.stringify(parseProcessJobProjection(job));
  if (Buffer.byteLength(body, "utf8") > MAX_PROCESS_JOBS_RESPONSE_BYTES) {
    sendJsonError(
      res,
      413,
      new TuiAdapterError(
        "process_job_response_too_large",
        `Process-job projection exceeds the ${String(MAX_PROCESS_JOBS_RESPONSE_BYTES)}-byte operator response bound.`,
      ),
    );
    return;
  }
  res.status(200).type("application/json").send(body);
}

function codeOf(error: unknown): string | undefined {
  const candidate = (error as { code?: unknown } | null)?.code;
  return typeof candidate === "string" ? candidate : undefined;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith("/")) {
    throw new TuiAdapterError("invalid_config", "basePath must start with '/'.");
  }
  return basePath.length === 1 ? "" : basePath.replace(/\/+$/u, "");
}

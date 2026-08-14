import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import {
  closeServerBounded,
  hostForUrl,
  isLoopbackHost,
  isWildcardHost,
  listen,
  normalizeHostForBind,
} from "@mono-agent/agent-contracts";
import express from "express";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";

import { abortAdvisorRun } from "./cancellation.js";
import { ADVISOR_MAX_REQUEST_BYTES, type AdvisorConfig, validateAdvisorPath } from "./config.js";
import { AdvisorConcurrencyGate } from "./concurrency.js";
import { createAdvisorContinuityCache, type AdvisorContinuityCache } from "./continuity.js";
import { AdvisorError } from "./errors.js";
import { createAdvisorMcpServer } from "./mcp-server.js";
import type { AdvisorRunFactory } from "./run.js";

export interface AdvisorServerLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface StartAdvisorServerOptions {
  readonly config: AdvisorConfig;
  readonly runFactory: AdvisorRunFactory;
  readonly logger?: AdvisorServerLogger;
  readonly onFailure?: (reason: string) => void;
  readonly continuity?: AdvisorContinuityCache;
}

export interface RunningAdvisorServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly continuity: AdvisorContinuityCache;
  stop(): Promise<void>;
}

const JSON_RPC_PARSE_ERROR = -32_700;
const JSON_RPC_INVALID_REQUEST = -32_600;
const JSON_RPC_SERVER_ERROR = -32_603;
const JSON_RPC_ACCESS_DENIED = -32_001;
const SERVER_CLOSE_GRACE_MS = 5_000;
const SERVER_ACTIVE_REQUEST_DRAIN_MS = 12_000;
const SERVER_COMPONENT_CLOSE_MS = 1_000;
const HTTP_REQUEST_TIMEOUT_MS = 60_000;

export async function startAdvisorServer(
  options: StartAdvisorServerOptions,
): Promise<RunningAdvisorServer> {
  validateStartConfig(options.config);
  const config = options.config;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const hostAndOrigin = hostAndOriginPolicy(config);
  let endpointRequiresBearer = requiresBearer(config);
  const bearer = bearerPolicy(config, () => endpointRequiresBearer);
  const parseJson = express.json({
    inflate: false,
    limit: config.maxRequestBytes,
    strict: true,
    type: "application/json",
  });
  const shutdownController = new AbortController();
  const admission = new AdvisorConcurrencyGate(config.maxConcurrentReviews);
  const continuity = options.continuity ?? createAdvisorContinuityCache(config);
  const activeRequests = new Set<Promise<void>>();

  app.options(config.path, hostAndOrigin, (_request, response) => {
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version");
    response.setHeader("Access-Control-Max-Age", "600");
    response.status(204).end();
  });
  app.post(
    config.path,
    hostAndOrigin,
    bearer,
    requireJsonContentType,
    rejectAmbiguousRequestFraming,
    rejectOversizedContentLength(config.maxRequestBytes),
    validateMcpRequestHeaders,
    parseJson,
    validateJsonRpcEnvelope,
    (request, response) => {
      let task: Promise<void>;
      task = handleMcpRequest({
        request,
        response,
        config,
        runFactory: options.runFactory,
        shutdownSignal: shutdownController.signal,
        admission,
        continuity,
      }).finally(() => activeRequests.delete(task));
      activeRequests.add(task);
      void task;
    },
  );
  app.all(config.path, hostAndOrigin, (_request, response) => {
    writeJsonRpcError(response, 405, JSON_RPC_INVALID_REQUEST, "Method not allowed.");
  });
  app.use((_request, response) => {
    writeJsonRpcError(response, 404, JSON_RPC_INVALID_REQUEST, "Not found.");
  });
  app.use(jsonErrorHandler());

  const httpServer = createServer(app);
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxRequestsPerSocket = 100;
  const bindHost = normalizeHostForBind(config.host);
  const address = await listen(httpServer, config.port, bindHost, {
    listenFailed: () => new AdvisorError("listen_failed", "Advisor MCP could not bind its configured endpoint."),
    noAddress: () => new AdvisorError("no_address", "Advisor MCP did not expose a TCP address."),
  });
  try {
    assertAdvisorBoundAddress(config, address);
    endpointRequiresBearer ||= !isLoopbackHost(address.address);
  } catch (error) {
    await closeServerBounded(httpServer, SERVER_CLOSE_GRACE_MS);
    throw error;
  }
  let stopping = false;
  const onServerError = (): void => {
    if (stopping) return;
    admission.close();
    abortAdvisorRun(shutdownController, "server_shutdown");
    options.logger?.error?.("Advisor MCP HTTP server stopped unexpectedly.");
    options.onFailure?.("Advisor MCP HTTP server stopped unexpectedly.");
  };
  httpServer.on("error", onServerError);
  const configuredPublicHost = headerHostName(config.host);
  const publicHost = !isWildcardHost(config.host)
      && config.allowedHosts.some((host) => host.toLowerCase() === configuredPublicHost.toLowerCase())
    ? configuredPublicHost
    : config.allowedHosts[0];
  if (publicHost === undefined) {
    await closeServerBounded(httpServer, SERVER_CLOSE_GRACE_MS);
    throw new AdvisorError("no_address", "Advisor MCP has no safe public host for its endpoint URL.");
  }
  const url = `http://${hostForUrl(publicHost)}:${address.port}${config.path}`;
  options.logger?.info?.("Advisor MCP listening.", {
    host: config.host,
    port: address.port,
    path: config.path,
    authenticated: endpointRequiresBearer,
  });

  let stopPromise: Promise<void> | undefined;
  return {
    url,
    host: config.host,
    port: address.port,
    path: config.path,
    continuity,
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        admission.close();
        abortAdvisorRun(shutdownController, "server_shutdown");
        const serverClose = closeServerBounded(httpServer, SERVER_CLOSE_GRACE_MS);
        await settleActiveRequests(activeRequests, SERVER_ACTIVE_REQUEST_DRAIN_MS);
        await serverClose;
        continuity.clear();
        httpServer.off("error", onServerError);
      })();
      return stopPromise;
    },
  };
}

export function assertAdvisorBoundAddress(
  config: Pick<AdvisorConfig, "allowNonLoopback" | "bearerToken" | "allowedHosts">,
  address: Pick<AddressInfo, "address">,
): void {
  if (isLoopbackHost(address.address)) return;
  if (!config.allowNonLoopback) {
    throw new AdvisorError("unsafe_host", "Advisor MCP resolved or bound outside loopback without explicit permission.");
  }
  if (config.bearerToken === undefined || config.allowedHosts.length === 0) {
    throw new AdvisorError("missing_required_config", "Advisor MCP non-loopback binds require bearer auth and allowed hosts.");
  }
}

export function constantTimeBearerMatches(
  expectedToken: string,
  authorizationValues: readonly string[],
): boolean {
  const match = authorizationValues.length === 1
    ? /^Bearer ([^\s]+)$/u.exec(authorizationValues[0] ?? "")
    : null;
  const candidate = match?.[1] ?? "";
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest) && match !== null;
}

function validateStartConfig(config: AdvisorConfig): void {
  validateAdvisorPath(config.path);
  if (!config.enabled) {
    throw new AdvisorError("invalid_config", "Advisor MCP cannot start while advisor.enabled is false.");
  }
  if (config.model === undefined || config.effort === undefined) {
    throw new AdvisorError("missing_required_config", "Advisor MCP requires explicit model and effort configuration.");
  }
  if (config.maxRequestBytes > ADVISOR_MAX_REQUEST_BYTES) {
    throw new AdvisorError("invalid_config", `Advisor MCP request bodies may not exceed ${ADVISOR_MAX_REQUEST_BYTES} bytes.`);
  }
  if (!isLoopbackHost(config.host)) {
    if (!config.allowNonLoopback) {
      throw new AdvisorError("unsafe_host", "Advisor MCP refuses an unsafe non-loopback bind.");
    }
    if (config.bearerToken === undefined || config.allowedHosts.length === 0) {
      throw new AdvisorError("missing_required_config", "Advisor MCP non-loopback binds require bearer auth and allowed hosts.");
    }
  } else if (config.requireBearer && config.bearerToken === undefined) {
    throw new AdvisorError("missing_required_config", "Advisor MCP bearer authentication is enabled without a token.");
  }
}

function hostAndOriginPolicy(config: AdvisorConfig): RequestHandler {
  const allowedHosts = new Set(config.allowedHosts.map((host) => host.toLowerCase()));
  const allowedOrigins = new Set(config.allowedOrigins);
  return (request, response, next) => {
    setSafeResponseHeaders(response);
    const hostValues = rawHeaderValues(request, "host", 1_024);
    if (hostValues.length !== 1 || !allowedHostHeader(hostValues[0] ?? "", allowedHosts)) {
      writeJsonRpcError(response, 403, JSON_RPC_ACCESS_DENIED, "Host is not allowed.");
      return;
    }
    const originValues = rawHeaderValues(request, "origin", 2_048);
    if (originValues.length > 1 || (originValues.length === 1 && !allowedOrigins.has(originValues[0] ?? ""))) {
      writeJsonRpcError(response, 403, JSON_RPC_ACCESS_DENIED, "Origin is not allowed.");
      return;
    }
    const origin = originValues[0];
    if (origin !== undefined) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    next();
  };
}

function bearerPolicy(config: AdvisorConfig, mustAuthenticate: () => boolean): RequestHandler {
  return (request, response, next) => {
    if (!mustAuthenticate()) {
      next();
      return;
    }
    const authorizationValues = rawHeaderValues(request, "authorization", 8_192);
    if (config.bearerToken === undefined
      || !constantTimeBearerMatches(config.bearerToken, authorizationValues)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      writeJsonRpcError(response, 401, JSON_RPC_ACCESS_DENIED, "Authentication required.");
      return;
    }
    next();
  };
}

function requiresBearer(config: AdvisorConfig): boolean {
  return config.requireBearer || !isLoopbackHost(config.host);
}

function allowedHostHeader(raw: string, allowed: ReadonlySet<string>): boolean {
  if (raw.length === 0
    || raw.length > 1_024
    || /[\u0000-\u0020\u007f@/?#,\\]/u.test(raw)) return false;
  try {
    const parsed = new URL(`http://${raw}`);
    return parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === "/"
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && allowed.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function rawHeaderValues(request: Request, name: string, maxChars: number): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    const value = request.rawHeaders[index + 1];
    if (value === undefined || value.length > maxChars) return ["", ""];
    values.push(value);
  }
  return values;
}

const requireJsonContentType: RequestHandler = (request, response, next) => {
  const values = rawHeaderValues(request, "content-type", 256);
  if (values.length !== 1 || !request.is("application/json")) {
    writeJsonRpcError(response, 415, JSON_RPC_INVALID_REQUEST, "Content-Type must be application/json.");
    return;
  }
  next();
};

const rejectAmbiguousRequestFraming: RequestHandler = (request, response, next) => {
  const contentLengths = rawHeaderValues(request, "content-length", 64);
  const transferEncodings = rawHeaderValues(request, "transfer-encoding", 128);
  if (contentLengths.length > 1
    || transferEncodings.length > 1
    || (contentLengths.length === 1 && !/^\d+$/u.test(contentLengths[0] ?? ""))
    || (transferEncodings.length === 1 && transferEncodings[0]?.toLowerCase() !== "chunked")
    || (contentLengths.length > 0 && transferEncodings.length > 0)) {
    writeJsonRpcError(response, 400, JSON_RPC_INVALID_REQUEST, "Ambiguous HTTP request framing.");
    return;
  }
  next();
};

function rejectOversizedContentLength(maxBytes: number): RequestHandler {
  return (request, response, next) => {
    const raw = rawHeaderValues(request, "content-length", 64)[0];
    if (raw !== undefined && Number(raw) > maxBytes) {
      writeJsonRpcError(response, 413, JSON_RPC_INVALID_REQUEST, "Request body is too large.");
      return;
    }
    next();
  };
}

const validateMcpRequestHeaders: RequestHandler = (request, response, next) => {
  const accept = rawHeaderValues(request, "accept", 256);
  const protocol = rawHeaderValues(request, "mcp-protocol-version", 64);
  const session = rawHeaderValues(request, "mcp-session-id", 256);
  const lastEventId = rawHeaderValues(request, "last-event-id", 256);
  if (accept.length !== 1 || protocol.length > 1 || session.length > 0 || lastEventId.length > 0) {
    writeJsonRpcError(response, 400, JSON_RPC_INVALID_REQUEST, "Invalid stateless MCP request headers.");
    return;
  }
  if (protocol.length === 1 && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol[0] ?? "")) {
    writeJsonRpcError(response, 400, JSON_RPC_INVALID_REQUEST, "Unsupported MCP protocol version.");
    return;
  }
  next();
};

const validateJsonRpcEnvelope: RequestHandler = (request, response, next) => {
  const body: unknown = request.body;
  if (!isRecord(body)
    || (typeof body.id === "string" && body.id.length > 128)
    || (body.id !== undefined && typeof body.id !== "string" && typeof body.id !== "number" && body.id !== null)
    || (typeof body.method === "string" && body.method.length > 128)
    || (body.method !== undefined && typeof body.method !== "string")
    || (isRecord(body.params) && typeof body.params.name === "string" && body.params.name.length > 128)) {
    writeJsonRpcError(response, 400, JSON_RPC_INVALID_REQUEST, "Invalid bounded JSON-RPC request envelope.");
    return;
  }
  next();
};

async function handleMcpRequest(input: {
  readonly request: Request;
  readonly response: Response;
  readonly config: AdvisorConfig;
  readonly runFactory: AdvisorRunFactory;
  readonly shutdownSignal: AbortSignal;
  readonly admission: AdvisorConcurrencyGate;
  readonly continuity: AdvisorContinuityCache;
}): Promise<void> {
  const requestController = new AbortController();
  const onAborted = (): void => abortAdvisorRun(requestController, "request_aborted");
  const onClosed = (): void => {
    if (!input.response.writableFinished) {
      abortAdvisorRun(requestController, "client_disconnected");
    }
  };
  input.request.once("aborted", onAborted);
  input.response.once("close", onClosed);
  const mcpServer = createAdvisorMcpServer({
    config: input.config,
    runFactory: input.runFactory,
    shutdownSignal: input.shutdownSignal,
    requestSignal: requestController.signal,
    admission: input.admission,
    continuity: input.continuity,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  try {
    await mcpServer.connect(transport as unknown as Transport);
    await transport.handleRequest(
      input.request as IncomingMessage,
      input.response as ServerResponse,
      input.request.body,
    );
  } catch {
    abortAdvisorRun(requestController, "request_aborted");
    if (canWrite(input.response)) {
      writeJsonRpcError(input.response, 500, JSON_RPC_SERVER_ERROR, "Advisor MCP request failed.");
    }
  } finally {
    input.request.off("aborted", onAborted);
    input.response.off("close", onClosed);
    await settleComponentClose(
      Promise.resolve().then(async () => await transport.close()),
      SERVER_COMPONENT_CLOSE_MS,
    );
    await settleComponentClose(
      Promise.resolve().then(async () => await mcpServer.close()),
      SERVER_COMPONENT_CLOSE_MS,
    );
  }
}

async function settleComponentClose(task: Promise<void>, timeoutMs: number): Promise<void> {
  void task.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolvePromise) => {
      timer = setTimeout(resolvePromise, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

async function settleActiveRequests(activeRequests: ReadonlySet<Promise<void>>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeRequests.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...activeRequests]),
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, remaining);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
}

function headerHostName(host: string): string {
  const normalized = normalizeHostForBind(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function jsonErrorHandler(): ErrorRequestHandler {
  return (error, _request, response, _next) => {
    if (!canWrite(response)) return;
    if (isRecord(error) && error.type === "entity.too.large") {
      writeJsonRpcError(response, 413, JSON_RPC_INVALID_REQUEST, "Request body is too large.");
      return;
    }
    if (error instanceof SyntaxError || (isRecord(error) && error.type === "entity.parse.failed")) {
      writeJsonRpcError(response, 400, JSON_RPC_PARSE_ERROR, "Request body is not valid JSON.");
      return;
    }
    writeJsonRpcError(response, 500, JSON_RPC_SERVER_ERROR, "Advisor MCP request failed.");
  };
}

function setSafeResponseHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function writeJsonRpcError(
  response: Response,
  status: number,
  code: number,
  message: string,
): void {
  if (!canWrite(response)) return;
  setSafeResponseHeaders(response);
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function canWrite(response: Response): boolean {
  return !response.destroyed && !response.writableEnded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

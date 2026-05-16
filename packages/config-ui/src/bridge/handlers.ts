import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MonoAgentConfigError,
  readMonoAgentConfigJson,
  writeMonoAgentConfigJson,
} from "@worklab-ai/config";
import type { MonoAgentConfigJson } from "@worklab-ai/config";

import { CONFIG_UI_STATIC_DIR } from "../static.js";
import type { FieldGroup } from "../schema/types.js";
import { readBearerToken, tokensEqual } from "./auth.js";
import {
  observabilityRunResponse,
  observabilityRunsResponse,
} from "./observability.js";
import { validatePatch } from "./patch-validator.js";
import { redactSecrets } from "./redact.js";
import type { ConfigUiBridgeEvent, ConfigUiObservabilityOptions } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export interface HandlerDeps {
  readonly token: string;
  readonly configPath: string;
  readonly fieldGroups: readonly FieldGroup[];
  readonly staticDir: string;
  readonly observability?: ConfigUiObservabilityOptions;
  readonly log?: (event: ConfigUiBridgeEvent) => void;
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();

  // Health is unauthenticated — easier for the demo CLI to wait on.
  if (method === "GET" && pathOf(url) === "/api/health") {
    return json(res, 200, { ok: true });
  }

  // All other /api routes require the bearer token.
  if (pathOf(url).startsWith("/api/")) {
    const provided = readBearerToken(req.headers, url);
    if (!provided || !tokensEqual(provided, deps.token)) {
      deps.log?.({ kind: "unauthorized", path: pathOf(url) });
      return json(res, 401, { error: "unauthorized" });
    }
    return routeApi(req, res, deps, method, pathOf(url));
  }

  // Static SPA shell. We deliberately do NOT enforce the bearer token on
  // the HTML/asset routes so the human can open the URL in their browser;
  // the SPA then uses the token (passed via ?t=) for /api calls.
  return serveStatic(res, url, deps);
}

async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  method: string,
  path: string,
): Promise<void> {
  if (method === "GET" && path === "/api/schema") {
    return json(res, 200, { fieldGroups: deps.fieldGroups });
  }
  if (method === "GET" && path === "/api/config") {
    try {
      const { json: raw, version } = await readMonoAgentConfigJson(deps.configPath);
      deps.log?.({ kind: "read", path: deps.configPath });
      return json(res, 200, {
        config: redactSecrets(raw, deps.fieldGroups),
        version,
      });
    } catch (error) {
      return json(res, 500, errorBody(error));
    }
  }
  if (method === "GET" && path === "/api/observability/runs") {
    const result = await observabilityRunsResponse(deps.observability);
    return json(res, result.status, result.body);
  }
  if (method === "GET" && path.startsWith("/api/observability/runs/")) {
    const result = await observabilityRunResponse(deps.observability, path);
    return json(res, result.status, result.body);
  }
  if (method === "PUT" && path === "/api/config") {
    return handlePut(req, res, deps);
  }
  return json(res, 404, { error: "not_found" });
}

async function handlePut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const body = await readBody(req);
  let parsed: { patch?: MonoAgentConfigJson; expectedVersion?: string };
  try {
    parsed = JSON.parse(body) as { patch?: MonoAgentConfigJson; expectedVersion?: string };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return json(res, 400, { error: "invalid_json", reason });
  }
  if (parsed.patch === undefined || typeof parsed.patch !== "object" || parsed.patch === null) {
    return json(res, 400, { error: "missing_patch" });
  }
  if (typeof parsed.expectedVersion !== "string") {
    return json(res, 400, { error: "missing_version" });
  }

  // Reject unregistered paths and per-leaf coercion failures BEFORE we touch
  // disk. The bridge only persists keys that map to a registered FieldGroup
  // FieldDefinition; anything else is dropped with a 400 so hosts cannot
  // smuggle arbitrary state into mono-agent.config.json via the UI.
  const validated = validatePatch(parsed.patch, deps.fieldGroups);
  if (!validated.ok) {
    deps.log?.({
      kind: "validation_failed",
      path: deps.configPath,
      reason: summarizeValidationError(validated),
    });
    return json(res, 400, {
      error: "unregistered_fields",
      message: summarizeValidationError(validated),
      unregistered: validated.unregistered,
      invalid: validated.invalid,
    });
  }

  let current;
  try {
    current = await readMonoAgentConfigJson(deps.configPath);
  } catch (error) {
    return json(res, 500, errorBody(error));
  }
  if (current.version !== parsed.expectedVersion) {
    return json(res, 409, {
      error: "stale",
      currentVersion: current.version,
    });
  }

  try {
    const result = await writeMonoAgentConfigJson({
      path: deps.configPath,
      patch: validated.patch,
    });
    deps.log?.({ kind: "write", path: deps.configPath, version: result.version });
    return json(res, 200, { ok: true, version: result.version });
  } catch (error) {
    if (error instanceof MonoAgentConfigError) {
      deps.log?.({
        kind: "validation_failed",
        path: deps.configPath,
        reason: error.message,
      });
      return json(res, 400, { error: error.code, message: error.message, details: error.details });
    }
    return json(res, 500, errorBody(error));
  }
}

async function serveStatic(
  res: ServerResponse,
  url: string,
  deps: HandlerDeps,
): Promise<void> {
  const path = pathOf(url);
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/u, "");
  // Defense-in-depth: refuse paths that would escape the static dir.
  if (rel.includes("..")) {
    return json(res, 403, { error: "forbidden" });
  }
  const resolved = normalize(join(deps.staticDir, rel));
  const safeRoot = normalize(deps.staticDir + sep);
  if (!resolved.startsWith(safeRoot) && resolved !== normalize(deps.staticDir)) {
    return json(res, 403, { error: "forbidden" });
  }

  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) {
      return sendFallbackShell(res, deps);
    }
  } catch {
    if (path === "/" || path === "/index.html") {
      return sendFallbackShell(res, deps);
    }
    // SPA fallback: return shell for unknown routes so deep links work.
    return sendFallbackShell(res, deps);
  }

  const ext = extname(resolved).toLowerCase();
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";

  if (ext === ".html") {
    const html = await readFile(resolved, "utf8");
    return sendHtml(res, injectRuntime(html, deps));
  }

  const contents = await readFile(resolved);
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  if (ext !== ".html") {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  res.end(contents);
}

function sendFallbackShell(res: ServerResponse, deps: HandlerDeps): void {
  // Used when the SPA bundle isn't on disk (e.g. before `vite build` in tests).
  const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Mono Agent — Config</title>
  </head>
  <body>
    <div id="root">Config bridge is running. SPA bundle not built.</div>
  </body>
</html>`;
  sendHtml(res, injectRuntime(shell, deps));
}

function injectRuntime(html: string, deps: HandlerDeps): string {
  const runtime = {
    baseUrl: "",
    token: deps.token,
    fieldGroupIds: deps.fieldGroups.map((g) => g.id),
  };
  const tag = `<script>window.__CONFIG_UI__ = ${JSON.stringify(runtime)};</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${tag}</head>`);
  }
  return `${tag}${html}`;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function pathOf(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorBody(error: unknown): { error: string; reason?: string } {
  const reason = error instanceof Error ? error.message : String(error);
  return { error: "internal_error", reason };
}

function summarizeValidationError(
  result: { unregistered: readonly string[]; invalid: readonly { path: string; reason: string }[] },
): string {
  const parts: string[] = [];
  if (result.unregistered.length > 0) {
    parts.push(`Unregistered fields rejected: ${result.unregistered.join(", ")}.`);
  }
  for (const entry of result.invalid) {
    parts.push(entry.reason);
  }
  return parts.join(" ");
}

export const __test = { MIME_TYPES, CONFIG_UI_STATIC_DIR_FOR_TESTS: resolve(CONFIG_UI_STATIC_DIR) };

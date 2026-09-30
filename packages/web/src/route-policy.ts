import type { NextFunction, Request, Response } from "express";

import { WebConsoleError } from "./errors.js";
import { MCP_APP_PROXY_PATH } from "./mcp-app-proxy.js";
import type { WebService } from "./service.js";

export interface WebRouteRule {
  readonly family: string;
  readonly sourceId?: string;
  readonly threadId?: string;
  readonly definition?: { readonly kind: "project" | "tag"; readonly id: string };
  readonly uploadId?: string;
  readonly cronResultsJobId?: string;
  readonly ownerOnly?: boolean;
  readonly administrator?: boolean;
  readonly bodySource?: boolean;
  readonly threadPatch?: boolean;
}

function missing(): never { throw new WebConsoleError("not_found", "Not found.", 404); }

/** Closed allowlist of browser route/method shapes. IDs remain single decoded segments. */
export function classifyWebRoute(method: string, pathname: string): WebRouteRule {
  let parts: string[];
  try { parts = pathname.split("/").slice(1).map(decodeURIComponent); } catch { return missing(); }
  if (parts[0] !== "api" || parts[1] !== "v1") return missing();
  const [family, id, action, detail, subaction, item, leaf, operation] = parts.slice(2);
  const count = parts.length - 2;
  const get = method === "GET" || method === "HEAD";
  if (pathname === MCP_APP_PROXY_PATH && get) return { family: "mcp-app-proxy" };
  if (family === "bootstrap" && count === 1 && get) return { family: "bootstrap" };
  if (family === "events" && count === 1 && get) return { family: "events" };
  if (family === "push") throw new WebConsoleError("push_disabled", "Push is disabled in multi-user mode.", 404);
  if (family === "agents" && id !== undefined) {
    const base = { family: "agents", sourceId: id };
    if (count === 2 && method === "PATCH") return { ...base, administrator: true };
    if (count === 3 && action === "run-defaults" && ["PUT", "DELETE"].includes(method)) return { ...base, administrator: true };
    if (count === 3 && (action === "models" || action === "skills") && get) return base;
    if (action === "restart" && ((count === 3 && (get || method === "POST")) || (count === 4 && get))) return { ...base, administrator: true };
    if (action === "provider-usage" && ((count === 3 && get) || (count === 4 && detail === "refresh" && method === "POST"))) return { ...base, administrator: true };
    if (action === "provider-auth") {
      const allowed = (count === 3 && get)
        || (count === 4 && ["sessions", "checks"].includes(detail!) && method === "POST")
        || (count === 5 && ["sessions", "checks"].includes(detail!) && (get || method === "DELETE"))
        || (count === 6 && detail === "sessions" && item === "input" && method === "POST");
      if (allowed) return { ...base, administrator: true };
    }
    if (action === "cron") {
      if ((count === 3 && get) || (count === 4 && detail === "config-view" && get)) return { ...base, family: "cron-controls" };
      if (detail === "jobs" && subaction !== undefined) {
        if (count === 6 && ["run", "effective-enabled"].includes(item!) && method === "POST") return { ...base, family: "cron-controls" };
        if (item === "runs" && ((count === 6 && get) || (count === 7 && get)
          || (count === 8 && operation === "reply-threads" && method === "POST"))) {
          return { ...base, family: "cron-results", cronResultsJobId: subaction };
        }
      }
    }
    return missing();
  }
  if (family === "threads") {
    if (count === 1 && get) return { family: "threads-list" };
    if (count === 1 && method === "POST") return { family: "thread-create", bodySource: true };
    if (count === 2 && id === "search" && get) return { family: "threads-search" };
    if (count === 2 && id === "active" && get) return { family: "threads-active" };
    if (id === undefined || id === "search" || id === "active") return missing();
    const base = { family: "thread", threadId: id };
    if (count === 2 && get) return base;
    if (count === 2 && method === "PATCH") return { ...base, threadPatch: true };
    if (count === 2 && method === "DELETE") return { ...base, ownerOnly: true };
    if (count === 3 && ["usage", "messages"].includes(action!) && get) return base;
    if (count === 3 && ["turns", "submissions", "live-input", "cancel", "compact"].includes(action!) && method === "POST") return base;
    if (action === "wake-schedule" && count === 3 && (get || ["POST", "PUT", "PATCH", "DELETE"].includes(method))) return base;
    if (action === "ask" && ((count === 3 && (get || method === "POST")) || (count === 4 && get))) return base;
    if (count === 4 && ["submissions", "jobs"].includes(action!) && get) return base;
    if (action === "messages" && detail !== undefined) {
      if (count === 4 && get) return base;
      if (count === 6 && subaction === "tool-calls" && get) return base;
      if (count === 7 && subaction === "parts" && leaf === "restart" && method === "POST") return { ...base, administrator: true };
      if (count === 7 && subaction === "reply-attachments" && ((leaf === "access" && method === "POST") || (leaf === "content" && get))) return base;
      if (subaction === "mcp-apps" && ((count === 6 && get) || (count === 7 && ["access", "requests"].includes(leaf!) && method === "POST"))) return base;
    }
    return missing();
  }
  if (family === "projects" || family === "tags") {
    if (count === 1 && get) return { family: `${family}-list` };
    if (count === 1 && method === "POST") return { family: `${family}-create`, bodySource: true };
    if (count === 2 && id !== undefined && ["PATCH", "DELETE"].includes(method)) return {
      family, definition: { kind: family === "projects" ? "project" : "tag", id },
    };
  }
  if (family === "uploads") {
    if (count === 1 && method === "POST") return { family: "uploads-create" };
    if (id !== undefined && ((count === 2 && method === "DELETE") || (count === 3 && action === "content" && (get || method === "PUT")))) return { family, uploadId: id };
  }
  return missing();
}

/** Before body parsing: authorize canonical path resources and administrator surfaces. */
export function authorizeWebRoute(service: WebService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (service.store.access.current() === undefined) { next(); return; }
    try {
      const path = req.originalUrl.split("?")[0]!;
      const rule = classifyWebRoute(req.method, path);
      res.locals.webRouteRule = rule;
      res.locals.webMultiUser = true;
      if (rule.sourceId !== undefined && service.store.getAgent(rule.sourceId) === undefined) missing();
      if (rule.threadId !== undefined) {
        const thread = service.store.getThread(rule.threadId);
        if (thread === undefined) missing();
        if (rule.ownerOnly) service.store.requireThreadCreator(thread.id);
      }
      if (rule.definition !== undefined) {
        const found = rule.definition.kind === "project" ? service.store.getProject(rule.definition.id) : service.store.getTag(rule.definition.id);
        if (found === undefined) missing();
      }
      if (rule.uploadId !== undefined && service.store.getStoredAttachment(rule.uploadId) === undefined) missing();
      if (rule.cronResultsJobId !== undefined && service.store.cronThread(rule.sourceId!, rule.cronResultsJobId) === undefined) missing();
      if (rule.administrator) service.store.access.requireAdmin();
      const requested = req.query.sourceId;
      if (["bootstrap", "threads-list", "threads-search", "projects-list", "tags-list"].includes(rule.family)
        && typeof requested === "string" && requested !== "" && service.store.getAgent(requested) === undefined) missing();
      if (rule.family === "events" && typeof req.query.thread === "string" && service.store.getThread(req.query.thread) === undefined) missing();
      next();
    } catch (error) { next(error); }
  };
}

/** After JSON parsing but before handlers' resource/payload validators. */
export function authorizeWebPayload(service: WebService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (service.store.access.current() === undefined) { next(); return; }
    try {
      const rule = res.locals.webRouteRule as WebRouteRule;
      const body = req.body as Record<string, unknown> | undefined;
      if (rule.bodySource && body !== undefined && typeof body.sourceId === "string" && service.store.getAgent(body.sourceId) === undefined) missing();
      if (rule.threadPatch && rule.threadId !== undefined && body !== undefined) {
        const thread = service.store.getThread(rule.threadId)!;
        if (body.shared !== undefined) service.store.requireThreadCreator(thread.id);
        if (typeof body.projectId === "string" && service.store.getProject(body.projectId)?.sourceId !== thread.sourceId) missing();
        if (Array.isArray(body.tagIds) && body.tagIds.some((id) => typeof id === "string" && service.store.getTag(id)?.sourceId !== thread.sourceId)) missing();
      }
      next();
    } catch (error) { next(error); }
  };
}

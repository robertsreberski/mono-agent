import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { parseCredentialSaveRequest, parseCredentialRequest, parseCredentialSnapshot, parseCredentialSaved } from "@mono-agent/channel-operator/client";
import type { WebService } from "./service.js";
import { WebConsoleError } from "./errors.js";

/** Must mount before the global JSON parser. All errors terminate here without raw logging. */
export function registerCredentialRoutes(app: Express, service: WebService, active: Set<Promise<unknown>>, exactRequestOrigin: (req: Request) => unknown): void {
  const path = "/api/v1/agents/:id/credentials";
  const error = (res: Response, code: string, status: number) => res.status(status).json({ error: { code, message: "Credential operation could not be completed. Refresh status; never automatically replay an unconfirmed save." } });
  app.use(path, (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (Object.keys(req.query).length || typeof req.params.id !== "string" || req.params.id.length === 0 || req.params.id.length > 512) { error(res, "credential_invalid", 400); return; }
    next();
  });
  const handle = (operation: "read" | "save" | "retry") => (req: Request, res: Response): void => {
    let input;
    try { input = operation === "read" ? undefined : operation === "save" ? parseCredentialSaveRequest(req.body) : parseCredentialRequest(req.body); }
    catch { req.body = undefined; error(res, "credential_invalid", 400); return; }
    req.body = undefined;
    const work = service.credentials(req.params.id as string, operation, input);
    active.add(work);
    void work.then((result) => res.json(operation === "read" ? parseCredentialSnapshot(result) : parseCredentialSaved(result))).catch((cause: unknown) => {
      const known = cause instanceof WebConsoleError && ["credential_invalid", "credential_conflict", "credential_unavailable", "credential_outcome_unknown", "agent_not_found"].includes(cause.code);
      error(res, known ? cause.code : "credential_outcome_unknown", known ? cause.status : 502);
    }).finally(() => active.delete(work));
  };
  const parserError = (cause: unknown, req: Request, res: Response, _next: NextFunction) => {
    req.body = undefined;
    error(res, "credential_invalid", (cause as { status?: number })?.status === 413 ? 413 : 400);
  };
  const encoding = (req: Request, res: Response, next: NextFunction) => {
    if (!req.is("application/json") || (req.headers["content-encoding"] !== undefined && req.headers["content-encoding"] !== "identity")) { error(res, "credential_invalid", 415); return; }
    next();
  };
  const parser = express.json({ limit: "16kb", strict: true, inflate: false });
  app.get("/api/v1/agents/:id/credentials", (req, res) => {
    try { exactRequestOrigin(req); handle("read")(req, res); } catch { error(res, "credential_invalid", 403); }
  });
  app.post("/api/v1/agents/:id/credentials/save", (req: Request, res: Response, next: NextFunction) => {
    try { exactRequestOrigin(req); next(); } catch { error(res, "credential_invalid", 403); }
  }, encoding, parser, handle("save"), parserError);
  app.post("/api/v1/agents/:id/credentials/retry", (req: Request, res: Response, next: NextFunction) => {
    try { exactRequestOrigin(req); next(); } catch { error(res, "credential_invalid", 403); }
  }, encoding, parser, handle("retry"), parserError);
  app.use(path, (_req, res) => { error(res, "credential_invalid", 404); });
}

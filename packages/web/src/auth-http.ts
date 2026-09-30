import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { WEB_SESSION_COOKIE, WEB_SESSION_TTL_MS, type CreateWebUserInput, type PatchWebUserInput, type WebPrincipal } from "./auth.js";
import { WebConsoleError } from "./errors.js";
import type { WebStore } from "./store.js";

export interface WebAuthHttpOptions {
  readonly enabled: boolean;
  /** Explicit deployment origin for an HTTPS terminator. Never infer it from forwarded headers. */
  readonly publicOrigin?: string;
}

export function validateWebPublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new WebConsoleError("invalid_public_origin", "Invalid web public origin.", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new WebConsoleError("invalid_public_origin", "Web public origin must be an exact HTTP(S) origin.", 400);
  }
  return url.origin;
}

function requestOrigin(req: Request, configured: string | undefined): string {
  const host = req.headers.host;
  if (host === undefined) throw new WebConsoleError("invalid_host", "Host is required.", 400);
  const protocol = "encrypted" in req.socket && req.socket.encrypted === true ? "https" : "http";
  const actual = new URL(`${protocol}://${host}`).origin;
  if (configured !== undefined && new URL(configured).host.toLowerCase() !== new URL(actual).host.toLowerCase()) {
    throw new WebConsoleError("origin_mismatch", "This is not the configured console origin.", 403);
  }
  return configured ?? actual;
}

function requireOrigin(req: Request, configured: string | undefined): void {
  const origin = req.headers.origin;
  if (origin === undefined || origin !== requestOrigin(req, configured) || req.headers["sec-fetch-site"] === "cross-site") {
    throw new WebConsoleError("origin_mismatch", "An exact same-origin request is required.", 403);
  }
}

export function webRequestSession(req: Request, store: WebStore): WebPrincipal | undefined {
  const cookie = req.headers.cookie;
  if (cookie === undefined || cookie.length > 8192) return undefined;
  const values = cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${WEB_SESSION_COOKIE}=`));
  // Duplicate cookies must not ambiguously select an identity.
  if (values.length !== 1) return undefined;
  return store.auth.authenticate(values[0]!.slice(WEB_SESSION_COOKIE.length + 1));
}

function authorizeSessionWrite(req: Request, store: WebStore, administrator = false): void {
  const principal = webRequestSession(req, store);
  if (principal === undefined) throw new WebConsoleError("authentication_required", "Log in to continue.", 401);
  if (administrator && principal.role !== "admin") throw new WebConsoleError("forbidden", "Administrator access is required.", 403);
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new WebConsoleError("invalid_auth_input", "Invalid account request.", 400);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new WebConsoleError("invalid_auth_input", "A string value is required.", 400);
  return value;
}
function cookie(res: Response, req: Request, token: string | undefined, publicOrigin: string | undefined): void {
  const secure = requestOrigin(req, publicOrigin).startsWith("https:");
  res.setHeader("Set-Cookie", `${WEB_SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token === undefined ? 0 : WEB_SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`);
}

/** Mount after the existing host boundary, but before private body parsers/handlers. */
export function installWebAuthentication(app: Express, store: WebStore, options: WebAuthHttpOptions): void {
  const publicOrigin = validateWebPublicOrigin(options.publicOrigin);
  const statusPath = "/api/v1/auth/status";
  const loginPath = "/api/v1/auth/login";
  app.use("/api", (req, res, next) => {
    if (!options.enabled) { next(); return; }
    // Byte and SSE handlers also set cache headers; retain the authenticated
    // mode across those later helpers instead of reverting to legacy caching.
    res.locals.webMultiUser = true;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if ((req.originalUrl.split("?")[0] === statusPath && req.method === "GET")
      || (req.originalUrl.split("?")[0] === loginPath && req.method === "POST")) { next(); return; }
    try {
      const principal = webRequestSession(req, store);
      if (principal === undefined) throw new WebConsoleError("authentication_required", "Log in to continue.", 401);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) requireOrigin(req, publicOrigin);
      store.access.run(principal, next);
    } catch (error) { next(error); }
  });
  app.get(statusPath, (req, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const principal = options.enabled ? webRequestSession(req, store) : undefined;
    res.json({ multiUser: options.enabled, user: principal === undefined ? null : store.auth.getUser(principal.id) });
  });
  if (!options.enabled) return;

  const json = express.json({ limit: "8kb", strict: true });
  const admin = (_req: Request, _res: Response, next: NextFunction) => {
    try { store.access.requireAdmin(); next(); } catch (error) { next(error); }
  };
  const sameOrigin = (req: Request, _res: Response, next: NextFunction) => {
    try { requireOrigin(req, publicOrigin); next(); } catch (error) { next(error); }
  };
  app.post(loginPath, sameOrigin, json, (req, res, next) => {
    try {
      const body = record(req.body, ["username", "password"]);
      // Never use caller-controlled forwarded addresses for throttling.
      void store.auth.login(text(body.username), text(body.password), req.socket.remoteAddress ?? "unknown")
        .then(({ token, principal }) => { cookie(res, req, token, publicOrigin); res.json({ user: store.auth.getUser(principal.id) }); }).catch(next);
    } catch (error) { next(error); }
  });
  app.post("/api/v1/auth/logout", (req, res, next) => {
    try {
      const principal = webRequestSession(req, store)!;
      store.auth.revokeSession(principal.sessionHash);
      cookie(res, req, undefined, publicOrigin);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.get("/api/v1/profile", (_req, res) => res.json({ user: store.auth.getUser(store.access.requirePrincipal().id) }));
  app.patch("/api/v1/profile", json, (req, res, next) => {
    try {
      const body = record(req.body, ["displayName"]);
      const user = store.auth.patchUser(store.access.requirePrincipal().id, { displayName: text(body.displayName) });
      cookie(res, req, undefined, publicOrigin);
      res.json({ user, reauthenticate: true });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/profile/password", json, (req, res, next) => {
    try {
      const body = record(req.body, ["currentPassword", "password"]);
      void store.auth.changePassword(store.access.requirePrincipal().id, text(body.currentPassword), text(body.password), () => authorizeSessionWrite(req, store))
        .then(() => { cookie(res, req, undefined, publicOrigin); res.status(204).end(); }).catch(next);
    } catch (error) { next(error); }
  });
  app.get("/api/v1/users", admin, (_req, res) => res.json({ users: store.auth.listUsers() }));
  app.post("/api/v1/users", admin, json, (req, res, next) => {
    try {
      const body = record(req.body, ["username", "displayName", "password", "role", "grants"]);
      // The auth store validates every field and projects out password records.
      void store.auth.createUser(body as unknown as CreateWebUserInput, () => authorizeSessionWrite(req, store, true)).then((user) => res.status(201).json({ user })).catch(next);
    } catch (error) { next(error); }
  });
  app.patch("/api/v1/users/:id", admin, json, (req, res, next) => {
    try {
      const body = record(req.body, ["displayName", "role", "disabled", "grants"]);
      res.json({ user: store.auth.patchUser(text(req.params.id), body as PatchWebUserInput) });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/users/:id/password", admin, json, (req, res, next) => {
    try {
      const body = record(req.body, ["password"]);
      void store.auth.resetPassword(text(req.params.id), text(body.password), () => authorizeSessionWrite(req, store, true)).then(() => res.status(204).end()).catch(next);
    } catch (error) { next(error); }
  });
}

import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installWebAuthentication, validateWebPublicOrigin } from "../auth-http.js";
import { WebConsoleError } from "../errors.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const PASSWORD = "fictional-http-password";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function fixture(options: { enabled?: boolean; publicOrigin?: (host: string) => string } = {}) {
  const root = await temporaryRoot("web-auth-http-");
  const store = await WebStore.open({ stateDir: join(root, "state") });
  const admin = await store.auth.bootstrap("Morgan", PASSWORD);
  const user = await store.auth.createUser({ username: "Avery", password: PASSWORD, role: "user", grants: ["one"] });
  const app = express();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No bound test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const publicOrigin = options.publicOrigin?.(new URL(origin).host);
  installWebAuthentication(app, store, { enabled: options.enabled ?? true, ...(publicOrigin === undefined ? {} : { publicOrigin }) });
  // Parsing here deliberately follows the authentication boundary.
  app.use(express.json({ limit: "8kb" }));
  app.get("/api/v1/private", async (_req, res) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    res.json({ principal: store.access.current()?.id ?? null });
  });
  app.post("/api/v1/private", (_req, res) => res.json({ principal: store.access.current()?.id ?? null }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof WebConsoleError ? error.status : 400).json({ error: error instanceof WebConsoleError ? error.code : "invalid_json" });
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close(); await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, init);
  const mutate = (path: string, body: unknown, cookie?: string, method = "POST") => request(path, {
    method, headers: { Origin: publicOrigin ?? origin, "Content-Type": "application/json", ...(cookie === undefined ? {} : { Cookie: cookie }) }, body: JSON.stringify(body),
  });
  const login = async (username: string) => {
    const response = await mutate("/api/v1/auth/login", { username, password: PASSWORD });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { store, admin, user, request, mutate, login, origin };
}

describe("web HTTP authentication boundary", () => {
  it("provides minimal public status but authenticates before protected body validators", async () => {
    const { request } = await fixture();
    const status = await request("/api/v1/auth/status");
    expect(await status.json()).toEqual({ multiUser: true, user: null });
    expect(status.headers.get("cache-control")).toContain("no-store");
    expect((await request("/api/v1/private")).status).toBe(401);
    const malformed = await request("/api/v1/private", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({ error: "authentication_required" });
    expect((await request("/api/v1/unknown")).status).toBe(401);
  });

  it("sets HttpOnly SameSite cookies, isolates async principals and rejects duplicate cookies", async () => {
    const { request, mutate, login, admin, user } = await fixture();
    const response = await mutate("/api/v1/auth/login", { username: "Morgan", password: PASSWORD });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/u);
    expect(setCookie).not.toContain("Secure");
    const adminCookie = setCookie.split(";")[0]!, userCookie = await login("avery");
    const [left, right] = await Promise.all([adminCookie, userCookie].map(async (Cookie) => {
      const read = await request("/api/v1/private", { headers: { Cookie } });
      expect(read.headers.get("cache-control")).toContain("no-store");
      return read.json();
    }));
    expect(left).toEqual({ principal: admin.id });
    expect(right).toEqual({ principal: user.id });
    expect((await request("/api/v1/private", { headers: { Cookie: `${adminCookie}; ${userCookie}` } })).status).toBe(401);
    const status = await request("/api/v1/auth/status", { headers: { Cookie: userCookie } });
    const body = await status.json() as { user: { id: string } };
    expect(body.user.id).toBe(user.id);
    expect(JSON.stringify(body)).not.toMatch(/password|sessionHash|expiresAt/u);
  });

  it("requires the exact origin including scheme for login and cookie mutations", async () => {
    const { request, login, origin } = await fixture();
    const credentials = JSON.stringify({ username: "Morgan", password: PASSWORD });
    for (const Origin of [undefined, "http://unrelated.invalid", origin.replace("http:", "https:"), `${origin}/path`]) {
      const response = await request("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", ...(Origin === undefined ? {} : { Origin }) }, body: credentials });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const Cookie = await login("avery");
    expect((await request("/api/v1/private", { method: "POST", headers: { Cookie, "x-mono-agent-web-origin": origin } })).status).toBe(403);
    expect((await request("/api/v1/private", { method: "POST", headers: { Cookie, Origin: origin, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("does not trust forwarded protocol and supports an explicitly configured HTTPS origin", async () => {
    const plain = await fixture();
    const bogus = await plain.request("/api/v1/auth/login", { method: "POST", headers: {
      Origin: plain.origin.replace("http:", "https:"), "X-Forwarded-Proto": "https", "Content-Type": "application/json",
    }, body: JSON.stringify({ username: "Morgan", password: PASSWORD }) });
    expect(bogus.status).toBe(403);
    const secure = await fixture({ publicOrigin: (host) => `https://${host}` });
    const response = await secure.mutate("/api/v1/auth/login", { username: "Morgan", password: PASSWORD });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("; Secure");
    for (const value of ["ftp://localhost", "https://user:pass@localhost", "https://localhost/path", "https://localhost?query", "invalid"]) {
      expect(() => validateWebPublicOrigin(value)).toThrow();
    }
  });

  it("forbids regular-user administration before parsing bodies and preserves last-active-admin", async () => {
    const { login, request, mutate, admin, origin } = await fixture();
    const Cookie = await login("avery");
    expect((await request("/api/v1/users", { headers: { Cookie } })).status).toBe(403);
    const malformed = await request("/api/v1/users", { method: "POST", headers: { Cookie, Origin: origin, "Content-Type": "application/json" }, body: "{bad" });
    expect(malformed.status).toBe(403);
    const adminCookie = await login("morgan");
    const users = await request("/api/v1/users", { headers: { Cookie: adminCookie } });
    expect((await users.json() as { users: unknown[] }).users).toHaveLength(2);
    expect((await mutate(`/api/v1/users/${admin.id}`, { role: "user" }, adminCookie, "PATCH")).status).toBe(409);
    const created = await mutate("/api/v1/users", { username: "Riley", password: PASSWORD, role: "user", grants: ["two"] }, adminCookie);
    expect(created.status).toBe(201);
    expect((await created.json() as { user: unknown }).user).toMatchObject({ username: "riley", grants: ["two"] });
    expect((await mutate("/api/v1/users", { username: "Bad", password: PASSWORD, role: "owner" }, adminCookie)).status).toBe(400);
  });

  it("allows only own profile fields and revokes sessions after profile/password/logout/grant changes", async () => {
    const { login, request, mutate, user } = await fixture();
    let Cookie = await login("avery");
    expect((await request("/api/v1/profile", { headers: { Cookie } })).status).toBe(200);
    expect((await mutate("/api/v1/profile", { role: "admin" }, Cookie, "PATCH")).status).toBe(400);
    expect((await mutate("/api/v1/profile", { displayName: "Avery Example" }, Cookie, "PATCH")).status).toBe(200);
    expect((await request("/api/v1/private", { headers: { Cookie } })).status).toBe(401);
    Cookie = await login("avery");
    expect((await mutate("/api/v1/profile/password", { currentPassword: "incorrect-password", password: "changed-fictional-password" }, Cookie)).status).toBe(403);
    expect((await mutate("/api/v1/profile/password", { currentPassword: PASSWORD, password: "changed-fictional-password" }, Cookie)).status).toBe(204);
    expect((await request("/api/v1/private", { headers: { Cookie } })).status).toBe(401);
    const fresh = await mutate("/api/v1/auth/login", { username: "avery", password: "changed-fictional-password" });
    Cookie = fresh.headers.get("set-cookie")!.split(";")[0]!;
    const adminCookie = await login("morgan");
    expect((await mutate(`/api/v1/users/${user.id}`, { grants: [] }, adminCookie, "PATCH")).status).toBe(200);
    expect((await request("/api/v1/private", { headers: { Cookie } })).status).toBe(401);
    const logout = await mutate("/api/v1/auth/logout", {}, adminCookie);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await request("/api/v1/private", { headers: { Cookie: adminCookie } })).status).toBe(401);
  });

  it("uses generic login failures and throttles one remote even with rotating forwarded addresses", async () => {
    const { request, mutate, origin, store, user } = await fixture();
    store.auth.patchUser(user.id, { disabled: true });
    for (let index = 0; index < 5; index++) {
      const response = await request("/api/v1/auth/login", { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${index + 1}`,
      }, body: JSON.stringify({ username: index === 0 ? "avery" : `unknown-${index}`, password: PASSWORD }) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "login_failed" });
    }
    expect((await mutate("/api/v1/auth/login", { username: "morgan", password: PASSWORD })).status).toBe(429);
  });

  it("revokes existing HTTP sessions on administrative password reset or disable", async () => {
    const { login, request, mutate, user } = await fixture();
    const Cookie = await login("avery"), adminCookie = await login("morgan");
    expect((await mutate(`/api/v1/users/${user.id}/password`, { password: "reset-fictional-password" }, adminCookie)).status).toBe(204);
    expect((await request("/api/v1/private", { headers: { Cookie } })).status).toBe(401);
    const renewed = await mutate("/api/v1/auth/login", { username: "avery", password: "reset-fictional-password" });
    const renewedCookie = renewed.headers.get("set-cookie")!.split(";")[0]!;
    expect((await mutate(`/api/v1/users/${user.id}`, { disabled: true }, adminCookie, "PATCH")).status).toBe(200);
    expect((await request("/api/v1/private", { headers: { Cookie: renewedCookie } })).status).toBe(401);
    expect(await (await request("/api/v1/auth/status", { headers: { Cookie: renewedCookie } })).json()).toEqual({ multiUser: true, user: null });
  });

  it("rechecks the initiating session before asynchronous administrative writes commit", async () => {
    const { login, mutate, store, admin } = await fixture();
    const Cookie = await login("morgan");
    const create = store.auth.createUser.bind(store.auth);
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(store.auth, "createUser").mockImplementationOnce(async (input, authorize) => {
      entered(); await gate; return create(input, authorize);
    });
    try {
      const pending = mutate("/api/v1/users", { username: "Riley", password: PASSWORD, role: "user" }, Cookie);
      await entry;
      store.auth.revokeUserSessions(admin.id);
      release();
      expect((await pending).status).toBe(401);
      expect(store.auth.listUsers().map((user) => user.username)).not.toContain("riley");
    } finally { release(); spy.mockRestore(); }
  });

  it("keeps mode-off requests cookie-free and does not mount account mutation APIs", async () => {
    const { request } = await fixture({ enabled: false });
    expect(await (await request("/api/v1/auth/status")).json()).toEqual({ multiUser: false, user: null });
    expect(await (await request("/api/v1/private")).json()).toEqual({ principal: null });
    expect((await request("/api/v1/auth/login", { method: "POST" })).status).toBe(404);
  });
});

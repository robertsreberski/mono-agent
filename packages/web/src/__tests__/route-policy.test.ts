import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { installWebAuthentication } from "../auth-http.js";
import { WebConsoleError } from "../errors.js";
import { MCP_APP_PROXY_PATH } from "../mcp-app-proxy.js";
import { authorizeWebPayload, authorizeWebRoute, classifyWebRoute } from "../route-policy.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const PASSWORD = "fictional-policy-password";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function fixture() {
  const root = await temporaryRoot("web-route-policy-");
  const first = fakeDiscoveredAgent();
  const service = await WebService.create({ stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [first, { ...first, source: { ...first.source, sourceId: "agent-two", label: "Agent Two" } }],
    fetchImpl: operatorFetch() });
  const store = service.store;
  const admin = await store.auth.bootstrap("Morgan", PASSWORD);
  const a = await store.auth.createUser({ username: "Avery", password: PASSWORD, role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password: PASSWORD, role: "user", grants: ["agent-one", "agent-two"] });
  store.auth.initializeOwnership();
  const own = store.access.run(a, () => service.createThread("agent-one"));
  const other = store.access.run(b, () => service.createThread("agent-one"));
  const deniedAgent = store.access.run(b, () => service.createThread("agent-two"));
  store.access.run(b, () => service.patchThread(other.id, { shared: true }));
  const project = store.createProject({ sourceId: "agent-one", name: "Shared definition" });
  const deniedProject = store.createProject({ sourceId: "agent-two", name: "Other definition" });
  const deniedTag = store.createTag({ sourceId: "agent-two", name: "Other tag" });
  const upload = store.access.run(b, () => service.createUpload({ name: "fictional.txt", contentType: "text/plain", sizeBytes: 1 }));
  store.syncCronOverview({ sourceId: "agent-one", generatedAt: "2026-01-01T00:00:00.000Z", actionsEnabled: true,
    jobs: [{ jobId: "digest", conversationId: "cron:digest", configured: true, declaredEnabled: true, effectiveEnabled: true, health: "healthy" }] });
  const app = express();
  installWebAuthentication(app, store, { enabled: true });
  app.use("/api", authorizeWebRoute(service));
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", authorizeWebPayload(service));
  let admitted = 0;
  // A narrow HTTP middleware harness, not the final production route suite.
  app.use((_req, res) => { admitted += 1; res.json({ family: res.locals.webRouteRule.family }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof WebConsoleError ? error.status : 400).json({ error: error instanceof WebConsoleError ? error.code : "invalid_json" });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test listener");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.stop(); await rm(root, { recursive: true, force: true }); });
  const cookies = new Map<string, string>();
  for (const user of [admin, a, b]) {
    const { token } = await store.auth.login(user.username, PASSWORD, user.id);
    cookies.set(user.id, `mono_web_session=${token}`);
  }
  const request = (path: string, userId?: string, method = "GET", body?: unknown, malformed = false) => fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, ...(userId === undefined ? {} : { Cookie: cookies.get(userId)! }),
      ...(body === undefined && !malformed ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined && !malformed ? {} : { body: malformed ? "{malformed" : JSON.stringify(body) }),
  });
  return { service, store, admin, a, b, own, other, deniedAgent, project, deniedProject, deniedTag, upload, request, admitted: () => admitted };
}

describe("closed browser route policy", () => {
  it("classifies every literal browser API route currently registered by the server", async () => {
    const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const routes = [...source.matchAll(/app\.(get|post|patch|put|delete)\(\s*"([^"]+)"/gu)]
      .filter((match) => match[2]!.startsWith("/api/"));
    expect(routes.length).toBeGreaterThan(50);
    expect(source).toContain("app.get(MCP_APP_PROXY_PATH");
    expect(classifyWebRoute("GET", MCP_APP_PROXY_PATH)).toEqual({ family: "mcp-app-proxy" });
    for (const route of routes) {
      const path = route[2]!.replace(/:[A-Za-z]+/gu, "resource");
      if (path.startsWith("/api/v1/push/")) expect(() => classifyWebRoute(route[1]!.toUpperCase(), path)).toThrow("Push is disabled");
      else expect(() => classifyWebRoute(route[1]!.toUpperCase(), path), path).not.toThrow();
    }
    for (const path of ["/api/v2/bootstrap", "/api/v1/agents/resource/new-admin-action", "/api/v1/threads/resource/unknown", "/api/v1/threads/%E0%A4%A"]) {
      expect(() => classifyWebRoute("GET", path)).toThrow();
    }
  });

  it("requires authentication for every protected family", async () => {
    const f = await fixture();
    const paths = ["/api/v1/bootstrap", "/api/v1/threads", "/api/v1/threads/search", "/api/v1/threads/active",
      `/api/v1/threads/${f.own.id}/messages`, "/api/v1/agents/agent-one/models", "/api/v1/agents/agent-one/provider-auth",
      "/api/v1/agents/agent-one/cron", "/api/v1/projects?sourceId=agent-one", "/api/v1/tags?sourceId=agent-one",
      `/api/v1/uploads/${f.upload.id}/content`, "/api/v1/events", "/api/v1/push/subscriptions/unknown", "/api/v1/unknown"];
    for (const path of paths) expect((await f.request(path)).status, path).toBe(401);
    expect(f.admitted()).toBe(0);
  });

  it("authorizes administrator families before parsing bodies or exposing providers/restart state", async () => {
    const f = await fixture();
    const routes: Array<[string, string]> = [
      ["PATCH", "/api/v1/agents/agent-one"], ["PUT", "/api/v1/agents/agent-one/run-defaults"],
      ["GET", "/api/v1/agents/agent-one/provider-auth"], ["POST", "/api/v1/agents/agent-one/provider-auth/sessions"],
      ["GET", "/api/v1/agents/agent-one/provider-usage"], ["POST", "/api/v1/agents/agent-one/provider-usage/refresh"],
      ["GET", "/api/v1/agents/agent-one/restart"], ["POST", "/api/v1/agents/agent-one/restart"],
      ["POST", `/api/v1/threads/${f.own.id}/messages/message/parts/part/restart`],
    ];
    for (const [method, path] of routes) {
      expect((await f.request(path, f.a.id, method, undefined, method !== "GET")).status, path).toBe(403);
    }
    expect(f.admitted()).toBe(0);
    expect((await f.request("/api/v1/agents/agent-one/provider-auth", f.admin.id)).status).toBe(200);
  });

  it("uses non-enumerating checks for every thread family and denied agents, including admins", async () => {
    const f = await fixture();
    f.store.access.run(f.b, () => f.service.patchThread(f.other.id, { shared: false }));
    const routes: Array<[string, string]> = [
      ["GET", ""], ["PATCH", ""], ["DELETE", ""], ["GET", "/messages"], ["GET", "/usage"], ["GET", "/jobs/job"],
      ["GET", "/ask"], ["POST", "/ask"], ["GET", "/wake-schedule"], ["POST", "/wake-schedule"],
      ["POST", "/turns"], ["POST", "/submissions"], ["GET", "/submissions/submission"], ["POST", "/live-input"],
      ["POST", "/compact"], ["POST", "/cancel"], ["GET", "/messages/message/tool-calls/tool"],
      ["POST", "/messages/message/reply-attachments/part/access"], ["GET", "/messages/message/reply-attachments/part/content"],
      ["POST", "/messages/message/mcp-apps/part/access"], ["GET", "/messages/message/mcp-apps/part"], ["POST", "/messages/message/mcp-apps/part/requests"],
    ];
    for (const principal of [f.a, f.admin]) for (const [method, suffix] of routes) {
      expect((await f.request(`/api/v1/threads/${f.other.id}${suffix}`, principal.id, method, undefined,
        ["POST", "PATCH"].includes(method))).status, `${principal.role} ${suffix}`).toBe(404);
    }
    expect((await f.request("/api/v1/agents/agent-two/provider-auth", f.a.id)).status).toBe(404);
    expect((await f.request(`/api/v1/events?thread=${f.other.id}`, f.a.id)).status).toBe(404);
    expect(f.admitted()).toBe(0);
  });

  it("allows visible participant controls but only the creator may share or delete", async () => {
    const f = await fixture();
    for (const suffix of ["/turns", "/cancel", "/compact", "/ask", "/wake-schedule"]) {
      expect((await f.request(`/api/v1/threads/${f.other.id}${suffix}`, f.a.id, "POST", {})).status, suffix).toBe(200);
    }
    expect((await f.request(`/api/v1/threads/${f.other.id}`, f.a.id, "PATCH", { title: "Shared edit" })).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${f.other.id}`, f.a.id, "PATCH", { shared: true })).status).toBe(403);
    expect((await f.request(`/api/v1/threads/${f.other.id}`, f.a.id, "DELETE")).status).toBe(403);
    expect((await f.request(`/api/v1/threads/${f.other.id}`, f.b.id, "PATCH", { shared: false })).status).toBe(200);
  });

  it("checks source and membership references before payload validators and keeps shared definitions writable", async () => {
    const f = await fixture();
    for (const family of ["threads", "projects", "tags"]) {
      expect((await f.request(`/api/v1/${family}`, f.a.id, "POST", { sourceId: "agent-two", name: 42 })).status).toBe(404);
    }
    for (const path of ["/api/v1/bootstrap?sourceId=agent-two", "/api/v1/threads?sourceId=agent-two&archived=wrong",
      "/api/v1/threads/search?sourceId=agent-two", "/api/v1/projects?sourceId=agent-two", "/api/v1/tags?sourceId=agent-two"]) {
      expect((await f.request(path, f.a.id)).status).toBe(404);
    }
    expect((await f.request(`/api/v1/threads/${f.own.id}`, f.a.id, "PATCH", { projectId: f.deniedProject.id })).status).toBe(404);
    expect((await f.request(`/api/v1/threads/${f.own.id}`, f.a.id, "PATCH", { tagIds: [f.deniedTag.id] })).status).toBe(404);
    expect((await f.request(`/api/v1/projects/${f.project.id}`, f.a.id, "PATCH", { name: "Shared edit" })).status).toBe(200);
    expect((await f.request(`/api/v1/projects/${f.project.id}`, f.a.id, "DELETE")).status).toBe(200);
  });

  it("allows cron controls but protects channel results/replies, upload staging and unknown routes", async () => {
    const f = await fixture();
    for (const [method, path] of [["GET", "/api/v1/agents/agent-one/cron"], ["GET", "/api/v1/agents/agent-one/cron/config-view"],
      ["POST", "/api/v1/agents/agent-one/cron/jobs/digest/run"], ["POST", "/api/v1/agents/agent-one/cron/jobs/digest/effective-enabled"]]) {
      expect((await f.request(path!, f.a.id, method!, method === "POST" ? {} : undefined)).status).toBe(200);
    }
    for (const [method, suffix] of [["GET", ""], ["GET", "/run"], ["POST", "/run/reply-threads"]]) {
      expect((await f.request(`/api/v1/agents/agent-one/cron/jobs/digest/runs${suffix}`, f.a.id, method!, method === "POST" ? {} : undefined)).status).toBe(404);
    }
    expect((await f.request("/api/v1/agents/agent-one/cron/jobs/digest/runs", f.admin.id)).status).toBe(200);
    for (const user of [f.a, f.admin]) {
      expect((await f.request(`/api/v1/uploads/${f.upload.id}/content`, user.id)).status).toBe(404);
      expect((await f.request(`/api/v1/uploads/${f.upload.id}`, user.id, "DELETE")).status).toBe(404);
    }
    expect((await f.request(`/api/v1/uploads/${f.upload.id}/content`, f.b.id)).status).toBe(200);
    expect((await f.request("/api/v1/push/subscriptions/unknown", f.a.id)).status).toBe(404);
    expect((await f.request("/api/v1/new-route", f.admin.id)).status).toBe(404);
    expect((await f.request(`/api/v1/threads/${f.own.id}/unknown`, f.a.id)).status).toBe(404);
  });
});

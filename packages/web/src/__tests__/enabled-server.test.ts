import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWebUser } from "../auth.js";
import { startWebServer, type WebServerHandle } from "../server.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
const password = "fictional-enabled-password";
const cronRun = { projection: "summary", runId: "fictional-private-run", jobId: "digest", sequence: 1, trigger: "scheduled", status: "failed",
  scheduledAt: "2027-01-02T10:00:00.000Z", orderedAt: "2027-01-02T10:00:00.000Z", eventCount: 0, text: "Fictional cron secret", error: "Fictional cron error" };
const cronJob = { jobId: "digest", conversationId: "fictional-cron-channel", configured: true, declaredEnabled: true, effectiveEnabled: true,
  expression: "0 9 * * *", timezone: "UTC", health: "unhealthy", lastRun: cronRun };
const cronOverview = { generatedAt: "2027-01-02T10:00:00.000Z", actionsEnabled: true, jobs: [cronJob] };
async function fixture() {
  const root = await temporaryRoot("web-enabled-server-"); const stateDir = join(root, "state");
  await bootstrapWebUser({ stateDir, username: "Morgan", password });
  const options = { stateDir, port: 0, host: "127.0.0.1", env: {}, multiUser: true, discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent(), { ...fakeDiscoveredAgent(), source: { ...fakeDiscoveredAgent().source, sourceId: "agent-two", label: "Agent Two" } }],
    fetchImpl: operatorFetch({ supportsWebActor: true, supportsWebAutomation: true, cronOverview, cronRuns: { runs: [cronRun] },
      onCronMutation: () => ({ kind: "completed", replayed: false, value: { run: cronRun } }) }) };
  let handle: WebServerHandle = await startWebServer(options);
  let base = `http://127.0.0.1:${handle.port}`;
  const request = (path: string, cookie?: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, { method,
    headers: { origin: base, ...(cookie === undefined ? {} : { cookie }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async (username: string) => {
    const response = await request("/api/v1/auth/login", undefined, "POST", { username, password }); expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  const admin = await login("Morgan");
  const createUser = async (username: string, grants: string[]) => {
    const response = await request("/api/v1/users", admin, "POST", { username, password, role: "user", grants }); expect(response.status).toBe(201);
    return (await response.json() as { user: { id: string } }).user.id;
  };
  const aId = await createUser("Avery", ["agent-one"]); const bId = await createUser("Riley", ["agent-one"]);
  const a = await login("Avery"); const b = await login("Riley");
  const createThread = async (cookie: string, sourceId = "agent-one") => {
    const response = await request("/api/v1/threads", cookie, "POST", { sourceId }); expect(response.status).toBe(201);
    return (await response.json() as { thread: { id: string } }).thread.id;
  };
  cleanup.push(async () => { await handle.stop(); await rm(root, { recursive: true, force: true }); });
  return { request, admin, a, b, aId, bId, createThread, login, restart: async () => { await handle.stop(); handle = await startWebServer(options); base = `http://127.0.0.1:${handle.port}`; } };
}

describe("enabled production HTTP policy", () => {
  it("authenticates every route family before body parsing and denies unknown APIs", async () => {
    const f = await fixture();
    for (const [path, method] of [["/api/v1/bootstrap", "GET"], ["/api/v1/threads", "POST"], ["/api/v1/threads/search?q=sample", "GET"],
      ["/api/v1/threads/active", "GET"], ["/api/v1/events", "GET"], ["/api/v1/projects", "POST"], ["/api/v1/tags", "POST"],
      ["/api/v1/uploads", "POST"], ["/api/v1/users", "GET"], ["/api/v1/agents/agent-one/cron", "GET"], ["/api/v1/agents/agent-one/provider-auth", "GET"]]) {
      expect((await f.request(path!, undefined, method!, method === "POST" ? {} : undefined)).status, path).toBe(401);
    }
    expect((await f.request("/api/v1/unknown", f.a)).status).toBe(404);
    expect((await f.request("/api/v1/mcp-app-proxy")).status).toBe(401);
    expect((await f.request("/api/v1/mcp-app-proxy", f.a)).status).toBe(200);
    expect((await f.request("/api/v1/push/subscriptions/fake", f.admin)).status).toBe(404);
    for (const [path, method] of [["/api/v1/users", "GET"], ["/api/v1/agents/agent-one", "PATCH"], ["/api/v1/agents/agent-one/run-defaults", "PUT"],
      ["/api/v1/agents/agent-one/restart", "POST"], ["/api/v1/agents/agent-one/provider-auth", "GET"], ["/api/v1/agents/agent-one/provider-usage", "GET"]]) {
      expect((await f.request(path!, f.a, method!, method === "GET" ? undefined : {})).status, path).toBe(403);
    }
    expect((await f.request("/api/v1/agents/agent-two/models", f.a)).status).toBe(404);
    expect((await f.request("/api/v1/threads", f.a, "POST", { sourceId: "agent-two" })).status).toBe(404);
  });

  it("keeps private creators private from users and admins, shares complete history and restricts destructive changes", async () => {
    const f = await fixture(); const id = await f.createThread(f.a);
    await f.request(`/api/v1/threads/${id}`, f.a, "PATCH", { title: "Fictional private marker" });
    for (const cookie of [f.b, f.admin]) {
      for (const [tail, method] of [["", "GET"], ["/messages", "GET"], ["/usage", "GET"], ["/ask", "GET"], ["/wake-schedule", "GET"], ["/turns", "POST"], ["/compact", "POST"], ["/jobs/fictional-job", "GET"]]) {
        expect((await f.request(`/api/v1/threads/${id}${tail}`, cookie, method!, method === "POST" ? {} : undefined)).status, tail).toBe(404);
      }
      const bootstrap = await (await f.request("/api/v1/bootstrap", cookie)).text(); expect(bootstrap).not.toContain(id); expect(bootstrap).not.toContain("Fictional private marker");
      const search = await (await f.request("/api/v1/threads/search?q=Fictional", cookie)).text(); expect(search).not.toContain(id);
    }
    expect((await f.request(`/api/v1/threads/${id}`, f.a, "PATCH", { shared: true })).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${id}`, f.b)).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${id}`, f.admin)).status).toBe(200);
    for (const cookie of [f.b, f.admin]) {
      expect((await f.request(`/api/v1/threads/${id}`, cookie, "PATCH", { shared: false })).status).toBe(403);
      expect((await f.request(`/api/v1/threads/${id}`, cookie, "DELETE")).status).toBe(403);
    }
    expect((await f.request(`/api/v1/threads/${id}`, f.b, "PATCH", { title: "Shared fictional marker" })).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${id}`, f.a, "PATCH", { shared: false })).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${id}`, f.b)).status).toBe(404);
  });

  it("exposes granted cron definitions/control acknowledgements without private output", async () => {
    const f = await fixture();
    const overviewResponse = await f.request("/api/v1/agents/agent-one/cron", f.a);
    const overview = await overviewResponse.json() as { jobs: Array<Record<string, unknown>> };
    expect(overviewResponse.status, JSON.stringify(overview)).toBe(200);
    expect(overview.jobs[0]).toMatchObject({ jobId: "digest", resultsPrivate: true });
    expect(JSON.stringify(overview)).not.toContain("Fictional cron secret"); expect(overview.jobs[0]).not.toHaveProperty("threadId");
    expect((await f.request("/api/v1/agents/agent-one/cron/jobs/digest/runs", f.a)).status).toBe(404);
    const control = await f.request("/api/v1/agents/agent-one/cron/jobs/digest/run", f.a, "POST", { idempotencyKey: "fictional-enabled-cron" });
    expect(await control.json()).toMatchObject({ kind: "completed", value: { acknowledged: true, jobId: "digest" } });
    const adminOverview = await (await f.request("/api/v1/agents/agent-one/cron", f.admin)).json() as { jobs: Array<Record<string, unknown>> };
    expect(adminOverview.jobs[0]).toHaveProperty("lastRun");
    const channel = adminOverview.jobs[0]!.threadId as string;
    expect((await f.request(`/api/v1/threads/${channel}`, f.admin, "PATCH", { shared: true })).status).toBe(200);
    expect((await f.request("/api/v1/agents/agent-one/cron/jobs/digest/runs", f.a)).status).toBe(200);
  });

  it("projects real SSE before serialization, tombstones unshare and closes on account revocation", async () => {
    const f = await fixture(); const id = await f.createThread(f.a);
    const response = await f.request("/api/v1/events", f.b);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    const reader = response.body!.getReader(); let content = ""; let closed = false;
    const pumping = (async () => { for (;;) { const next = await reader.read(); if (next.done) { closed = true; return; } content += new TextDecoder().decode(next.value); } })();
    try {
      await vi.waitFor(() => expect(content).toContain("ready"));
      await f.request(`/api/v1/threads/${id}`, f.a, "PATCH", { title: "Fictional SSE private marker" });
      await f.request(`/api/v1/threads/${id}`, f.a, "PATCH", { shared: true });
      await vi.waitFor(() => expect(content).toContain(id));
      const beforeUnshare = content.length;
      await f.request(`/api/v1/threads/${id}`, f.a, "PATCH", { shared: false });
      await vi.waitFor(() => expect(content.slice(beforeUnshare)).toContain('"removed":true'));
      expect(content.slice(beforeUnshare)).not.toContain("Fictional SSE private marker");
      await f.request(`/api/v1/users/${f.bId}`, f.admin, "PATCH", { disabled: true });
      await vi.waitFor(() => expect(closed).toBe(true));
      await pumping;
    } finally { await reader.cancel(); await pumping; }
  });

  it("retains sessions/creator privacy across real service restart and revokes role/grant changes", async () => {
    const f = await fixture(); const id = await f.createThread(f.a);
    await f.restart();
    expect((await f.request(`/api/v1/threads/${id}`, f.a)).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${id}`, f.admin)).status).toBe(404);
    expect((await f.request(`/api/v1/users/${f.aId}`, f.admin, "PATCH", { grants: [] })).status).toBe(200);
    expect((await f.request(`/api/v1/threads/${id}`, f.a)).status).toBe(401);
    const relogged = await f.login("Avery"); expect((await f.request(`/api/v1/threads/${id}`, relogged)).status).toBe(404);
    const response = await f.request("/api/v1/bootstrap", f.admin);
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("etag")).toBeNull();
  });
});

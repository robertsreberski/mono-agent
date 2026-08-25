import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isAllowedWebHostname, startWebServer, type WebServerHandle } from "../server.js";
import { deliverWebNotification } from "../notification-client.js";
import { prepareWebStatePaths } from "../state-paths.js";
import { fakeDiscoveredAgent, fakeProcessJob, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];
const servers: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function start(options: Partial<Parameters<typeof startWebServer>[0]> = {}): Promise<{ handle: WebServerHandle; baseUrl: string; root: string }> {
  const root = await temporaryRoot();
  cleanup.push(root);
  // Managed runtimes live below ~/.mono-agent. Keep a hidden parent in the
  // fixture so SPA fallback tests exercise Express's dotfile handling.
  const staticDir = join(root, ".mono-agent", "static");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>web</title>");
  await writeFile(join(staticDir, "manifest.webmanifest"), JSON.stringify({
    name: "mono-agent Console",
    short_name: "mono-agent",
    start_url: "/",
    scope: "/",
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
  }));
  const handle = await startWebServer({
    port: 0,
    stateDir: join(root, "state"),
    staticDir,
    discoveryIntervalMs: 0,
    purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: operatorFetch(),
    ...options,
  });
  servers.push(handle);
  return { handle, baseUrl: `http://127.0.0.1:${handle.port}`, root };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function pushSubscriptionBody(endpoint = "https://push.example.test/send/opaque") {
  const key = Buffer.alloc(65);
  key[0] = 4;
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: key.toString("base64url"),
      auth: Buffer.alloc(16, 9).toString("base64url"),
    },
  };
}

describe("web HTTP server", () => {
  it("defaults to a LAN bind with no application auth or CORS grant", async () => {
    const { handle, baseUrl } = await start();
    expect(handle.host).toBe("0.0.0.0");
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: 1, push: "ok" });
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>web</title>");
    const clientRoute = await fetch(`${baseUrl}/conversations/example`);
    expect(clientRoute.status).toBe(200);
    expect(await clientRoute.text()).toContain("<title>web</title>");
    const bootstrap = await fetch(`${baseUrl}/api/v1/bootstrap`);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();
    const body = await bootstrap.json() as { console: unknown; agents: unknown[] };
    expect(body.console).toEqual({ hostName: hostname(), theme: "evergreen" });
    expect(body.agents[0]).toMatchObject({ sourceId: "agent-one", status: "online", supportsAttachments: true });
    expect(body).toMatchObject({
      push: {
        applicationServerKey: expect.any(String),
        keyFingerprint: expect.any(String),
        serviceWorkerVersion: 2,
      },
    });
    expect(JSON.stringify(body)).not.toContain("privateKey");
  });

  it("serves the fixed MCP App proxy with a route-local executable CSP", async () => {
    const { baseUrl } = await start();

    const proxy = await fetch(`${baseUrl}/api/v1/mcp-app-proxy`);
    expect(proxy.status).toBe(200);
    expect(proxy.headers.get("content-type")).toContain("text/html");
    expect(proxy.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(proxy.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(proxy.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const proxyCsp = proxy.headers.get("content-security-policy") ?? "";
    const proxyDirectives = new Map(proxyCsp.split("; ").map((directive) => {
      const separator = directive.indexOf(" ");
      return separator < 0
        ? [directive, ""] as const
        : [directive.slice(0, separator), directive.slice(separator + 1)] as const;
    }));
    expect(proxyDirectives.get("script-src")).toBe("'unsafe-inline'");
    expect(proxyDirectives.get("frame-ancestors")).toBe("'self'");
    for (const omitted of [
      "default-src",
      "connect-src",
      "style-src",
      "img-src",
      "font-src",
      "media-src",
      "frame-src",
      "child-src",
      "base-uri",
    ]) expect(proxyDirectives.has(omitted)).toBe(false);
    expect(proxyCsp).not.toMatch(/script-src[^;]*(?:https?:|\*)/u);
    const document = await proxy.text();
    expect(document).toContain('type: "mono-agent:mcp-app-proxy-ready"');
    expect(document).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(document).toContain('event.source !== appFrame.contentWindow');
    expect(document).toContain('event.origin !== "null"');
    expect(document).not.toContain("allow-same-origin");
    expect(document).not.toContain("resourceUrl");
    expect(document).not.toContain("bridgeUrl");

    const shell = await fetch(`${baseUrl}/`);
    const shellCsp = shell.headers.get("content-security-policy") ?? "";
    expect(shellCsp).toContain("script-src 'self'");
    expect(shellCsp).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
  });

  it("registers only exact-origin public push endpoints and never returns endpoint secrets", async () => {
    const { baseUrl } = await start({
      pushDnsResolver: async () => [{ address: "203.0.114.10", family: 4 }],
      pushSendImpl: async () => ({ statusCode: 201, headers: {} }),
      pushDispatchIntervalMs: 5,
    });
    const missingOrigin = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pushSubscriptionBody()),
    });
    expect(missingOrigin.status).toBe(403);

    const registered = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify(pushSubscriptionBody()),
    });
    expect(registered.status).toBe(201);
    const registeredBody = await json(registered) as { subscription: { id: string } };
    expect(registeredBody.subscription).toMatchObject({
      id: expect.any(String),
      state: "active",
      keyFingerprint: expect.any(String),
    });
    expect(JSON.stringify(registeredBody)).not.toContain("push.example.test");
    expect(JSON.stringify(registeredBody)).not.toContain(pushSubscriptionBody().keys.auth);

    const status = await fetch(`${baseUrl}/api/v1/push/subscriptions/${registeredBody.subscription.id}`, {
      headers: { "x-mono-agent-web-origin": baseUrl },
    });
    expect(status.status).toBe(200);
    expect(JSON.stringify(await status.json())).not.toContain("endpoint");
    const missingReadOrigin = await fetch(`${baseUrl}/api/v1/push/subscriptions/${registeredBody.subscription.id}`);
    expect(missingReadOrigin.status).toBe(403);
    const crossSiteStatus = await fetch(`${baseUrl}/api/v1/push/subscriptions/${registeredBody.subscription.id}`, {
      headers: { "sec-fetch-site": "cross-site", "x-mono-agent-web-origin": baseUrl },
    });
    expect(crossSiteStatus.status).toBe(403);

    const test = await fetch(`${baseUrl}/api/v1/push/subscriptions/${registeredBody.subscription.id}/test`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    expect(test.status).toBe(202);
    const rateLimited = await fetch(`${baseUrl}/api/v1/push/subscriptions/${registeredBody.subscription.id}/test`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    expect(rateLimited.status).toBe(429);

    const ack = await fetch(`${baseUrl}/api/v1/push/events/not-enumerated/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ subscriptionId: registeredBody.subscription.id, ackToken: "x".repeat(32) }),
    });
    expect(ack.status).toBe(204);

    const deleted = await fetch(`${baseUrl}/api/v1/push/subscriptions/${registeredBody.subscription.id}`, {
      method: "DELETE",
      headers: { origin: baseUrl },
    });
    expect(deleted.status).toBe(204);
  });

  it("accepts the worker origin claim and atomically retires rotated subscriptions", async () => {
    const { baseUrl } = await start({
      pushDnsResolver: async () => [{ address: "203.0.114.10", family: 4 }],
    });
    const oldEndpoint = "https://push.example.test/send/old";
    const oldResponse = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify(pushSubscriptionBody(oldEndpoint)),
    });
    const old = (await json(oldResponse) as { subscription: { id: string } }).subscription;

    const workerReplacement = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-mono-agent-web-origin": baseUrl,
      },
      body: JSON.stringify({
        ...pushSubscriptionBody("https://push.example.test/send/worker-rotated"),
        previousEndpoint: oldEndpoint,
      }),
    });
    expect(workerReplacement.status).toBe(201);
    const worker = (await json(workerReplacement) as { subscription: { id: string } }).subscription;
    expect(await json(await fetch(`${baseUrl}/api/v1/push/subscriptions/${old.id}`, {
      headers: { "x-mono-agent-web-origin": baseUrl },
    }))).toMatchObject({ subscription: { state: "expired", lastErrorCode: "subscription_rotated" } });

    const pageReplacement = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-mono-agent-web-origin": baseUrl,
      },
      body: JSON.stringify({
        ...pushSubscriptionBody("https://push.example.test/send/page-rotated"),
        previousSubscriptionId: worker.id,
      }),
    });
    expect(pageReplacement.status).toBe(201);
    expect(await json(await fetch(`${baseUrl}/api/v1/push/subscriptions/${worker.id}`, {
      headers: { "x-mono-agent-web-origin": baseUrl },
    }))).toMatchObject({ subscription: { state: "expired", lastErrorCode: "subscription_rotated" } });
    expect(await json(pageReplacement)).toMatchObject({ subscription: { state: "active" } });
  });

  it("rejects push endpoints that resolve to local, Tailscale, or mixed addresses", async () => {
    const { baseUrl } = await start({
      pushDnsResolver: async () => [
        { address: "203.0.114.10", family: 4 },
        { address: "100.64.103.59", family: 4 },
      ],
    });
    const response = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify(pushSubscriptionBody()),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { code: "invalid_push_subscription" } });
  });

  it("returns a retryable service error when push endpoint DNS is temporarily unavailable", async () => {
    const { baseUrl } = await start({
      pushDnsResolver: async () => { throw new Error("EAI_AGAIN"); },
    });
    const response = await fetch(`${baseUrl}/api/v1/push/subscriptions`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify(pushSubscriptionBody()),
    });
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ error: { code: "push_endpoint_unresolvable" } });
  });

  it("publishes the selected theme and host-specific install manifest", async () => {
    const { baseUrl } = await start({ theme: "plum" });

    expect(await json(await fetch(`${baseUrl}/api/v1/bootstrap`))).toMatchObject({
      version: 1,
      console: { hostName: hostname(), theme: "plum" },
    });
    const response = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(await response.json()).toEqual(expect.objectContaining({
      name: `${hostname()} · mono-agent Console`,
      short_name: hostname(),
      start_url: "/",
      scope: "/",
      theme_color: "#120f14",
      background_color: "#120f14",
      icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    }));
  });

  it("serves live agent-scoped skills without persisting them in bootstrap", async () => {
    const { baseUrl } = await start({
      fetchImpl: operatorFetch({
        skills: {
          status: "ready",
          items: [{
            name: "research",
            description: "Find sources.",
            availability: "inlined",
            reference: "$research",
          }],
          total: 1,
        },
      }),
    });

    const bootstrap = await json(await fetch(`${baseUrl}/api/v1/bootstrap`));
    expect(JSON.stringify(bootstrap)).not.toContain("research");
    await expect(json(await fetch(`${baseUrl}/api/v1/agents/agent-one/skills`)))
      .resolves.toEqual({
        status: "ready",
        items: [{
          name: "research",
          description: "Find sources.",
          availability: "inlined",
          reference: "$research",
        }],
        total: 1,
      });
    expect((await fetch(`${baseUrl}/api/v1/agents/missing/skills`)).status).toBe(404);
  });

  it("distinguishes unsupported and offline agent skill registries", async () => {
    const legacy = await start();
    await expect(json(await fetch(`${legacy.baseUrl}/api/v1/agents/agent-one/skills`)))
      .resolves.toEqual({ status: "unsupported", items: [] });

    const discovered = fakeDiscoveredAgent();
    const { baseUrl: _baseUrl, ...offlineAgent } = discovered;
    const offline = await start({ discoverImpl: async () => [offlineAgent] });
    await expect(json(await fetch(`${offline.baseUrl}/api/v1/agents/agent-one/skills`)))
      .resolves.toEqual({ status: "offline", items: [] });
  });

  it("publishes an owner-private loopback ingress and removes only its live record on stop", async () => {
    const recorded: unknown[] = [];
    const { handle, baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({
        supportsHistoryAppend: true,
        onVerbatim: async (conversationId, body) => void recorded.push({ conversationId, body }),
      }),
    });
    const ingressPath = join(handle.stateDir, "notify-ingress.json");
    expect((await lstat(ingressPath)).mode & 0o777).toBe(0o600);
    const ingress = JSON.parse(await readFile(ingressPath, "utf8")) as { url: string; token: string };
    expect(new URL(ingress.url).hostname).toBe("127.0.0.1");

    const unauthorized = await fetch(ingress.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey: "cron:daily:one:success",
        text: "Morning brief",
      }),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(ingress.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingress.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceId: "agent-one",
        triggerKind: "cron",
        deliveryKey: "cron:daily:one:success",
        text: "Morning brief",
      }),
    });
    expect(accepted.status).toBe(201);
    const delivered = await json(accepted) as { threadId: string; duplicate: boolean };
    expect(delivered.duplicate).toBe(false);
    expect(recorded).toEqual([{
      conversationId: `web:${delivered.threadId}`,
      body: { text: "Morning brief", idempotencyKey: "cron:daily:one:success" },
    }]);
    const bootstrap = await json(await fetch(`${baseUrl}/api/v1/bootstrap`)) as { threads: unknown[] };
    expect(bootstrap.threads).toEqual([
      expect.objectContaining({
        id: delivered.threadId,
        title: "Cron notification",
        trigger: { kind: "cron" },
      }),
    ]);

    await handle.stop();
    await expect(lstat(ingressPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a precise read-only API error when a healthy cron channel receives input", async () => {
    const { baseUrl } = await start({
      fetchImpl: operatorFetch({
        cronOverview: {
          generatedAt: "2026-08-14T10:00:00.000Z",
          actionsEnabled: false,
          jobs: [{
            jobId: "digest",
            expression: "*/5 * * * *",
            timezone: "UTC",
            conversationId: "cron:digest",
            configured: true,
            declaredEnabled: true,
            effectiveEnabled: true,
            health: "healthy",
          }],
        },
      }),
    });
    const overviewResponse = await fetch(`${baseUrl}/api/v1/agents/agent-one/cron`);
    const overview = await json(overviewResponse) as { jobs: Array<{ threadId: string }> };
    const threadId = overview.jobs[0]!.threadId;
    const expected = {
      error: {
        code: "cron_channel_read_only",
        message: "Cron channels are read-only. Scheduled runs and history are managed by the agent.",
      },
    };

    for (const endpoint of ["turns", "live-input"] as const) {
      const response = await fetch(`${baseUrl}/api/v1/threads/${threadId}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "not allowed" }),
      });
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual(expected);
    }
    for (const request of [
      new Request(`${baseUrl}/api/v1/threads/${threadId}/ask`),
      new Request(`${baseUrl}/api/v1/threads/${threadId}/ask/ask-one`),
      new Request(`${baseUrl}/api/v1/threads/${threadId}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "ask-one", answers: [] }),
      }),
    ]) {
      const response = await fetch(request);
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual(expected);
    }
  });

  it("keeps webhook notification conversations read-only across browser input routes", async () => {
    const { handle, baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({ supportsHistoryAppend: true }),
    });
    const delivered = await deliverWebNotification({
      sourceId: "agent-one",
      triggerKind: "webhook",
      deliveryKey: "webhook:read-only:success",
      text: "Automation result",
    }, { stateDir: handle.stateDir });
    const detail = await json(await fetch(`${baseUrl}/api/v1/threads/${delivered.threadId}`));
    expect(detail.thread).toMatchObject({
      trigger: { kind: "webhook" },
      canSend: false,
      canUpload: false,
    });

    for (const endpoint of ["turns", "live-input"] as const) {
      const response = await fetch(`${baseUrl}/api/v1/threads/${delivered.threadId}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "not allowed" }),
      });
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({
        error: {
          code: "automation_thread_read_only",
          message: "Automation conversations are read-only.",
        },
      });
    }
    for (const request of [
      new Request(`${baseUrl}/api/v1/threads/${delivered.threadId}/ask`),
      new Request(`${baseUrl}/api/v1/threads/${delivered.threadId}/ask/ask-one`),
      new Request(`${baseUrl}/api/v1/threads/${delivered.threadId}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "ask-one", answers: [] }),
      }),
    ]) {
      const response = await fetch(request);
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({
        error: {
          code: "automation_thread_read_only",
          message: "Automation conversations are read-only.",
        },
      });
    }
  });

  it("serves compact cron pages separately from selected-run activity detail", async () => {
    const summary = {
      projection: "summary",
      runId: "cron:digest:2026-08-14T10:00:00.000Z",
      jobId: "digest",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      orderedAt: "2026-08-14T10:00:00.000Z",
      sequence: 1,
      trigger: "scheduled",
      status: "succeeded",
      text: "Compact result",
      eventCount: 30,
    };
    const { baseUrl } = await start({
      fetchImpl: operatorFetch({
        cronOverview: {
          generatedAt: "2026-08-14T10:00:00.000Z",
          actionsEnabled: false,
          jobs: [{
            jobId: "digest",
            expression: "*/5 * * * *",
            timezone: "UTC",
            conversationId: "cron:digest",
            configured: true,
            declaredEnabled: true,
            effectiveEnabled: true,
            health: "healthy",
            lastRun: summary,
          }],
        },
        cronRuns: { runs: [summary] },
        cronRun: {
          ...summary,
          projection: "detail",
          text: "Selected full result",
          events: [{ type: "runtime_warning", message: "Bounded activity" }],
          eventsIncluded: 1,
          eventsTruncated: true,
        },
      }),
    });

    const page = await json(await fetch(`${baseUrl}/api/v1/agents/agent-one/cron/jobs/digest/runs?limit=100`));
    expect(page.runs).toEqual([summary]);
    expect(JSON.stringify(page)).not.toContain("Bounded activity");
    const selected = await json(await fetch(
      `${baseUrl}/api/v1/agents/agent-one/cron/jobs/digest/runs/${encodeURIComponent(summary.runId)}`,
    ));
    expect(selected.message).toMatchObject({
      parts: expect.arrayContaining([
        { type: "text", text: "Selected full result" },
        expect.objectContaining({ type: "telemetry", event: "runtime_warning" }),
        expect.objectContaining({
          type: "telemetry",
          event: "cron_run",
          data: expect.objectContaining({ eventsTruncated: true }),
        }),
      ]),
    });
  });

  it("rejects DNS-rebinding hosts and cross-origin mutations while accepting the exact configured hostname", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    expect(isAllowedWebHostname("mickey.home.arpa", "mickey.home.arpa", "mickey")).toBe(true);
    expect(isAllowedWebHostname("attacker.home.arpa", "mickey.home.arpa", "mickey")).toBe(false);
    expect(isAllowedWebHostname("attacker.local", "0.0.0.0", "mickey")).toBe(false);
    expect(isAllowedWebHostname("attacker.ts.net", "0.0.0.0", "mickey")).toBe(false);
    expect(isAllowedWebHostname("mickey-home.tailnet.ts.net", "0.0.0.0", "mickey", ["mickey-home.tailnet.ts.net"]))
      .toBe(true);

    const target = new URL(baseUrl);
    const rebindingStatus = await new Promise<number>((resolvePromise, reject) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: "/healthz",
        headers: { Host: "attacker" },
      }, (response) => {
        response.resume();
        resolvePromise(response.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
    expect(rebindingStatus).toBe(421);
    const crossOrigin = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(sameOrigin.status).toBe(201);
  });

  it("maps oversized JSON to 413 instead of a generic server error", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const response = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "x".repeat(300_000) }),
    });
    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({ error: { code: "request_too_large" } });
  });

  it("validates exact host configuration before acquiring the persistent service lease", async () => {
    const root = await temporaryRoot();
    cleanup.push(root);
    const staticDir = join(root, "static");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "ok");
    const options = {
      host: "127.0.0.1",
      port: 0,
      stateDir: join(root, "state"),
      staticDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [],
    } as const;

    await expect(startWebServer({ ...options, allowedHosts: ["bad:host"] }))
      .rejects.toMatchObject({ code: "invalid_allowed_host" });
    await expect(startWebServer({ ...options, theme: "neon" as never }))
      .rejects.toMatchObject({ code: "invalid_theme" });
    const handle = await startWebServer(options);
    servers.push(handle);
    expect(handle.port).toBeGreaterThan(0);
  });

  it("streams raw uploads, rejects encoded/wrong-size bodies, and serves non-images as safe downloads", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const unsupported = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "raw.bin", contentType: "application/octet-stream", sizeBytes: 1 }),
    });
    expect(unsupported.status).toBe(415);

    const created = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "page('x').html", contentType: "text/html", sizeBytes: 5 }),
    });
    const attachment = (await json(created)).attachment as { id: string };
    const wrongMime = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "text/html" }, body: "hello",
    });
    expect(wrongMime.status).toBe(415);
    const encoded = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" }, body: "hello",
    });
    expect(encoded.status).toBe(415);
    const uploaded = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "hello",
    });
    expect(uploaded.status).toBe(200);

    const content = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("content-disposition")).toContain("attachment;");
    expect(content.headers.get("content-disposition")).toContain("%27");
    expect(await content.text()).toBe("hello");
  });

  it("serves message-bound reply downloads and private MCP App bridge routes with hardened headers", async () => {
    const bytes = Buffer.from("<script>alert(1)</script>");
    const integrityId = `sha256:${"a".repeat(64)}`;
    const bridgeBodies: Record<string, unknown>[] = [];
    let clockMs = Date.parse("2026-08-14T12:00:00.000Z");
    const { baseUrl } = await start({
      clock: () => new Date(clockMs),
      fetchImpl: operatorFetch({
        supportsReplyAttachments: true,
        supportsMcpApps: true,
        turns: () => `${JSON.stringify({
          kind: "finish",
          finalText: "Ready",
          parts: [
            {
              type: "attachment",
              id: "file-part",
              reference: { scheme: "mono-agent-artifact", id: "artifact-one" },
              name: "unsafe.html",
              mediaType: "text/html",
              sizeBytes: bytes.byteLength,
              integrityId,
              expiresAt: "2026-08-15T12:00:00.000Z",
            },
            {
              type: "mcp_app",
              id: "11111111-1111-4111-8111-111111111111",
              invocationId: "11111111-1111-4111-8111-111111111111",
              connectionId: "connection-one",
              serverName: "widgets",
              toolName: "show_chart",
              resourceUri: "ui://widgets/chart",
              mediaType: "text/html;profile=mcp-app",
              protocolVersion: "2026-01-26",
              expiresAt: "2026-08-15T12:00:00.000Z",
            },
          ],
        })}\n`,
        onReplyArtifact(_url, init) {
          expect(init?.headers).toMatchObject({ "x-mono-agent-integrity-id": integrityId });
          return new Response(bytes, {
            headers: { "content-length": String(bytes.byteLength), "x-mono-agent-integrity-id": integrityId },
          });
        },
        onMcpAppResource(_url, init) {
          expect(init?.headers).toMatchObject({ "x-mono-agent-mcp-connection-id": "connection-one" });
          return {
            app: {
              type: "mcp_app",
              id: "11111111-1111-4111-8111-111111111111",
              invocationId: "11111111-1111-4111-8111-111111111111",
              connectionId: "connection-one",
              serverName: "widgets",
              toolName: "show_chart",
              resourceUri: "ui://widgets/chart",
              mediaType: "text/html;profile=mcp-app",
              protocolVersion: "2026-01-26",
            },
            html: "<!doctype html><script>parent.document.cookie</script>",
            connected: true,
          };
        },
        onMcpAppRequest(_url, body) {
          bridgeBodies.push(body);
          if ((body.params as { readonly name?: unknown } | undefined)?.name === "audit_incomplete") {
            return Response.json({
              error: {
                code: "app_audit_incomplete",
                message: "The MCP App tool ran; do not retry automatically.",
              },
            }, { status: 409 });
          }
          return { ok: true };
        },
      }),
    });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created) as { thread: { id: string } }).thread;
    await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "show results" }),
    });
    let message: { id: string; parts: Array<Record<string, unknown>> } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`)) as {
        messages: Array<{ id: string; parts: Array<Record<string, unknown>> }>;
      };
      message = detail.messages.at(-1);
      if (message?.parts.some((part) => part.type === "mcp_app")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const attachment = message?.parts.find((part) => part.type === "attachment");
    const app = message?.parts.find((part) => part.type === "mcp_app");
    expect(attachment?.contentUrl).toEqual(expect.any(String));
    expect(app?.resourceUrl).toEqual(expect.any(String));

    const download = await fetch(`${baseUrl}${String(attachment?.contentUrl)}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(download.headers.get("accept-ranges")).toBe("none");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    const other = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const otherId = (await json(other) as { thread: { id: string } }).thread.id;
    const crossSessionUrl = String(attachment?.contentUrl).replace(thread.id, otherId);
    expect((await fetch(`${baseUrl}${crossSessionUrl}`)).status).toBe(404);

    const appResource = await fetch(`${baseUrl}${String(app?.resourceUrl)}`);
    expect(appResource.status).toBe(200);
    expect(appResource.headers.get("cache-control")).toContain("no-store");
    expect(appResource.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await expect(appResource.json()).resolves.toMatchObject({ connected: true, html: expect.stringContaining("<script>") });

    const bridgeUrl = `${baseUrl}${String(app?.bridgeUrl)}`;
    const unconfirmed = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ method: "tools/call", params: { name: "refresh_chart" } }),
    });
    expect(unconfirmed.status).toBe(409);
    const confirmed = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ method: "tools/call", params: { name: "refresh_chart" }, confirmed: true }),
    });
    await expect(confirmed.json()).resolves.toEqual({ result: { ok: true } });
    expect(bridgeBodies).toEqual([{
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    }]);
    const incomplete = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ method: "tools/call", params: { name: "audit_incomplete" }, confirmed: true }),
    });
    expect(incomplete.status).toBe(409);
    await expect(incomplete.json()).resolves.toMatchObject({
      error: {
        code: "app_audit_incomplete",
        message: expect.stringContaining("do not retry automatically"),
      },
    });

    const crossOrigin = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ method: "resources/read", params: { uri: "ui://widgets/data" } }),
    });
    expect(crossOrigin.status).toBe(403);
    const oversized = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ method: "resources/read", params: { value: "x".repeat(70 * 1024) } }),
    });
    expect(oversized.status).toBe(413);

    clockMs += 11 * 60 * 1_000;
    const expiredDownload = await fetch(`${baseUrl}${String(attachment?.contentUrl)}`);
    expect(expiredDownload.status).toBe(410);
    await expect(expiredDownload.json()).resolves.toMatchObject({
      error: { code: "reply_access_expired" },
    });
    const expiredResource = await fetch(`${baseUrl}${String(app?.resourceUrl)}`);
    expect(expiredResource.status).toBe(410);
    await expect(expiredResource.json()).resolves.toMatchObject({
      error: { code: "reply_access_expired" },
    });
    const expiredBridge = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ method: "resources/read", params: { uri: "ui://widgets/data" } }),
    });
    expect(expiredBridge.status).toBe(410);
    await expect(expiredBridge.json()).resolves.toMatchObject({
      error: { code: "reply_access_expired" },
    });

    const attachmentAccessPath = new URL(String(attachment?.contentUrl), baseUrl).pathname
      .replace(/\/content$/u, "/access");
    const appAccessPath = `${new URL(String(app?.resourceUrl), baseUrl).pathname}/access`;
    const refreshedAttachmentResponse = await fetch(`${baseUrl}${attachmentAccessPath}`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    expect(refreshedAttachmentResponse.status).toBe(200);
    const refreshedAttachment = (await json(refreshedAttachmentResponse)).part as Record<string, unknown>;
    expect(refreshedAttachment.contentUrl).not.toBe(attachment?.contentUrl);
    expect((await fetch(`${baseUrl}${String(refreshedAttachment.contentUrl)}`)).status).toBe(200);

    const refreshedAppResponse = await fetch(`${baseUrl}${appAccessPath}`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    expect(refreshedAppResponse.status).toBe(200);
    const refreshedApp = (await json(refreshedAppResponse)).part as Record<string, unknown>;
    expect(refreshedApp.resourceUrl).not.toBe(app?.resourceUrl);
    expect((await fetch(`${baseUrl}${String(refreshedApp.resourceUrl)}`)).status).toBe(200);
    const refreshedBridge = await fetch(`${baseUrl}${String(refreshedApp.bridgeUrl)}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ method: "resources/read", params: { uri: "ui://widgets/data" } }),
    });
    expect(refreshedBridge.status).toBe(200);

    const staleAttachmentUrl = new URL(String(attachment?.contentUrl), baseUrl);
    const originalToken = staleAttachmentUrl.searchParams.get("token")!;
    staleAttachmentUrl.searchParams.set(
      "token",
      `${originalToken.slice(0, -1)}${originalToken.endsWith("x") ? "y" : "x"}`,
    );
    const forged = await fetch(staleAttachmentUrl);
    expect(forged.status).toBe(404);
    await expect(forged.json()).resolves.toMatchObject({ error: { code: "reply_part_not_found" } });
    const unknown = await fetch(
      `${baseUrl}${String(attachment?.contentUrl).replace("file-part", "unknown-part")}`,
    );
    expect(unknown.status).toBe(404);
    const crossThreadRefresh = await fetch(
      `${baseUrl}${attachmentAccessPath.replace(thread.id, otherId)}`,
      { method: "POST", headers: { origin: baseUrl } },
    );
    expect(crossThreadRefresh.status).toBe(404);
    const missingOriginRefresh = await fetch(`${baseUrl}${attachmentAccessPath}`, { method: "POST" });
    expect(missingOriginRefresh.status).toBe(403);
    expect(bridgeBodies).toHaveLength(3);
  });

  it("keeps failed upload bytes staged/retryable and removes only staged attachments", async () => {
    const { baseUrl, handle } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", contentType: "text/plain", sizeBytes: 5 }),
    });
    const attachment = (await json(created)).attachment as { id: string };
    const mismatch = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "four",
    });
    expect(mismatch.status).toBe(400);
    expect((await readdir(join(handle.stateDir, "uploads"))).filter((name) => name.includes("partial"))).toEqual([]);
    const retried = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "hello",
    });
    expect(retried.status).toBe(200);
    const committedDelete = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}`, { method: "DELETE" });
    expect(committedDelete.status).toBe(204); // uploaded but still staged until a turn commits it
    expect(await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`)).toMatchObject({ status: 404 });
  });

  it("cleans validated crash-residue partial uploads before accepting traffic", async () => {
    const root = await temporaryRoot();
    cleanup.push(root);
    const stateDir = join(root, "state");
    const paths = await prepareWebStatePaths({ stateDir });
    const partial = join(paths.uploads, "11111111-1111-4111-8111-111111111111.bin.partial-22222222-2222-4222-8222-222222222222");
    await writeFile(partial, "orphan", { mode: 0o600 });
    const staticDir = join(root, "static");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "ok");
    const handle = await startWebServer({
      host: "127.0.0.1", port: 0, stateDir, staticDir,
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [],
    });
    servers.push(handle);
    await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports create/read/archive/turn API flow with a source-bound conversation", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string; sourceId: string };
    expect(thread.sourceId).toBe("agent-one");
    const removedJobCollection = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/jobs`);
    expect(removedJobCollection.status).toBe(404);
    expect(await json(removedJobCollection)).toMatchObject({ error: { code: "not_found" } });
    const retainedSingleJobProxy = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/jobs/missing-job`);
    expect(retainedSingleJobProxy.status).toBe(404);
    expect(await json(retainedSingleJobProxy)).toMatchObject({ error: { code: "process_job_not_found" } });
    const turn = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello", model: "provider/default", effort: "high" }),
    });
    expect(turn.status).toBe(202);
    let detail: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
      if ((detail.thread as { runState?: { status?: string } }).runState?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(detail).toMatchObject({ thread: { sourceId: "agent-one", runState: { status: "complete" } } });
    const archived = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
    });
    expect((await json(archived)).thread).toMatchObject({ id: thread.id });
    const deleted = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`)).toMatchObject({ status: 404 });
  });

  it("serves conversation workspace collections, preferences, filters, FTS matches, and anchors", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const headers = { "content-type": "application/json" };
    const createdCollection = await fetch(`${baseUrl}/api/v1/collections`, {
      method: "POST", headers, body: JSON.stringify({ name: "Projects" }),
    });
    expect(createdCollection.status).toBe(201);
    const collection = (await json(createdCollection)).collection as { id: string; name: string };
    expect(collection.name).toBe("Projects");

    const preferencesResponse = await fetch(`${baseUrl}/api/v1/agents/agent-one/preferences`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ runPreference: { model: "provider/fallback", effort: "high" } }),
    });
    expect(preferencesResponse.status).toBe(200);
    expect(await json(preferencesResponse)).toMatchObject({
      preferences: {
        sourceId: "agent-one",
        runPreference: { model: "provider/fallback", effort: "high" },
      },
    });

    const createThreadResponse = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(createThreadResponse)).thread as { id: string; revision: number };
    const patchedResponse = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        collectionId: collection.id,
        workflowStatus: "done",
        pinned: true,
        runPreference: { effort: "low" },
        expectedRevision: thread.revision,
      }),
    });
    expect(patchedResponse.status).toBe(200);
    expect((await json(patchedResponse)).thread).toMatchObject({
      collectionId: collection.id,
      workflowStatus: "done",
      pinned: true,
      runPreference: { effort: "low" },
    });

    const turn = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST", headers, body: JSON.stringify({ text: "anchor user phrase" }),
    });
    expect(turn.status).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
      if ((detail.thread as { runState?: { status?: string } }).runState?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    const query = new URLSearchParams({
      sourceIds: "agent-one",
      archived: "false",
      workflowStatus: "in_progress",
      collectionId: collection.id,
      pinned: "true",
      type: "interactive",
      q: "Hello world",
      groupBy: "collection",
    });
    const page = await json(await fetch(`${baseUrl}/api/v1/threads?${query.toString()}`)) as {
      threads: Array<{ id: string; searchMatch?: { messageId?: string; snippet: string } }>;
      groups: Array<{ key: string; label: string; threadIds: string[] }>;
    };
    expect(page.threads).toEqual([
      expect.objectContaining({
        id: thread.id,
        searchMatch: expect.objectContaining({ messageId: expect.any(String), snippet: "Hello world" }),
      }),
    ]);
    expect(page.groups).toEqual([{ key: collection.id, label: "Projects", threadIds: [thread.id] }]);
    const messageId = page.threads[0]!.searchMatch!.messageId!;
    const anchored = await json(await fetch(
      `${baseUrl}/api/v1/threads/${thread.id}/messages?anchor=${encodeURIComponent(messageId)}&limit=5`,
    )) as { messages: Array<{ id: string }> };
    expect(anchored.messages.map((message) => message.id)).toContain(messageId);

    const hidden = await json(await fetch(
      `${baseUrl}/api/v1/threads?sourceIds=agent-one&type=interactive&q=Reasoning`,
    )) as { threads: unknown[] };
    expect(hidden.threads).toEqual([]);

    const removed = await fetch(`${baseUrl}/api/v1/collections/${collection.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`)))
      .toMatchObject({ thread: { collectionId: null } });
    expect(await json(await fetch(`${baseUrl}/api/v1/bootstrap`)))
      .toMatchObject({ collections: [] });
  });

  it("projects process-job rich replies through the thread API with exact message-bound access", async () => {
    const { baseUrl, handle } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const processJob = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
      wakeState: "delivered",
    });
    const notification = {
      sourceId: "agent-one",
      triggerKind: "job" as const,
      deliveryKey: processJob.wake.deliveryKey,
      threadId: thread.id,
      processJob,
      parts: [
        {
          type: "attachment",
          id: "job-attachment",
          reference: { scheme: "mono-agent-artifact", id: "job-artifact" },
          name: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
          integrityId: `sha256:${"a".repeat(64)}`,
        },
        {
          type: "mcp_app",
          id: "11111111-1111-4111-8111-111111111111",
          invocationId: "11111111-1111-4111-8111-111111111111",
          connectionId: "job-connection",
          serverName: "widgets",
          toolName: "show_chart",
          resourceUri: "ui://widgets/chart",
          mediaType: "text/html;profile=mcp-app",
          protocolVersion: "2026-01-26",
          title: "Job chart",
        },
        {
          type: "failure",
          id: "job-failure",
          code: "artifact_missing",
          message: "One optional artifact expired.",
        },
      ],
    } as const;
    await expect(deliverWebNotification(notification, { stateDir: handle.stateDir }))
      .resolves.toEqual({ threadId: thread.id, duplicate: false });
    await expect(deliverWebNotification(notification, { stateDir: handle.stateDir }))
      .resolves.toEqual({ threadId: thread.id, duplicate: true });

    const detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`)) as {
      messages: Array<{ id: string; parts: Array<Record<string, unknown>> }>;
    };
    const message = detail.messages[0]!;
    const expectedBase = `/api/v1/threads/${encodeURIComponent(thread.id)}/messages/${encodeURIComponent(message.id)}`;
    expect(message.parts).toEqual([
      expect.objectContaining({ type: "process-job", job: expect.objectContaining({ jobId: processJob.jobId }) }),
      expect.objectContaining({
        type: "attachment",
        id: "job-attachment",
        contentUrl: expect.stringMatching(new RegExp(`^${expectedBase}/reply-attachments/job-attachment/content\\?`)),
      }),
      expect.objectContaining({
        type: "mcp_app",
        id: "11111111-1111-4111-8111-111111111111",
        resourceUrl: expect.stringMatching(new RegExp(`^${expectedBase}/mcp-apps/11111111-1111-4111-8111-111111111111\\?`)),
        bridgeUrl: expect.stringMatching(new RegExp(`^${expectedBase}/mcp-apps/11111111-1111-4111-8111-111111111111/requests\\?`)),
      }),
      expect.objectContaining({ type: "failure", id: "job-failure", code: "artifact_missing" }),
    ]);
    expect(JSON.stringify(message.parts)).not.toContain("mono-agent-artifact");
  });

  it("accepts a live follow-up for the active web turn and exposes its applied status", async () => {
    const encoder = new TextEncoder();
    let finishTurn = () => undefined;
    const liveInputs: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const { baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "append", delta: "Working" })}\n`));
            finishTurn = () => {
              controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
              controller.close();
            };
          },
        }),
        onLiveInput: async (conversationId, body) => {
          liveInputs.push({ conversationId, body });
          return { status: "applied", runId: "run-live" };
        },
      }),
    });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const started = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Start the work" }),
    });
    expect(started.status).toBe(202);

    const response = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/live-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Use the smaller scope" }),
    });
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      disposition: "pending",
      message: { role: "user", liveInputStatus: "pending" },
    });

    let detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const messages = detail.messages as Array<{ liveInputStatus?: string }>;
      if (messages.some((message) => message.liveInputStatus === "applied")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
    }
    expect(detail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ liveInputStatus: "applied" }),
    ]));
    expect(liveInputs).toEqual([{
      conversationId: `web:${thread.id}`,
      body: expect.objectContaining({ text: "Use the smaller scope" }),
    }]);
    finishTurn();
  });

  it("proxies pending and submitted AskUser state for a web conversation", async () => {
    const submissions: Record<string, unknown>[] = [];
    const snapshot = {
      interactionId: "ask-test",
      questions: [{
        id: "q0",
        header: "Delivery",
        question: "Send the draft?",
        options: [
          { id: "q0o0", label: "Send", description: "Send it now." },
          { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        ],
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: "2026-07-21T09:00:00.000Z",
      expiresAt: "2026-07-21T09:10:00.000Z",
    };
    const { baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl: operatorFetch({
        supportsAskUser: true,
        pendingAsk: snapshot,
        onAskSubmit: (body) => submissions.push(body),
      }),
    });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };

    const pending = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/ask`);
    expect(await json(pending)).toEqual({ ask: snapshot });
    const submitted = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ask-test",
        answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
      }),
    });
    expect(await json(submitted)).toMatchObject({ accepted: true, snapshot: { status: "answered" } });
    expect(submissions).toEqual([{
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    }]);
  });

  it("validates the public quote payload before starting a turn", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const response = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Follow up",
        quote: { text: "", messageId: "message" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("validates and persists agent pins with pinned-first bootstrap ordering", async () => {
    const first = fakeDiscoveredAgent();
    const second = fakeDiscoveredAgent({
      source: { ...first.source, sourceId: "agent-two", label: "Agent Two" },
    });
    const { baseUrl } = await start({
      host: "127.0.0.1",
      discoverImpl: async () => [first, second],
    });
    const headers = { "content-type": "application/json" };

    const invalid = await fetch(`${baseUrl}/api/v1/agents/agent-two`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: "yes" }),
    });
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({ error: { code: "invalid_request" } });
    const missing = await fetch(`${baseUrl}/api/v1/agents/missing`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: true }),
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: { code: "agent_not_found" } });

    const pinned = await fetch(`${baseUrl}/api/v1/agents/agent-two`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: true }),
    });
    expect(pinned.status).toBe(200);
    expect(await json(pinned)).toMatchObject({ agent: { sourceId: "agent-two", pinned: true } });
    const bootstrap = await json(await fetch(`${baseUrl}/api/v1/bootstrap`)) as { agents: Array<{ sourceId: string; pinned: boolean }> };
    expect(bootstrap.agents.map(({ sourceId, pinned: isPinned }) => ({ sourceId, pinned: isPinned }))).toEqual([
      { sourceId: "agent-two", pinned: true },
      { sourceId: "agent-one", pinned: false },
    ]);

    const unpinned = await fetch(`${baseUrl}/api/v1/agents/agent-two`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: false }),
    });
    expect(unpinned.status).toBe(200);
    expect(await json(unpinned)).toMatchObject({ agent: { sourceId: "agent-two", pinned: false } });
  });

  it("caps SSE clients and permits reconnect/bootstrap semantics", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const streams = await Promise.all(Array.from({ length: 64 }, async () => fetch(`${baseUrl}/api/v1/events`)));
    expect(streams.every((response) => response.status === 200)).toBe(true);
    const firstChunk = await streams[0]?.body?.getReader().read();
    expect(new TextDecoder().decode(firstChunk?.value)).toContain("event: ready");
    const overflow = await fetch(`${baseUrl}/api/v1/events`);
    expect(overflow.status).toBe(503);
    await Promise.all(streams.map(async (response) => response.body?.cancel().catch(() => undefined)));
    // Cancelling a stream client-side does not synchronously free the server's slot — the server
    // reaps it when it observes the closed socket. A fixed 20ms sleep raced that reaper under load
    // and read back the same 503 as the overflow above. Poll until capacity is actually free, and
    // still return the last response so a genuine regression reports its real status.
    const reconnected = await waitForFreeSseSlot(baseUrl);
    expect(reconnected.status).toBe(200);
    await reconnected.body?.cancel();
  }, 15_000);
});

/** Reconnect until the server has reaped the cancelled streams, or give up and let the caller assert. */
async function waitForFreeSseSlot(baseUrl: string, timeoutMs = 5_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/v1/events`);
    if (response.status === 200 || Date.now() > deadline) return response;
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

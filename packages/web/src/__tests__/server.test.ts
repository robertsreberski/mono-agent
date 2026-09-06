import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { WEB_API_VERSION, type WebEvent } from "../contracts.js";
import { createWebEventDispatch, isAllowedWebHostname, startWebServer, type WebServerHandle } from "../server.js";
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
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>web</title>");
  // Hashed bundles, the two service workers, and the shell each take a different
  // cache policy, so the fixture carries a real file for every one of them. The
  // bundle is padded past the 1 KiB compression threshold.
  await writeFile(join(staticDir, "assets", "app-abc123.js"), `export const shell = "${"s".repeat(2048)}";\n`);
  await writeFile(join(staticDir, "sw.js"), "self.addEventListener('install', () => {});\n");
  await writeFile(join(staticDir, "workbox-abc.js"), "self.workbox = {};\n");
  await writeFile(join(staticDir, "notification-sw.js"), "self.addEventListener('push', () => {});\n");
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

async function createThread(baseUrl: string, sourceId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId }),
  });
  return ((await json(response)).thread as { id: string }).id;
}

interface ScopedBootstrap {
  readonly threads: readonly { readonly id: string; readonly sourceId: string }[];
  readonly threadsSourceId: string | null;
  readonly threadsNextCursor: string | null;
  readonly agents: readonly { readonly sourceId: string; readonly updatedAt: string }[];
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/**
 * `fetch` negotiates and transparently decodes its own `Accept-Encoding`, which
 * hides exactly what these transport tests measure. Node's raw client sends no
 * encoding of its own and never decodes, so the assertions see the bytes on the
 * wire.
 */
async function rawGet(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const target = new URL(path, baseUrl);
  return new Promise<RawResponse>((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolvePromise({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

/** An agent whose model catalog alone pushes bootstrap well past 16 KiB. */
function modelRichAgentFetch(): typeof fetch {
  const models = Array.from(
    { length: 300 },
    (_unused, index) => `provider/model-${String(index).padStart(3, "0")}-${"m".repeat(64)}`,
  );
  const modelOptions = Object.fromEntries(models.map((model) => [model, {
    label: `Model ${model} ${"l".repeat(64)}`,
    reasoning: true,
    effortLevels: ["low", "medium", "high", "xhigh"],
    contextWindow: 131_072,
  }]));
  const fallbackFetch = operatorFetch();
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/info")) {
      return Response.json({
        schema: 1,
        label: "Agent One",
        model: models[0],
        effort: "high",
        models,
        modelOptions,
        capabilities: { attachments: true, askUser: false, liveInput: false },
      });
    }
    return fallbackFetch(input, init);
  };
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
  it("persists, applies, validates, and reverts web-only new-conversation defaults", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const mutation = { "content-type": "application/json", origin: baseUrl };

    const saved = await fetch(`${baseUrl}/api/v1/agents/agent-one/run-defaults`, {
      method: "PUT",
      headers: mutation,
      body: JSON.stringify({ model: "provider/fallback", effort: "high" }),
    });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ agent: { runSettings: {
      override: { model: "provider/fallback", effort: "high" },
      effective: { modelSource: "override", effortSource: "override" },
    } } });

    const createdA = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: mutation,
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(createdA.status).toBe(201);
    expect(await json(createdA)).toMatchObject({ thread: { runModel: "provider/fallback", runEffort: "high" } });

    const invalid = await fetch(`${baseUrl}/api/v1/agents/agent-one/run-defaults`, {
      method: "PUT",
      headers: mutation,
      body: JSON.stringify({ model: "anthropic:never-advertised", effort: null }),
    });
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({ error: { code: "invalid_model" } });

    const meaningless = await fetch(`${baseUrl}/api/v1/agents/agent-one/run-defaults`, {
      method: "PUT",
      headers: mutation,
      body: JSON.stringify({ model: null, effort: null }),
    });
    expect(meaningless.status).toBe(400);
    expect(await json(meaningless)).toMatchObject({ error: { code: "invalid_request" } });

    const reverted = await fetch(`${baseUrl}/api/v1/agents/agent-one/run-defaults`, {
      method: "DELETE",
      headers: { origin: baseUrl },
    });
    expect(reverted.status).toBe(200);
    expect(await json(reverted)).toMatchObject({ agent: { runSettings: {
      override: null,
      effective: { modelSource: "config", effortSource: "config" },
    } } });

    const createdB = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: mutation,
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(await json(createdB)).toMatchObject({ thread: { runModel: null, runEffort: null } });
  });

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
    expect(bootstrap.headers.get("cache-control")).toBe("private, no-cache");
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

  it("compresses large API JSON for clients that negotiate brotli or gzip", async () => {
    const { baseUrl } = await start({ fetchImpl: modelRichAgentFetch() });

    const identity = await rawGet(baseUrl, "/api/v1/bootstrap");
    expect(identity.status).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body.byteLength).toBeGreaterThan(16 * 1024);

    const brotli = await rawGet(baseUrl, "/api/v1/bootstrap", { "accept-encoding": "br" });
    expect(brotli.status).toBe(200);
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.vary).toContain("Accept-Encoding");
    expect(brotli.body.byteLength).toBeLessThan(identity.body.byteLength / 2);
    expect(JSON.parse(brotliDecompressSync(brotli.body).toString("utf8"))).toMatchObject({ version: 1 });

    const gzip = await rawGet(baseUrl, "/api/v1/bootstrap", { "accept-encoding": "gzip" });
    expect(gzip.status).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.body.byteLength).toBeLessThan(identity.body.byteLength / 2);
    expect(JSON.parse(gunzipSync(gzip.body).toString("utf8"))).toMatchObject({ version: 1 });

    // Small payloads stay below the threshold, so the CPU is spent only where it buys bytes.
    const health = await rawGet(baseUrl, "/healthz", { "accept-encoding": "br, gzip" });
    expect(health.status).toBe(200);
    expect(health.headers["content-encoding"]).toBeUndefined();
  });

  it("lets the browser revalidate API JSON instead of forbidding its cache", async () => {
    const { baseUrl } = await start();

    const first = await rawGet(baseUrl, "/api/v1/bootstrap");
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    expect(first.headers.pragma).toBeUndefined();
    const etag = first.headers.etag;
    expect(etag).toEqual(expect.any(String));

    const revalidated = await rawGet(baseUrl, "/api/v1/bootstrap", { "if-none-match": String(etag) });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body.byteLength).toBe(0);

    // The conversation read too, because that is the one a reconnecting console
    // repeats: its resync quotes this validator and pays a status line for a
    // transcript that has not moved.
    const threadId = await createThread(baseUrl, "agent-one");
    const read = await rawGet(baseUrl, `/api/v1/threads/${threadId}`);
    expect(read.status).toBe(200);
    const threadEtag = read.headers.etag;
    expect(threadEtag).toEqual(expect.any(String));
    const unchanged = await rawGet(baseUrl, `/api/v1/threads/${threadId}`, {
      "if-none-match": String(threadEtag),
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body.byteLength).toBe(0);
  });

  it("answers a bootstrap with one agent's bucket and a cursor for the rest of it", async () => {
    // A bootstrap used to carry EVERY agent's conversations -- 187 KB of a
    // 219 KB payload on the fleet -- and the console then re-read the one
    // bucket it actually shows. One bucket is what it now carries.
    const first = fakeDiscoveredAgent();
    const second = fakeDiscoveredAgent({
      source: { ...first.source, sourceId: "agent-two", label: "Agent Two" },
    });
    const { baseUrl } = await start({ host: "127.0.0.1", discoverImpl: async () => [first, second] });
    const one = [
      await createThread(baseUrl, "agent-one"),
      await createThread(baseUrl, "agent-one"),
      await createThread(baseUrl, "agent-one"),
    ];
    const two = await createThread(baseUrl, "agent-two");

    const scoped = await json(await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=agent-one&limit=2`)) as unknown as ScopedBootstrap;
    expect(scoped.threadsSourceId).toBe("agent-one");
    expect(scoped.threads).toHaveLength(2);
    expect(scoped.threads.every((thread) => thread.sourceId === "agent-one")).toBe(true);
    expect(scoped.threads.map((thread) => thread.id)).not.toContain(two);
    expect(scoped.threadsNextCursor).toEqual(expect.any(String));
    // Every agent's summary still travels: the rail shows all of them, and a
    // lazy agents route would put an RTT in front of every switch.
    expect(scoped.agents.map((agent) => agent.sourceId)).toEqual(["agent-one", "agent-two"]);
    expect(scoped.agents[0]).toMatchObject({ updatedAt: expect.any(String), models: expect.any(Array) });

    const rest = await json(await fetch(
      `${baseUrl}/api/v1/threads?sourceId=agent-one&archived=false&before=${encodeURIComponent(String(scoped.threadsNextCursor))}`,
    )) as unknown as { threads: readonly { readonly id: string }[] };
    expect([...scoped.threads.map((thread) => thread.id), ...rest.threads.map((thread) => thread.id)].sort())
      .toEqual([...one].sort());

    const other = await json(await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=agent-two`)) as unknown as ScopedBootstrap;
    expect(other.threadsSourceId).toBe("agent-two");
    expect(other.threads.map((thread) => thread.id)).toEqual([two]);
    expect(other.threadsNextCursor).toBeNull();
  });

  it("serves the archived bucket only when the bootstrap asks for it", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const active = await createThread(baseUrl, "agent-one");
    const archived = await createThread(baseUrl, "agent-one");
    const patched = await fetch(`${baseUrl}/api/v1/threads/${archived}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(patched.status).toBe(200);

    const live = await json(await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=agent-one`)) as unknown as ScopedBootstrap;
    expect(live.threads.map((thread) => thread.id)).toEqual([active]);

    const shelf = await json(await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=agent-one&archived=true`)) as unknown as ScopedBootstrap;
    expect(shelf.threadsSourceId).toBe("agent-one");
    expect(shelf.threads.map((thread) => thread.id)).toEqual([archived]);

    // A console that has not resolved an agent yet sends the parameter empty
    // rather than omitting it; that is an absent bucket, not a bad request.
    const unresolved = await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=`);
    expect(unresolved.status).toBe(200);
    expect(await json(unresolved) as unknown as ScopedBootstrap).toMatchObject({
      threadsSourceId: "agent-one",
    });

    for (const query of ["limit=0", "limit=201", "limit=abc", "archived=sometimes"]) {
      const rejected = await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=agent-one&${query}`);
      expect({ query, status: rejected.status }).toEqual({ query, status: 400 });
    }
  });

  it("pages both the bootstrap bucket and the thread list at fifty rows", async () => {
    // The sidebar shows a handful of rows and pages from there. Both routes
    // used to answer with the whole 200-row per-bucket cap.
    const { baseUrl } = await start({ host: "127.0.0.1" });
    for (let index = 0; index < 51; index += 1) await createThread(baseUrl, "agent-one");

    const bootstrap = await json(await fetch(`${baseUrl}/api/v1/bootstrap?sourceId=agent-one`)) as unknown as ScopedBootstrap;
    expect(bootstrap.threads).toHaveLength(50);
    expect(bootstrap.threadsNextCursor).toEqual(expect.any(String));

    const page = await json(await fetch(`${baseUrl}/api/v1/threads?sourceId=agent-one&archived=false`)) as unknown as {
      threads: readonly unknown[];
      nextCursor?: string;
    };
    expect(page.threads).toHaveLength(50);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("caches hashed assets immutably while the shell and service workers revalidate", async () => {
    const { baseUrl } = await start();

    const asset = await rawGet(baseUrl, "/assets/app-abc123.js", { "accept-encoding": "br" });
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["content-encoding"]).toBe("br");

    for (const path of ["/sw.js", "/workbox-abc.js", "/notification-sw.js"]) {
      const worker = await rawGet(baseUrl, path);
      expect({ path, status: worker.status, cacheControl: worker.headers["cache-control"] })
        .toEqual({ path, status: 200, cacheControl: "no-cache" });
    }

    const shell = await rawGet(baseUrl, "/");
    expect(shell.status).toBe(200);
    expect(shell.headers["cache-control"]).toBe("no-cache");
    const shellEtag = shell.headers.etag;
    expect(shellEtag).toEqual(expect.any(String));

    const route = await rawGet(baseUrl, "/conversations/example");
    expect(route.status).toBe(200);
    expect(route.headers["cache-control"]).toBe("no-cache");

    const revalidated = await rawGet(baseUrl, "/", { "if-none-match": String(shellEtag) });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body.byteLength).toBe(0);
  });

  it("leaves the event stream and attachment bytes untransformed", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });

    const created = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", contentType: "text/plain", sizeBytes: 4096 }),
    });
    const attachment = (await json(created)).attachment as { id: string };
    const bytes = Buffer.alloc(4096, 0x61);
    const uploaded = await fetch(`${baseUrl}/api/v1/uploads/${attachment.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(uploaded.status).toBe(200);

    // Upload bytes are write-once per random id, so the browser may keep them forever;
    // the declared Content-Length has to survive, which rules out transforming them.
    const content = await rawGet(baseUrl, `/api/v1/uploads/${attachment.id}/content`, { "accept-encoding": "br, gzip" });
    expect(content.status).toBe(200);
    expect(content.headers["content-encoding"]).toBeUndefined();
    expect(content.headers["content-length"]).toBe("4096");
    expect(content.headers["cache-control"]).toBe("private, max-age=31536000, immutable, no-transform");
    expect(content.body).toEqual(bytes);

    const stream = await new Promise<{ headers: IncomingHttpHeaders; first: string }>((resolvePromise, reject) => {
      const target = new URL("/api/v1/events", baseUrl);
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { "accept-encoding": "gzip, br" },
      }, (response) => {
        response.once("data", (chunk: Buffer) => {
          const first = chunk.toString("utf8");
          request.destroy();
          resolvePromise({ headers: response.headers, first });
        });
        response.once("error", reject);
      });
      request.once("error", reject);
      request.end();
    });
    expect(stream.headers["content-encoding"]).toBeUndefined();
    expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.first).toContain("event: ready");
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

  it("requires the exact browser origin before granting SELF-CONFIG", async () => {
    const { baseUrl } = await start({
      host: "127.0.0.1",
      configurationHost: {
        supports: () => true,
        create: async () => ({
          configuration: {
            sessionId: "11111111-2222-4333-8444-555555555555",
            conversationId: "web-config-http-test",
            roleLocation: "/tmp/IDENTITY.md -> ## Role",
            initialPrompt: "Open configuration.",
            prompt: "Open configuration.",
            operatorPrompt: "Continue configuration.",
            takeProposal: async () => undefined,
            approve: async () => ({ kind: "applied", message: "Applied." }),
            reject: async () => ({ kind: "rejected", message: "Rejected." }),
            abandon: async () => undefined,
          },
          dispose: async () => undefined,
        }),
      },
    });
    const path = `${baseUrl}/api/v1/agents/agent-one/configuration-sessions`;
    const denied = await fetch(path, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(denied.status).toBe(403);
    const allowed = await fetch(path, { method: "POST", headers: { origin: baseUrl } });
    expect(allowed.status).toBe(201);
    expect((await json(allowed)).session).toMatchObject({
      sourceId: "agent-one",
      status: "active",
    });
  });

  it("authenticates the owner-private notification ingress before reading a large body", async () => {
    const { handle } = await start({ host: "127.0.0.1" });
    const paths = await prepareWebStatePaths({ stateDir: handle.stateDir });
    const ingress = JSON.parse(await readFile(paths.notificationIngress, "utf8")) as { url: string };
    const response = await fetch(ingress.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(8 * 1024 * 1024 + 1) }),
    });
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: { code: "unauthorized" } });
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
    // The client rejects a reply attachment whose Content-Length disagrees with the
    // declared size, so this body must never be compressed away from its length.
    // Cacheable for exactly as long as the key in its URL is good for: the URL
    // is stable for a five-minute bucket now, so a picture the operator scrolls
    // past twice is fetched once. `no-store` would have made that impossible.
    const cacheControl = download.headers.get("cache-control") ?? "";
    expect(cacheControl).toMatch(/^private, max-age=\d+, no-transform$/u);
    const maxAge = Number(/max-age=(\d+)/u.exec(cacheControl)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(10 * 60);
    expect(download.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(download.headers.get("content-encoding")).toBeNull();
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

  it("persists per-thread model and effort overrides and round-trips them unset and nulled", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    expect((await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`))).thread).toMatchObject({
      id: thread.id,
      runModel: null,
      runEffort: null,
    });

    const patched = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic:claude-sonnet-5", effort: "high" }),
    });
    expect(patched.status).toBe(200);
    expect((await json(patched)).thread).toMatchObject({ id: thread.id, runModel: "anthropic:claude-sonnet-5", runEffort: "high" });
    expect((await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`))).thread).toMatchObject({
      runModel: "anthropic:claude-sonnet-5",
      runEffort: "high",
    });

    const modelOnly = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "provider/fallback" }),
    });
    expect((await json(modelOnly)).thread).toMatchObject({ runModel: "provider/fallback", runEffort: "high" });

    const cleared = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: null, effort: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await json(cleared)).thread).toMatchObject({ runModel: null, runEffort: null });
    const reopened = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
    expect((reopened.thread as { runModel: string | null }).runModel).toBeNull();
  });

  it("rejects an empty thread patch and non-string model or effort overrides", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };

    const empty = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(await json(empty)).toMatchObject({ error: { code: "invalid_request", message: "Provide title, archived, model, or effort." } });

    const numericModel = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: 7 }),
    });
    expect(numericModel.status).toBe(400);
    expect(await json(numericModel)).toMatchObject({ error: { code: "invalid_request", message: "model must be a non-empty string of at most 120 characters." } });

    const overlongEffort = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "x".repeat(121) }),
    });
    expect(overlongEffort.status).toBe(400);

    // The compare-and-set flag is a boolean or nothing: a truthy string would
    // otherwise silently arm a precondition the caller never asked for.
    const badCondition = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic:opus-5", ifRunConfigUnset: "yes" }),
    });
    expect(badCondition.status).toBe(400);
    expect(await json(badCondition)).toMatchObject({
      error: { code: "invalid_request", message: "ifRunConfigUnset must be boolean." },
    });
  });

  it("serves the conditional run-config patch end to end", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const patch = async (body: Record<string, unknown>) => json(await fetch(
      `${baseUrl}/api/v1/threads/${thread.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ));

    expect((await patch({ model: "anthropic:opus-5", ifRunConfigUnset: true })).thread)
      .toMatchObject({ runModel: "anthropic:opus-5" });
    // The second adopter loses and is handed the winner to adopt.
    expect((await patch({ model: "anthropic:sonnet-5", effort: "low", ifRunConfigUnset: true })).thread)
      .toMatchObject({ runModel: "anthropic:opus-5", runEffort: null });
  });

  it("keeps legacy title and archive patches serving unchanged alongside override clearing", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    const renamed = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Server rename" }),
    });
    expect((await json(renamed)).thread).toMatchObject({ title: "Server rename" });
    const archived = await fetch(`${baseUrl}/api/v1/threads/${thread.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
    });
    const archivedThread = (await json(archived)).thread as { archivedAt: string | null };
    expect(archivedThread.archivedAt).not.toBeNull();
  });

  it("searches conversation text through a route the :id parameter cannot swallow", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    const thread = (await json(created)).thread as { id: string };
    await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "reindex the tailscale exporter" }),
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = await json(await fetch(`${baseUrl}/api/v1/threads/${thread.id}`));
      if ((detail.thread as { runState?: { status?: string } }).runState?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    const searched = await fetch(
      `${baseUrl}/api/v1/threads/search?sourceId=agent-one&q=tailscale`,
    );

    expect(searched.status).toBe(200);
    const page = await json(searched) as {
      hits: Array<{ thread: { id: string }; snippet?: string; messageMatches: number }>;
      truncated: boolean;
    };
    // "search" resolves to this route rather than being read as a thread id,
    // which would otherwise 404 through GET /api/v1/threads/:id.
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]?.thread.id).toBe(thread.id);
    expect(page.hits[0]?.snippet).toContain("tailscale");
    expect(page.truncated).toBe(false);
  });

  it("rejects a model-catalog request that mixes the two mutually exclusive modes", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });

    // The agent services `provider` and ignores `query`, so a request carrying
    // both would answer a search it never ran. Proxying that rejection turns
    // the caller's mistake into a 502 `agent_http_error` against the agent.
    const both = await fetch(`${baseUrl}/api/v1/agents/agent-one/models?provider=anthropic&q=opus`);
    expect(both.status).toBe(400);
    expect(await json(both)).toMatchObject({ error: { code: "invalid_page" } });

    const providerOnly = await fetch(`${baseUrl}/api/v1/agents/agent-one/models?provider=provider`);
    expect(providerOnly.status).toBe(200);
  });

  it("validates the search query string and bounds its page size", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });

    const missingSource = await fetch(`${baseUrl}/api/v1/threads/search?q=anything`);
    expect(missingSource.status).toBe(400);
    expect(await json(missingSource)).toMatchObject({ error: { code: "invalid_page" } });

    const unknownAgent = await fetch(`${baseUrl}/api/v1/threads/search?sourceId=ghost&q=anything`);
    expect(unknownAgent.status).toBe(404);
    expect(await json(unknownAgent)).toMatchObject({ error: { code: "agent_not_found" } });

    // A one-character or absent query is answered rather than rejected: the box
    // is typed into character by character.
    for (const query of ["", "a"]) {
      const short = await fetch(
        `${baseUrl}/api/v1/threads/search?sourceId=agent-one&q=${query}`,
      );
      expect(short.status).toBe(200);
      expect(await json(short)).toEqual({ hits: [], truncated: false });
    }

    // Bounded exactly like every other paginated route: an over-max limit is a
    // client error rather than a silent clamp.
    const overLimit = await fetch(
      `${baseUrl}/api/v1/threads/search?sourceId=agent-one&q=anything&limit=5000`,
    );
    expect(overLimit.status).toBe(400);
    expect(await json(overLimit)).toMatchObject({ error: { code: "invalid_page" } });

    const withinLimit = await fetch(
      `${baseUrl}/api/v1/threads/search?sourceId=agent-one&q=anything&limit=5`,
    );
    expect(withinLimit.status).toBe(200);
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

  it("keeps one SSE stream open across compact invalidations for a model-rich agent", async () => {
    const { baseUrl } = await start({ fetchImpl: modelRichAgentFetch() });
    const bootstrap = await (await fetch(`${baseUrl}/api/v1/bootstrap`)).json() as { agents: unknown[] };
    expect(Buffer.byteLength(JSON.stringify({ agents: bootstrap.agents }), "utf8")).toBeGreaterThan(16 * 1024);

    const stream = await fetch(`${baseUrl}/api/v1/events`);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const nextEvent = sseEventReader(reader);
    expect(await nextEvent()).toMatchObject({ type: "ready" });

    for (const pinned of [true, false]) {
      const patch = await fetch(`${baseUrl}/api/v1/agents/agent-one`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
      expect(patch.status).toBe(200);
      // The tab that pinned already holds this from the PATCH response, and
      // every other tab can apply it without a bootstrap. Only discovery-driven
      // invalidations stay payload-less.
      expect(await nextEvent()).toMatchObject({
        type: "agents.changed",
        payload: { sourceId: "agent-one", pinned },
      });
    }
    await reader.cancel();
  });

  /**
   * A conversation shaped like the ones that made a thread read cost 231 KB:
   * three 20 KB tool results and a mixed run of provider telemetry.
   */
  function toolHeavyAgentFetch(): typeof fetch {
    const body = "R".repeat(20 * 1_024);
    const telemetry = [
      { type: "provider_status", provider: "anthropic", detail: "d".repeat(600) },
      { type: "memory_recalled", entries: ["m".repeat(600)] },
      { type: "runtime_telemetry", kind: "run_config", data: { model: "provider/default", effort: "high", raw: "r".repeat(600) } },
      { type: "runtime_telemetry", kind: "cache_hit", data: { hits: 3, detail: "c".repeat(600) } },
      { type: "capabilities_resolved", capabilities: { tools: Array.from({ length: 40 }, (_unused, index) => `tool-${String(index)}`) } },
      { type: "provider_bridge_latency", ms: 12, samples: Array.from({ length: 100 }, (_unused, index) => index) },
      { type: "runtime_warning", message: "w".repeat(600) },
      { type: "runtime_telemetry", kind: "assistant_message_boundary", data: { kind: "assistant_message_boundary" } },
      { type: "usage_update", data: { tokens: { input: 1_000, output: 200 }, cost: 0.02 } },
      { type: "runtime_telemetry", kind: "context_usage", data: { used: 12_000, contextWindow: 200_000 } },
    ];
    return operatorFetch({
      turns: () => [
        ...[0, 1, 2].flatMap((index) => [
          JSON.stringify({ kind: "event", event: { type: "tool_call_started", id: `call-${String(index)}`, name: "Exec", arguments: { command: `run ${String(index)}` } } }),
          JSON.stringify({ kind: "event", event: { type: "tool_call_completed", id: `call-${String(index)}`, name: "Exec", content: body } }),
        ]),
        ...telemetry.map((event) => JSON.stringify({ kind: "event", event })),
        JSON.stringify({ kind: "finish", finalText: "answer" }),
        "",
      ].join("\n"),
    });
  }

  async function settleTurn(baseUrl: string, threadId: string, text: string): Promise<Record<string, unknown>> {
    const started = await fetch(`${baseUrl}/api/v1/threads/${threadId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(started.status).toBe(202);
    let detail: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 300; attempt += 1) {
      detail = await json(await fetch(`${baseUrl}/api/v1/threads/${threadId}`));
      if ((detail.thread as { runState?: { status?: string } }).runState?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(detail).toMatchObject({ thread: { runState: { status: "complete" } } });
    return detail;
  }

  interface WireMessage {
    readonly id: string;
    readonly parts: readonly Record<string, unknown>[];
  }

  const wireMessages = (detail: Record<string, unknown>): readonly WireMessage[] =>
    detail.messages as readonly WireMessage[];

  it("answers a bootstrap with one bucket, not with every agent's listing", async () => {
    // The bootstrap used to carry every `(sourceId, archived)` bucket in full.
    // This is the guard against that coming back: one named bucket, one page of
    // it, and a body a fraction of what all three listings cost together.
    const agents = ["agent-one", "agent-two", "agent-three"].map((sourceId) => ({
      ...fakeDiscoveredAgent(),
      source: { ...fakeDiscoveredAgent().source, sourceId, label: `Agent ${sourceId}` },
    }));
    const { baseUrl } = await start({ discoverImpl: async () => agents });
    for (const agent of agents) {
      for (let index = 0; index < 60; index += 1) await createThread(baseUrl, agent.source.sourceId);
    }

    const scoped = await rawGet(baseUrl, "/api/v1/bootstrap?sourceId=agent-one&limit=50");
    const listings = await Promise.all(agents.map(async (agent) =>
      rawGet(baseUrl, `/api/v1/threads?sourceId=${agent.source.sourceId}&archived=false&limit=200`)));
    const everyBucket = listings.reduce((sum, listing) => sum + listing.body.length, 0);

    const body = JSON.parse(scoped.body.toString("utf8")) as ScopedBootstrap;
    expect(body.threadsSourceId).toBe("agent-one");
    expect(body.threads).toHaveLength(50);
    expect(body.threads.every((thread) => thread.sourceId === "agent-one")).toBe(true);
    expect(body.threadsNextCursor).toEqual(expect.any(String));
    // 180 rows across three buckets against one page of 50 from one of them.
    // Measured: 18,480 B against 57,039 B, a factor of 3.1. A bootstrap that
    // went back to carrying every bucket would be ~59.6 KB -- the same rows plus
    // its own agents/limits/push overhead -- a factor of about 1. The boundary
    // sits at 2 so both sides have most of a factor of margin, and a row growing
    // a field cannot trip it.
    // Anti-vacuity, derived from the fixture rather than from a measured byte
    // count: 180 conversation rows cannot serialise in under 200 bytes each,
    // whatever a summary grows or loses.
    expect(everyBucket).toBeGreaterThan(agents.length * 60 * 200);
    expect(scoped.body.length).toBeLessThan(everyBucket / 2);
  });

  it("puts a tool-heavy conversation on a diet, and serves the whole thing on request", async () => {
    const { baseUrl } = await start({ fetchImpl: toolHeavyAgentFetch() });
    const threadId = await createThread(baseUrl, "agent-one");
    await settleTurn(baseUrl, threadId, "go");

    const shaped = await rawGet(baseUrl, `/api/v1/threads/${threadId}`, { "accept-encoding": "br" });
    const whole = await rawGet(baseUrl, `/api/v1/threads/${threadId}?full=1`, { "accept-encoding": "br" });
    const shapedRaw = await rawGet(baseUrl, `/api/v1/threads/${threadId}`);
    const wholeRaw = await rawGet(baseUrl, `/api/v1/threads/${threadId}?full=1`);
    expect(shaped.headers["content-encoding"]).toBe("br");
    // Three 20 KB bodies and ten telemetry payloads leave the wire; what is left
    // is three 4 KB previews plus the parts that stayed whole.
    expect(wholeRaw.body.length).toBeGreaterThan(60 * 1_024);
    expect(shapedRaw.body.length).toBeLessThan(wholeRaw.body.length / 4);
    expect(shaped.body.length).toBeLessThan(whole.body.length);

    const shapedDetail = JSON.parse(brotliDecompressSync(shaped.body).toString("utf8")) as Record<string, unknown>;
    const wholeDetail = JSON.parse(brotliDecompressSync(whole.body).toString("utf8")) as Record<string, unknown>;
    const shapedParts = wireMessages(shapedDetail).at(-1)?.parts ?? [];
    const wholeParts = wireMessages(wholeDetail).at(-1)?.parts ?? [];
    // No part is dropped, at either size: only payloads change.
    expect(shapedParts.map((part) => part.type)).toEqual(wholeParts.map((part) => part.type));
    expect(shapedParts.filter((part) => part.type === "tool-call")).toHaveLength(3);
    expect(shapedParts.filter((part) => part.resultTruncated === true)).toHaveLength(3);
    expect(wholeParts.filter((part) => part.resultTruncated === true)).toHaveLength(0);
    // `usage_update`, `context_usage` and `assistant_message_boundary` keep
    // their payloads; the other seven diagnostics keep only their identity.
    expect(shapedParts.filter((part) => part.type === "telemetry" && part.data === undefined)).toHaveLength(7);
    expect(wholeParts.filter((part) => part.type === "telemetry" && part.data === undefined)).toHaveLength(0);
  });

  it("serves one tool call's whole body, and refuses one that is not in the conversation asked for", async () => {
    const { baseUrl } = await start({ fetchImpl: toolHeavyAgentFetch() });
    const threadId = await createThread(baseUrl, "agent-one");
    const detail = await settleTurn(baseUrl, threadId, "go");
    const message = wireMessages(detail).at(-1);
    if (message === undefined) throw new Error("Expected an assistant message.");
    const other = await createThread(baseUrl, "agent-one");

    const found = await fetch(`${baseUrl}/api/v1/threads/${threadId}/messages/${message.id}/tool-calls/call-1`);
    expect(found.status).toBe(200);
    const part = (await json(found)).part as Record<string, unknown>;
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "Exec",
      result: "R".repeat(20 * 1_024),
    });
    expect(part).not.toHaveProperty("resultTruncated");

    for (const path of [
      `/api/v1/threads/${threadId}/messages/${message.id}/tool-calls/missing`,
      `/api/v1/threads/${threadId}/messages/no-such-message/tool-calls/call-1`,
      `/api/v1/threads/${other}/messages/${message.id}/tool-calls/call-1`,
    ]) {
      const refused = await fetch(`${baseUrl}${path}`);
      expect(refused.status).toBe(404);
      expect(await json(refused)).toMatchObject({ error: { code: "tool_call_not_found" } });
    }
  });

  it("streams content for the conversation a console subscribed to and hints for everything else", async () => {
    const lines = [
      JSON.stringify({ kind: "append", delta: "hello " }),
      JSON.stringify({ kind: "append", delta: "world" }),
      JSON.stringify({ kind: "finish", finalText: "hello world" }),
      "",
    ];
    const { baseUrl } = await start({ fetchImpl: operatorFetch({ turns: () => lines.join("\n") }) });
    const threadId = await createThread(baseUrl, "agent-one");
    const otherId = await createThread(baseUrl, "agent-one");

    const subscribed = await fetch(`${baseUrl}/api/v1/events?thread=${encodeURIComponent(threadId)}`);
    const unsubscribed = await fetch(`${baseUrl}/api/v1/events`);
    const subscribedReader = subscribed.body?.getReader();
    const unsubscribedReader = unsubscribed.body?.getReader();
    if (subscribedReader === undefined || unsubscribedReader === undefined) {
      throw new Error("Expected two SSE response bodies.");
    }
    const nextSubscribed = sseEventReader(subscribedReader);
    const nextUnsubscribed = sseEventReader(unsubscribedReader);
    expect(await nextSubscribed()).toMatchObject({ type: "ready" });
    expect(await nextUnsubscribed()).toMatchObject({ type: "ready" });

    await settleTurn(baseUrl, threadId, "go");
    const streamed = await drainTurn(nextSubscribed);
    const hinted = await drainTurn(nextUnsubscribed);

    // The subscribed console is served what changed. The one hint it gets is
    // the turn's own start naming the operator's row, which nothing else
    // announces -- every write after it travels as content.
    const deltas = streamed.filter((event) => event.type === "message.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const startHint = streamed.filter((event) => event.type === "message.changed");
    expect(startHint).toHaveLength(1);
    expect(streamed.indexOf(startHint[0]!)).toBeLessThan(streamed.indexOf(deltas[0]!));
    for (const event of deltas) {
      expect(event.threadId).toBe(threadId);
      expect(event.payload).toMatchObject({
        messageId: expect.any(String),
        baseSeq: expect.any(Number),
        seq: expect.any(Number),
        status: expect.any(String),
        ops: expect.any(Array),
      });
    }

    // Every other console keeps the invalidation it already understands, and the
    // two writes above reach it as ONE hint rather than one per flush.
    expect(hinted.filter((event) => event.type === "message.delta")).toEqual([]);
    const hints = hinted.filter((event) => event.type === "message.changed");
    // Told about it, and never more often than the writes themselves. How many
    // writes actually land inside one DELTA_HINT_INTERVAL_MS is a property of
    // the machine, not of this code, so the limit itself is proven against a
    // fake clock in the `web event dispatch` suite instead.
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.length).toBeLessThanOrEqual(deltas.length);
    expect(hints[0]?.payload).toEqual({ messageId: expect.any(String), updatedAt: expect.any(String) });

    // A delta for a conversation this console is NOT in is downgraded too.
    await settleTurn(baseUrl, otherId, "elsewhere");
    const elsewhere = await drainTurn(nextSubscribed);
    expect(elsewhere.filter((event) => event.type === "message.delta")).toEqual([]);
    const elsewhereHints = elsewhere.filter((event) => event.type === "message.changed");
    // Same reason: that this collapses to exactly one frame is the fake-clock
    // suite's assertion, not a race this fixture should be running.
    expect(elsewhereHints.length).toBeGreaterThanOrEqual(1);
    expect(elsewhereHints.every((event) => event.threadId === otherId)).toBe(true);

    await Promise.all([subscribedReader.cancel(), unsubscribedReader.cancel()]);
  });

  it("rejects a conversation subscription that names nothing usable", async () => {
    const { baseUrl } = await start();
    // Oversized, empty and blank alike: a console that asked for a conversation
    // and silently got none would read as a delta stream that had stopped.
    for (const query of [
      `thread=${"t".repeat(600)}`,
      "thread=",
      "thread=%20%20",
      // Padding around an id that is over the cap on its own.
      `thread=%20${"t".repeat(600)}%20`,
    ]) {
      const refused = await fetch(`${baseUrl}/api/v1/events?${query}`);
      expect(refused.status).toBe(400);
      expect(await json(refused)).toMatchObject({ error: { code: "invalid_subscription" } });
    }

    // The TRIMMED id is what the subscription becomes, so it is what the bound
    // is about: an id exactly at the cap is admissible however it was padded.
    const padded = await fetch(`${baseUrl}/api/v1/events?thread=%20${"t".repeat(512)}%20`);
    expect(padded.status).toBe(200);
    await padded.body?.cancel();
  });

  it("subscribes a console that padded its conversation id, and one that named a superseded one", async () => {
    const lines = [
      JSON.stringify({ kind: "append", delta: "hello " }),
      JSON.stringify({ kind: "append", delta: "world" }),
      JSON.stringify({ kind: "finish", finalText: "hello world" }),
      "",
    ];
    const { baseUrl, root } = await start({ fetchImpl: operatorFetch({ turns: () => lines.join("\n") }) });
    const threadId = await createThread(baseUrl, "agent-one");
    // The row the cron-channel adoption writes when it merges legacy
    // notification conversations into one: the old id still reaches the
    // conversation, and a console that stored it subscribes with it.
    const database = new DatabaseSync(join(root, "state", "state.sqlite"));
    database.prepare(
      "INSERT INTO thread_redirects (old_thread_id, new_thread_id, created_at) VALUES (?, ?, ?)",
    ).run("legacy-thread", threadId, new Date().toISOString());
    database.close();

    // Padded, and superseded: both name this conversation, and a subscription
    // that silently matched neither would read as a delta stream that stopped.
    const padded = await fetch(`${baseUrl}/api/v1/events?thread=${encodeURIComponent(`  ${threadId}  `)}`);
    const superseded = await fetch(`${baseUrl}/api/v1/events?thread=legacy-thread`);
    const paddedReader = padded.body?.getReader();
    const supersededReader = superseded.body?.getReader();
    if (paddedReader === undefined || supersededReader === undefined) {
      throw new Error("Expected two SSE response bodies.");
    }
    const nextPadded = sseEventReader(paddedReader);
    const nextSuperseded = sseEventReader(supersededReader);
    expect(await nextPadded()).toMatchObject({ type: "ready" });
    expect(await nextSuperseded()).toMatchObject({ type: "ready" });

    await settleTurn(baseUrl, threadId, "go");
    for (const next of [nextPadded, nextSuperseded]) {
      const streamed = await drainTurn(next);
      const deltas = streamed.filter((event) => event.type === "message.delta");
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas.every((event) => event.threadId === threadId)).toBe(true);
      // The turn's start names the operator's row; nothing here is a downgrade.
      const hints = streamed.filter((event) => event.type === "message.changed");
      expect(hints).toHaveLength(1);
      expect(hints.every((event) => event.threadId === threadId)).toBe(true);
    }

    await Promise.all([paddedReader.cancel(), supersededReader.cancel()]);
  });

  it("says when the turn finished on the delta that finishes it", async () => {
    const lines = [
      JSON.stringify({ kind: "append", delta: "hello " }),
      JSON.stringify({ kind: "append", delta: "world" }),
      JSON.stringify({ kind: "finish", finalText: "hello world" }),
      "",
    ];
    const { baseUrl } = await start({ fetchImpl: operatorFetch({ turns: () => lines.join("\n") }) });
    const threadId = await createThread(baseUrl, "agent-one");
    const stream = await fetch(`${baseUrl}/api/v1/events?thread=${encodeURIComponent(threadId)}`);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const next = sseEventReader(reader);
    expect(await next()).toMatchObject({ type: "ready" });

    const detail = await settleTurn(baseUrl, threadId, "go");
    const streamed = await drainTurn(next);
    const deltas = streamed.filter((event) => event.type === "message.delta");
    const message = wireMessages(detail).at(-1) as (WireMessage & { readonly finishedAt?: string }) | undefined;
    expect(message?.finishedAt).toBeTypeOf("string");

    // The turn's wall-clock window is what the Activity header draws, and
    // `createdAt` is only half of it. Carried here, a subscribed console no
    // longer buys a whole-conversation read at every turn finish to learn the
    // other half.
    const finish = deltas.at(-1);
    expect(finish?.payload).toMatchObject({ status: "complete", finishedAt: message?.finishedAt });
    // And only there: a delta written while the turn is still running has no
    // finish to report.
    for (const delta of deltas.slice(0, -1)) {
      expect(delta.payload).not.toHaveProperty("finishedAt");
    }

    await reader.cancel();
  });

  /**
   * A conversation with a tool-heavy turn already in it, whose NEXT turn streams
   * a long prose answer -- the shape that made this stream expensive: every
   * flush invalidated a transcript that had nothing to do with the few
   * characters that had arrived.
   */
  function historyThenStreamedAnswerFetch(): typeof fetch {
    const answer = `${"word ".repeat(400)}end`;
    let turn = 0;
    const heavy = toolHeavyAgentFetch();
    return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/v1/turns")) return heavy(input, init);
      turn += 1;
      if (turn === 1) return heavy(input, init);
      return operatorFetch({
        turns: () => [
          ...answer.split(" ").map((word) => JSON.stringify({ kind: "append", delta: `${word} ` })),
          JSON.stringify({ kind: "finish", finalText: answer }),
          "",
        ].join("\n"),
      })(input, init);
    }) as typeof fetch;
  }

  it("costs a subscribed console what changed, not the conversation once per write", async () => {
    const { baseUrl } = await start({ fetchImpl: historyThenStreamedAnswerFetch() });
    const threadId = await createThread(baseUrl, "agent-one");
    // One tool-heavy turn of history, so a re-read is nothing like the size of
    // the write that provokes it.
    await settleTurn(baseUrl, threadId, "first");

    const stream = await fetch(`${baseUrl}/api/v1/events?thread=${encodeURIComponent(threadId)}`);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    let streamBytes = 0;
    const next = sseEventReader(reader, (count) => { streamBytes += count; });
    expect(await next()).toMatchObject({ type: "ready" });
    const readyBytes = streamBytes;

    await settleTurn(baseUrl, threadId, "second");
    const streamed = await drainTurn(next);
    const deltas = streamed.filter((event) => event.type === "message.delta");
    const turnBytes = streamBytes - readyBytes;

    // What the same turn costs a console that answers each write by re-reading
    // the conversation it is looking at.
    const read = await rawGet(baseUrl, `/api/v1/threads/${threadId}`);
    expect(read.status).toBe(200);
    expect(read.body.length).toBeGreaterThan(10 * 1_024);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    // One frame, naming the operator's own row at the turn's start.
    expect(streamed.filter((event) => event.type === "message.changed")).toHaveLength(1);
    // The whole turn -- deltas, run state and both conversation summaries --
    // costs less than ONE of the re-reads it replaces, of which there would
    // have been one per write.
    expect(turnBytes).toBeLessThan(read.body.length / 2);

    await reader.cancel();
  });

  it("answers a message read with the version the delta stream last named", async () => {
    const { baseUrl } = await start({ fetchImpl: toolHeavyAgentFetch() });
    const threadId = await createThread(baseUrl, "agent-one");
    const other = await createThread(baseUrl, "agent-one");
    const stream = await fetch(`${baseUrl}/api/v1/events?thread=${encodeURIComponent(threadId)}`);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const next = sseEventReader(reader);
    expect(await next()).toMatchObject({ type: "ready" });

    const detail = await settleTurn(baseUrl, threadId, "go");
    const message = wireMessages(detail).at(-1);
    if (message === undefined) throw new Error("Expected an assistant message.");
    const streamed = await drainTurn(next);
    const seq = streamed
      .filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { readonly seq: number }).seq)
      .at(-1);
    expect(seq).toBeTypeOf("number");

    // The recovery a console reaches for when a delta no longer chains: the one
    // message, at the version the stream just named.
    const found = await fetch(`${baseUrl}/api/v1/threads/${threadId}/messages/${message.id}`);
    expect(found.status).toBe(200);
    const shaped = (await json(found)).message as WireMessage & { readonly seq: number };
    expect(shaped.id).toBe(message.id);
    expect(shaped.seq).toBe(seq);
    expect(shaped.parts.filter((part) => part.resultTruncated === true)).toHaveLength(3);

    const whole = (await json(await fetch(
      `${baseUrl}/api/v1/threads/${threadId}/messages/${message.id}?full=1`,
    ))).message as WireMessage & { readonly seq: number };
    expect(whole.seq).toBe(seq);
    expect(whole.parts.filter((part) => part.resultTruncated === true)).toHaveLength(0);
    expect(whole.parts.find((part) => part.type === "tool-call")).toMatchObject({
      result: "R".repeat(20 * 1_024),
    });

    // A message id is not a capability: it answers only inside its own conversation.
    for (const path of [
      `/api/v1/threads/${threadId}/messages/no-such-message`,
      `/api/v1/threads/${other}/messages/${message.id}`,
    ]) {
      const refused = await fetch(`${baseUrl}${path}`);
      expect(refused.status).toBe(404);
      expect(await json(refused)).toMatchObject({ error: { code: "message_not_found" } });
    }
    await reader.cancel();
  });

  it("answers a conversation and its message page with one screenful by default", async () => {
    const { baseUrl } = await start();
    const threadId = await createThread(baseUrl, "agent-one");
    for (let index = 0; index < 20; index += 1) {
      await settleTurn(baseUrl, threadId, `turn ${String(index)}`);
    }

    const detail = await json(await fetch(`${baseUrl}/api/v1/threads/${threadId}`));
    expect(wireMessages(detail)).toHaveLength(30);
    expect(detail.messagesNextCursor).toBeTypeOf("string");

    const page = await json(await fetch(`${baseUrl}/api/v1/threads/${threadId}/messages`));
    expect(page.messages as unknown[]).toHaveLength(30);
    expect(page.nextCursor).toBeTypeOf("string");
    const explicit = await json(await fetch(`${baseUrl}/api/v1/threads/${threadId}/messages?limit=100`));
    expect(explicit.messages as unknown[]).toHaveLength(40);
    expect((await fetch(`${baseUrl}/api/v1/threads/${threadId}/messages?limit=101`)).status).toBe(400);
  });

  it("stays silent about what discovery changed", async () => {
    let discovered = [fakeDiscoveredAgent()];
    const { baseUrl } = await start({ discoveryIntervalMs: 25, discoverImpl: async () => discovered });
    const stream = await fetch(`${baseUrl}/api/v1/events`);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const nextEvent = sseEventReader(reader);
    expect(await nextEvent()).toMatchObject({ type: "ready" });

    // An agent that appeared, went away, or advertises something different can
    // have changed anything at all, so this one still invalidates the snapshot.
    discovered = [
      fakeDiscoveredAgent(),
      fakeDiscoveredAgent({ source: { ...fakeDiscoveredAgent().source, sourceId: "agent-two", label: "Agent Two" } }),
    ];
    for (;;) {
      const event = await nextEvent();
      if (event.type !== "agents.changed") continue;
      expect(event).not.toHaveProperty("payload");
      break;
    }
    await reader.cancel();
  });
});

function sseEventReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onBytes?: (count: number) => void,
): () => Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) return JSON.parse(data.slice(6)) as Record<string, unknown>;
        continue;
      }
      const chunk = await readSseChunk(reader);
      if (chunk.done) throw new Error("SSE stream ended before the next event.");
      onBytes?.(chunk.value?.byteLength ?? 0);
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
}

/**
 * Everything one settling turn put on a stream, up to the conversation summary
 * the finish emits. `threads.changed` is no boundary: a turn emits one when it
 * STARTS too.
 */
async function drainTurn(
  next: () => Promise<Record<string, unknown>>,
): Promise<readonly Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (;;) {
    const event = await next();
    events.push(event);
    if (event.type === "thread.changed") return events;
  }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for the next SSE event.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/**
 * The per-connection view of the event stream, exercised without a socket.
 *
 * Neither of the two things that matter here is observable through an HTTP
 * fixture: the rate limit is a clock decision, and a frame a connection cannot
 * write must close it rather than leave a socket that reads live.
 */
describe("web event dispatch", () => {
  const AT = "2026-09-05T10:00:00.000Z";

  function event(type: WebEvent["type"], threadId: string, payload: unknown): WebEvent {
    return { id: `${type}:${threadId}`, version: WEB_API_VERSION, type, at: AT, threadId, payload };
  }
  function delta(seq: number): Record<string, unknown> {
    return { messageId: "m1", baseSeq: seq - 1, seq, status: "running", updatedAt: AT, ops: [] };
  }
  function changed(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { messageId: "m1", updatedAt: AT, ...extra };
  }

  interface Harness {
    readonly send: (event: WebEvent) => boolean;
    readonly written: WebEvent[];
    readonly closes: () => number;
    advance: (ms: number) => void;
  }

  function harness(subscribed?: string, write?: (event: WebEvent) => boolean): Harness {
    const written: WebEvent[] = [];
    let closes = 0;
    let clock = 1_000;
    const send = createWebEventDispatch({
      ...(subscribed === undefined ? {} : { subscribed }),
      write: write ?? ((event) => { written.push(event); return true; }),
      close: () => { closes += 1; },
      now: () => clock,
    });
    return {
      send,
      written,
      closes: () => closes,
      advance: (ms: number) => { clock += ms; },
    };
  }

  it("serves everything about the conversation a console named, unthrottled", async () => {
    const stream = harness("thread-1");
    // Content, the delta path declining, and an ordinary reconciliation: all
    // three are things the console rendering this conversation must act on.
    expect(stream.send(event("message.delta", "thread-1", delta(1)))).toBe(true);
    expect(stream.send(event("message.changed", "thread-1", changed({ deltaDeclined: true })))).toBe(true);
    expect(stream.send(event("message.changed", "thread-1", changed()))).toBe(true);
    expect(stream.send(event("turn.changed", "thread-1", { turn: { status: "running" } }))).toBe(true);

    expect(stream.written.map((written) => written.type)).toEqual([
      "message.delta",
      "message.changed",
      "message.changed",
      "turn.changed",
    ]);
    expect(stream.written[0]?.payload).toEqual(delta(1));
    // `deltaDeclined` is the stream layer's own signal and never reaches a browser.
    expect(stream.written[1]?.payload).toEqual({ messageId: "m1", updatedAt: AT });
  });

  it("gives a downgraded frame an id of its own", async () => {
    // `id:` is what names an SSE frame on the wire, and a `message.delta`
    // reduced to a hint is a different frame of a different type carrying a
    // different payload. It went out under the delta's own id, so one id named
    // two frames -- and a console that deduplicated by id would drop the one it
    // needed.
    const stream = harness("thread-1");
    stream.send(event("message.delta", "other", delta(1)));
    stream.advance(1_000);
    stream.send(event("message.delta", "other", delta(2)));
    stream.send(event("turn.changed", "thread-1", { turn: { status: "running" } }));

    const downgraded = stream.written.filter((written) => written.type === "message.changed");
    expect(downgraded).toHaveLength(2);
    for (const written of downgraded) {
      expect(written.id).not.toBe("message.delta:other");
      // Still traceable to the frame it was cut from.
      expect(written.id).toContain("message.delta:other");
    }
    const ids = stream.written.map((written) => written.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A frame that passes through untouched keeps the id the service gave it.
    expect(stream.written.at(-1)?.id).toBe("turn.changed:thread-1");
  });

  it("rate-limits a conversation the console did not name to one frame a second", async () => {
    const stream = harness("thread-1");
    expect(stream.send(event("message.delta", "other", delta(1)))).toBe(true);
    expect(stream.send(event("message.delta", "other", delta(2)))).toBe(true);
    expect(stream.send(event("message.changed", "other", changed()))).toBe(true);
    // Dropped, not queued.
    expect(stream.written).toHaveLength(1);
    expect(stream.written[0]).toMatchObject({
      type: "message.changed",
      threadId: "other",
      payload: { messageId: "m1", updatedAt: AT },
    });

    stream.advance(1_000);
    stream.send(event("message.delta", "other", delta(3)));
    expect(stream.written).toHaveLength(2);
    // A different conversation has its own budget.
    stream.send(event("message.delta", "third", delta(1)));
    expect(stream.written).toHaveLength(3);
  });

  it("keeps every reconciliation for a console that named no conversation, and bounds only the delta path", async () => {
    const stream = harness();
    // This console may well be looking at the conversation, and nothing else
    // will tell it that a live-input offer or a job card moved.
    stream.send(event("message.changed", "thread-1", changed()));
    stream.send(event("message.changed", "thread-1", changed()));
    expect(stream.written).toHaveLength(2);

    // The write-rate traffic is the whole reason the limit exists, and a
    // declined delta is exactly that traffic wearing the other event's name.
    stream.send(event("message.delta", "thread-1", delta(1)));
    stream.send(event("message.changed", "thread-1", changed({ deltaDeclined: true })));
    stream.send(event("message.delta", "thread-1", delta(2)));
    expect(stream.written).toHaveLength(3);
    expect(stream.written[2]?.type).toBe("message.changed");
    expect(stream.written[2]?.payload).toEqual({ messageId: "m1", updatedAt: AT });
  });

  it("bounds what one connection remembers, dropping the conversation it heard about longest ago", async () => {
    // A burst wider than the bound inside a single tick would otherwise grow
    // the map faster than the window can retire it, on a server that runs for
    // weeks. Three hundred conversations at one instant, then the two ends.
    const stream = harness();
    for (let index = 0; index < 300; index += 1) {
      stream.send(event("message.delta", `thread-${String(index)}`, delta(1)));
    }
    expect(stream.written).toHaveLength(300);

    // The first 44 were evicted to hold the bound at 256, so the oldest is
    // hinted about again even though its window has not passed...
    stream.send(event("message.delta", "thread-0", delta(2)));
    expect(stream.written).toHaveLength(301);
    // ...while the most recent is still suppressed.
    stream.send(event("message.delta", "thread-299", delta(2)));
    expect(stream.written).toHaveLength(301);
  });

  it("closes a stream it cannot make sense of rather than dropping the frame", async () => {
    const malformed = harness("thread-1");
    expect(malformed.send(event("message.delta", "other", { messageId: "m1" }))).toBe(false);
    expect(malformed.closes()).toBe(1);
    expect(malformed.written).toEqual([]);

    const nameless = harness("thread-1");
    expect(nameless.send(event("message.changed", "thread-1", { updatedAt: AT }))).toBe(false);
    expect(nameless.closes()).toBe(1);

    // A write that throws is the same problem seen from the socket: the
    // subscriber is dropped either way, and a stream nobody writes to must not
    // stay open reading "live".
    const throwing = harness("thread-1", () => { throw new Error("socket is gone"); });
    expect(throwing.send(event("message.delta", "thread-1", delta(1)))).toBe(false);
    expect(throwing.closes()).toBe(1);
  });
});

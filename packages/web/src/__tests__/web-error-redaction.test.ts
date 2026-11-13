import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveWebErrorResponse, sanitizeWebConsoleDetails, WebConsoleError } from "../errors.js";
import {
  collectKnownWebSecrets,
  createSecretSafeWebLogger,
  redactWebErrorMessage,
} from "../log-redaction.js";
import { startWebServer, type WebServerHandle } from "../server.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const FAKE_SECRET = "sk-fake-web-redaction-SECRET-abc123XYZ";
const BEARER_SECRET = "Bearer fake-bearer-web-secret-98765";

const cleanup: string[] = [];
const servers: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function start(options: Partial<Parameters<typeof startWebServer>[0]> = {}): Promise<{
  handle: WebServerHandle;
  baseUrl: string;
  root: string;
}> {
  const root = await temporaryRoot();
  cleanup.push(root);
  const staticDir = join(root, ".mono-agent", "static");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(staticDir, "assets"), { recursive: true });
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

function loggedText(spy: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(spy.mock.calls);
}

describe("web error redaction", () => {
  it("does not echo malformed JSON or its secrets in the response or logs", async () => {
    const error = vi.fn();
    const { baseUrl } = await start({ host: "127.0.0.1", logger: { error } });
    const response = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"sourceId": "agent-one", "leak": "${FAKE_SECRET}" `,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_json");
    expect(body.error.message).toBe("The request body is not valid JSON.");
    expect(JSON.stringify(body)).not.toContain(FAKE_SECRET);
    expect(loggedText(error)).not.toContain(FAKE_SECRET);
  });

  it("returns a fixed message for oversized bodies", async () => {
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const response = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "x".repeat(300_000) }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({
      code: "request_too_large",
      message: "The request body exceeds the size limit.",
    });
  });

  it("keeps a known WebConsoleError message, status, code, safe details and Retry-After", async () => {
    const infoFetch = operatorFetch({ supportsProviderAuth: true, supportsProviderAuthChecks: true });
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) return infoFetch(input as never, init);
      return Response.json(
        { error: { code: "provider_auth_rate_limited", message: "Wait before running provider checks." } },
        { status: 429, headers: { "Retry-After": "23" } },
      );
    }) as typeof fetch;
    const { baseUrl } = await start({
      host: "127.0.0.1",
      fetchImpl,
      env: { ...process.env, MONO_AGENT_TEST_TOKEN: FAKE_SECRET },
    });
    const response = await fetch(`${baseUrl}/api/v1/agents/agent-one/provider-auth/checks`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mono-Agent-Web-Origin": baseUrl },
      body: JSON.stringify({ idempotencyKey: "rate-limited-check" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("23");
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("provider_auth_rate_limited");
    expect(body.error.message).toBe("Wait before running provider checks.");
    expect(body.error.details).toEqual({ retryAfterSeconds: 23 });
  });

  it("drops arbitrary details from known errors", () => {
    const resolved = resolveWebErrorResponse(
      new WebConsoleError("cron_reply_pending", "A Reply is pending.", 409, {
        operationId: "op-123",
        pendingSince: "2026-01-01T00:00:00.000Z",
        // @ts-expect-error intentional unsafe extra
        injected: FAKE_SECRET,
      }),
    );
    expect(resolved.details).toEqual({ operationId: "op-123", pendingSince: "2026-01-01T00:00:00.000Z" });
    expect(JSON.stringify(resolved)).not.toContain(FAKE_SECRET);
    expect(sanitizeWebConsoleDetails({ retryAfterSeconds: 23, reason: "conversation_not_empty" }))
      .toEqual({ retryAfterSeconds: 23, reason: "conversation_not_empty" });
  });

  it("maps an unexpected Error with a secret to a fixed 500 with a redacted log", async () => {
    const error = vi.fn();
    const knownSecrets = [FAKE_SECRET];
    const safe = createSecretSafeWebLogger({ error }, knownSecrets);
    const failure = new Error(`upstream exploded: ${FAKE_SECRET} ${BEARER_SECRET}`);
    const resolved = resolveWebErrorResponse(failure);
    expect(resolved).toMatchObject({ status: 500, code: "internal_error", message: "Internal server error." });
    expect(JSON.stringify(resolved)).not.toContain(FAKE_SECRET);
    safe?.error?.("Web console request failed.", {
      error: redactWebErrorMessage(failure, knownSecrets),
      errorCode: resolved.code,
      status: resolved.status,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(loggedText(error)).not.toContain(FAKE_SECRET);
    expect(loggedText(error)).not.toContain("fake-bearer-web-secret");
    expect(loggedText(error)).toContain("internal_error");
  });

  it("redacts SSE failure logging", () => {
    const error = vi.fn();
    const knownSecrets = [FAKE_SECRET];
    const safe = createSecretSafeWebLogger({ error }, knownSecrets);
    const failure = new Error(`stream write failed: ${FAKE_SECRET}`);
    safe?.error?.("Web console event stream failed.", {
      error: redactWebErrorMessage(failure, knownSecrets),
      errorCode: "unknown",
    });
    expect(loggedText(error)).not.toContain(FAKE_SECRET);
    expect(loggedText(error)).toContain("Web console event stream failed.");
  });

  it("redacts a direct WebService.create logger", async () => {
    const error = vi.fn();
    const warn = vi.fn();
    const debug = vi.fn();
    const root = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-web-service-")));
    cleanup.push(root);
    const service = await WebService.create({
      stateDir: join(root, "state"),
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async (): Promise<never> => {
        throw new Error(`registry walk failed: ${FAKE_SECRET}`);
      },
      fetchImpl: operatorFetch(),
      logger: { error, warn, debug },
      env: { ...process.env, MONO_AGENT_WEB_TEST_TOKEN: FAKE_SECRET },
    });
    try {
      await service.refreshAgents();
    } finally {
      await service.stop();
    }
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...debug.mock.calls]);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(FAKE_SECRET);
  });

  it("supplies known environment credential values to the redactor", () => {
    const secrets = collectKnownWebSecrets({
      MONO_AGENT_WEB_TEST_TOKEN: FAKE_SECRET,
      PATH: "/usr/bin",
      SHORT_TOKEN: "abc",
    });
    expect(secrets).toContain(FAKE_SECRET);
    expect(redactWebErrorMessage(new Error(FAKE_SECRET), secrets)).not.toContain(FAKE_SECRET);
  });
});

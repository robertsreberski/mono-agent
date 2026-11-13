import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { startWebNotificationIngress } from "../notification-ingress.js";
import { OperatorTurnFrameError } from "../operator-client.js";
import {
  createBoundedSseWriter,
  createWebErrorMiddleware,
  logSseFailure,
  startWebServer,
  type WebServerHandle,
} from "../server.js";
import { WebService } from "../service.js";
import { resolveWebStatePaths } from "../state-paths.js";
import { WebStore } from "../store.js";
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

  it("only treats genuine body-parser failures as malformed JSON", () => {
    // A bare SyntaxError (e.g. from parsing agent data) is internal, not a 400.
    expect(resolveWebErrorResponse(new SyntaxError("unexpected token"))).toMatchObject({
      status: 500,
      code: "internal_error",
    });
    // A 400 status without parser markings is internal, not malformed JSON.
    expect(resolveWebErrorResponse(Object.assign(new Error("stale read"), { status: 400 }))).toMatchObject({
      status: 500,
      code: "internal_error",
    });
    // A genuine parser failure still maps to fixed invalid JSON.
    const parserError = Object.assign(new SyntaxError("Unexpected end of JSON input"), {
      status: 400,
      type: "entity.parse.failed",
      body: '{"sourceId":',
    });
    expect(resolveWebErrorResponse(parserError)).toMatchObject({
      status: 400,
      code: "invalid_json",
      message: "The request body is not valid JSON.",
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

  it("keeps bounded human-readable reasons and drops control characters", () => {
    expect(sanitizeWebConsoleDetails({ reason: "conversation not empty" }))
      .toEqual({ reason: "conversation not empty" });
    expect(sanitizeWebConsoleDetails({ reason: "Wait before retrying (23s)." }))
      .toEqual({ reason: "Wait before retrying (23s)." });
    expect(sanitizeWebConsoleDetails({ reason: "bad\nreason" })).toBeUndefined();
    expect(sanitizeWebConsoleDetails({ reason: "bad\u0000reason" })).toBeUndefined();
    expect(sanitizeWebConsoleDetails({ reason: "x".repeat(129) })).toBeUndefined();
  });

  it("maps unsupported content encoding to a distinct fixed 415", async () => {
    const charsetError = Object.assign(new SyntaxError("unsupported charset"), {
      status: 415,
      type: "charset.unsupported",
    });
    expect(resolveWebErrorResponse(charsetError)).toMatchObject({
      status: 415,
      code: "unsupported_content_encoding",
      message: "The request body uses an unsupported content encoding.",
    });
    const { baseUrl } = await start({ host: "127.0.0.1" });
    const response = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=iso-8859-1" },
      body: JSON.stringify({ sourceId: "agent-one" }),
    });
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({
      code: "unsupported_content_encoding",
      message: "The request body uses an unsupported content encoding.",
    });
  });

  it("maps an unexpected Error with a secret to a fixed 500 with a redacted log", async () => {
    const error = vi.fn();
    const knownSecrets = [FAKE_SECRET];
    const failure = new Error(`upstream exploded: ${FAKE_SECRET} ${BEARER_SECRET}`);
    // The real middleware, not a hand-built log call.
    const json = vi.fn();
    const setHeader = vi.fn();
    const res = {
      headersSent: false,
      status: vi.fn(() => ({ json })),
      setHeader,
    } as unknown as Parameters<ReturnType<typeof createWebErrorMiddleware>>[2];
    createWebErrorMiddleware({ error }, knownSecrets)(failure, {} as never, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0]?.[0] as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: "internal_error", message: "Internal server error." });
    expect(JSON.stringify(body)).not.toContain(FAKE_SECRET);
    expect(error).toHaveBeenCalledTimes(1);
    expect(loggedText(error)).not.toContain(FAKE_SECRET);
    expect(loggedText(error)).not.toContain("fake-bearer-web-secret");
    expect(loggedText(error)).toContain("internal_error");
    // And end to end: a missing static entry cannot leak its probe error.
    const root = await temporaryRoot();
    cleanup.push(root);
    const staticDir = join(root, "static");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    const handle = await startWebServer({
      port: 0,
      stateDir: join(root, "state"),
      staticDir,
      host: "127.0.0.1",
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch(),
      logger: { error },
    });
    servers.push(handle);
    const response = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain("Internal server error.");
  });

  it("closes without a body when headers are already sent", () => {
    const next = vi.fn();
    const destroy = vi.fn();
    const error = vi.fn();
    const res = { headersSent: true, destroy } as unknown as Parameters<
      ReturnType<typeof createWebErrorMiddleware>
    >[2];
    const failure = new Error(`late stream write failed: ${FAKE_SECRET}`);
    createWebErrorMiddleware({ error }, [FAKE_SECRET])(failure, {} as never, res, next);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(loggedText(error)).not.toContain(FAKE_SECRET);
    expect(loggedText(error)).toContain("after headers were sent");
  });

  it("redacts SSE failure logging through the real writer path", () => {
    const error = vi.fn();
    const knownSecrets = [FAKE_SECRET];
    const safe = createSecretSafeWebLogger({ error }, knownSecrets);
    // A target whose write throws, wired exactly like the route: writer
    // failure -> shared log helper -> wrapped logger.
    const writer = createBoundedSseWriter({
      target: {
        writableEnded: false,
        write: () => {
          throw new Error(`socket write failed: ${FAKE_SECRET}`);
        },
        once: () => undefined,
        removeListener: () => undefined,
      },
      onTerminal: () => undefined,
      onFailure: (failure) => logSseFailure(safe, knownSecrets, failure),
    });
    expect(writer.write("data: hello\n\n")).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
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

  it("collects cookie/session secrets but skips the allowed-hosts key", () => {
    const cookieSecret = "cookie-secret-value-12345";
    const sessionSecret = "session-secret-value-67890";
    const urlSecret = "https://example.invalid/session/s3cr3t-value";
    const shortKey = "abc123";
    const secrets = collectKnownWebSecrets({
      MONO_AGENT_WEB_COOKIE_SECRET: cookieSecret,
      MONO_AGENT_WEB_SESSION_TOKEN: sessionSecret,
      MONO_AGENT_WEB_API_SECRET: urlSecret,
      MONO_AGENT_TUI_API_KEY: shortKey,
      MONO_AGENT_WEB_ALLOWED_HOSTS: "console.example, other.example",
      PATH: "/usr/bin:/bin",
    });
    expect(secrets).toContain(cookieSecret);
    expect(secrets).toContain(sessionSecret);
    // A URL-shaped value under a credential key is still collected.
    expect(secrets).toContain(urlSecret);
    // Short keys are collected when the key explicitly names a credential.
    expect(secrets).toContain(shortKey);
    // The hostname allowlist key is never collected, and neither is PATH.
    expect(secrets).not.toContain("console.example, other.example");
    expect(secrets).not.toContain("/usr/bin:/bin");
    // Short values under fuzzier keys stay out to avoid mangling diagnostics.
    expect(collectKnownWebSecrets({ MONO_AGENT_WEB_COOKIE_JAR: "abc" })).toEqual([]);
    expect(collectKnownWebSecrets({ MONO_AGENT_WEB_SESSION_TICKET: "abcdefg" })).toEqual([]);
  });

  it("does not treat numeric or tuning settings that merely mention a credential word as secrets", () => {
    expect(collectKnownWebSecrets({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      MAX_TOKENS: "4096",
      SESSION_TIMEOUT_MS: "86400000",
      TOKEN_BUDGET_LIMIT: "1000000000",
    })).toEqual([]);
  });

  it("redacts secrets from persisted turn failure messages", async () => {
    const turnSecret = "sk-fake-turn-failure-SECRET-99";
    const root = await temporaryRoot();
    cleanup.push(root);
    const service = await WebService.create({
      stateDir: join(root, "state"),
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({
        turns: () => {
          throw new Error(`provider blew up: ${turnSecret}`);
        },
      }),
      env: { ...process.env, MONO_AGENT_WEB_TURN_TOKEN: turnSecret },
    });
    try {
      // Non-WebConsoleError text goes through the known-secret redactor before
      // storage; reviewed WebConsoleError messages pass through untouched.
      const redactor = service as unknown as {
        safeTurnFailureMessage(failure: unknown): string;
      };
      const redacted = redactor.safeTurnFailureMessage(new Error(`provider blew up: ${turnSecret}`));
      expect(redacted).not.toContain(turnSecret);
      expect(redacted).toContain("[REDACTED_WEB_CREDENTIAL]");
      expect(redacted).toContain("provider blew up");
      expect(redactor.safeTurnFailureMessage(
        new WebConsoleError("reviewed_code", "Reviewed owner message.", 400),
      )).toBe("Reviewed owner message.");
      // Agent error frames are untrusted input even though they subclass
      // WebConsoleError: their message is redacted and bounded too.
      const frameFailure = new OperatorTurnFrameError(
        "agent_error",
        `provider blew up: ${turnSecret} ${"y".repeat(5_000)}`,
        502,
      );
      const frameMessage = redactor.safeTurnFailureMessage(frameFailure);
      expect(frameMessage).not.toContain(turnSecret);
      expect(frameMessage).toContain("[REDACTED_WEB_CREDENTIAL]");
      expect(frameMessage.length).toBeLessThanOrEqual(1_000);
      const bounded = redactor.safeTurnFailureMessage(new Error(`x: ${"y".repeat(5_000)}`));
      expect(bounded.length).toBeLessThanOrEqual(1_000);
      // End to end: the failed turn carries no secret either.
      const thread = service.createThread("agent-one");
      await service.startTurn(thread.id, { text: "hello" });
      const deadline = Date.now() + 5_000;
      while (service.store.getThread(thread.id)?.runState.status !== "failed") {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the failed turn.");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect(JSON.stringify(service.thread(thread.id).messages)).not.toContain(turnSecret);
    } finally {
      await service.stop();
    }
  });

  it("keeps a redacted cause on storage init failure", async () => {
    const secret = "sk-fake-store-init-SECRET-1";
    const root = await temporaryRoot();
    cleanup.push(root);
    const paths = resolveWebStatePaths({ stateDir: join(root, `state-${secret}`) });
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.marker, JSON.stringify({ schema: 1, kind: "mono-agent-web-state" }), "utf8");
    await writeFile(paths.database, "not a sqlite database", "utf8");
    const failure = await WebStore.openPrepared(paths).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "storage_corrupt",
      status: 500,
      message: "Unable to initialize web state.",
    });
    const cause = (failure as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).not.toContain(secret);
    expect((cause as Error).stack ?? "").not.toContain(secret);
  });

  it("uses the server env for notification ingress redaction", async () => {
    const ingressSecret = "sk-fake-ingress-SECRET-77";
    const error = vi.fn();
    const root = await temporaryRoot();
    cleanup.push(root);
    const service = await WebService.create({
      stateDir: join(root, "state"),
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch(),
    });
    const ingress = await startWebNotificationIngress(
      service,
      { error },
      { MONO_AGENT_TEST_INGRESS_TOKEN: ingressSecret },
    );
    try {
      const record = JSON.parse(
        await readFile(service.store.paths.notificationIngress, "utf8"),
      ) as { url: string; token: string };
      const spy = vi.spyOn(service, "deliverNotification")
        .mockRejectedValueOnce(new Error(`wake failed: ${ingressSecret}`));
      const response = await fetch(record.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${record.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceId: "agent-one",
          triggerKind: "cron",
          deliveryKey: "k-1",
          text: "hello",
        }),
      });
      spy.mockRestore();
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain(ingressSecret);
      expect(loggedText(error)).not.toContain(ingressSecret);
    } finally {
      await ingress.stop();
      await service.stop();
    }
  });
});

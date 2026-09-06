import type {
  ProviderAuthOperator,
  ProviderAuthSessionSnapshot,
  ProviderAuthStatusSnapshot,
} from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

const servers: TuiAdapterStartResult[] = [];
afterEach(async () => await Promise.all(servers.splice(0).map(async (server) => await server.stop())));

const status: ProviderAuthStatusSnapshot = {
  schema: "mono-agent.provider-auth.v1",
  generatedAt: "2026-09-06T12:00:00.000Z",
  providers: [{
    providerId: "opencode-go",
    label: "OpenCode Go",
    usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
    state: "missing",
    verification: "not_verified",
    methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true }],
  }],
};
const session: ProviderAuthSessionSnapshot = {
  schema: "mono-agent.provider-auth-session.v1",
  id: "session-1",
  providerId: "opencode-go",
  authType: "api_key",
  strategy: "api_key_prompt",
  state: "awaiting_input",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:00:00.000Z",
  expiresAt: "2026-09-06T12:20:00.000Z",
  prompt: { id: "prompt-1", type: "secret", message: "OpenCode API key" },
};

describe("provider auth routes", () => {
  it("advertises only with an operator bearer, protects every route, and never echoes input", async () => {
    const operator: ProviderAuthOperator = {
      status: vi.fn(async () => status),
      start: vi.fn(async () => session),
      get: vi.fn(async () => session),
      submit: vi.fn(async () => ({ ...session, state: "succeeded", prompt: undefined } as never)),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const server = await startTuiAdapter({
      host: "127.0.0.1",
      port: 0,
      apiKey: "owner-key",
      providerAuth: operator,
      responder: { respond: async () => ({ text: "ok" }) },
    });
    servers.push(server);
    const headers = { authorization: "Bearer owner-key" };
    const info = await fetch(`${server.baseUrl}/v1/info`, { headers });
    expect(await info.json()).toMatchObject({ capabilities: { providerAuth: { version: 1 } } });
    const denied = await fetch(`${server.baseUrl}/v1/provider-auth`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toContain("no-store");
    const listed = await fetch(`${server.baseUrl}/v1/provider-auth`, { headers });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toContain("no-store");
    expect(await listed.json()).toEqual(status);

    const created = await fetch(`${server.baseUrl}/v1/provider-auth/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");
    expect(await created.json()).toEqual(session);
    expect((await fetch(`${server.baseUrl}/v1/provider-auth/sessions/session-1`, {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401);
    expect(await (await fetch(`${server.baseUrl}/v1/provider-auth/sessions/session-1`, { headers })).json()).toEqual(session);

    const secret = "PROVIDER_AUTH_SECRET_SENTINEL";
    const submitted = await fetch(`${server.baseUrl}/v1/provider-auth/sessions/session-1/input`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ promptId: "prompt-1", value: secret }),
    });
    const submittedText = await submitted.text();
    expect(submitted.status).toBe(200);
    expect(submittedText).not.toContain(secret);
    expect(operator.submit).toHaveBeenCalledWith("session-1", { promptId: "prompt-1", value: secret });

    const cancelled = await fetch(`${server.baseUrl}/v1/provider-auth/sessions/session-1`, { method: "DELETE", headers });
    expect(cancelled.status).toBe(204);
    expect(cancelled.headers.get("cache-control")).toContain("no-store");
    expect(operator.cancel).toHaveBeenCalledWith("session-1");
  });

  it("keeps the capability and routes unavailable without an operator bearer", async () => {
    const operator: ProviderAuthOperator = {
      status: async () => status,
      start: async () => session,
      get: async () => session,
      submit: async () => session,
      cancel: async () => undefined,
      stop: async () => undefined,
    };
    const server = await startTuiAdapter({
      host: "127.0.0.1",
      port: 0,
      providerAuth: operator,
      responder: { respond: async () => ({ text: "ok" }) },
    });
    servers.push(server);
    expect(await (await fetch(`${server.baseUrl}/v1/info`)).json()).not.toHaveProperty("capabilities.providerAuth");
    expect((await fetch(`${server.baseUrl}/v1/provider-auth`)).status).toBe(404);
  });
});

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  isOpenCodeModel,
  withOpenCodeSessionHeaders,
} from "../../ai/providers/pi-native/provider-attribution.js";

const CONTEXT = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function captureProvider(provider = "opencode-go", modelOverrides = {}, authHeaders) {
  const faux = fauxProvider({ provider, models: [{ id: "deepseek-v4-pro" }] });
  const model = { ...faux.getModel(), ...modelOverrides };
  const calls = [];
  faux.setResponses([
    ...Array.from({ length: 4 }, () => (_context, options) => {
      calls.push(options);
      return fauxAssistantMessage([fauxText("ok")]);
    }),
  ]);
  const models = createModels();
  models.setProvider(authHeaders === undefined
    ? faux.provider
    : {
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Faux",
          resolve: async () => ({ auth: { headers: authHeaders } }),
        },
      },
    });
  return { calls, model, models };
}

describe("OpenCode provider attribution", () => {
  it("matches exact provider ids or the exact OpenCode hostname only", () => {
    expect(isOpenCodeModel({ provider: "opencode", baseUrl: "https://elsewhere.example/v1" })).toBe(true);
    expect(isOpenCodeModel({ provider: "opencode-go", baseUrl: "https://elsewhere.example/v1" })).toBe(true);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" })).toBe(true);

    expect(isOpenCodeModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })).toBe(false);
    expect(isOpenCodeModel({ provider: "openai-codex", baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://opencode.ai.example.com/v1" })).toBe(false);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://api.opencode.ai/v1" })).toBe(false);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "not a URL" })).toBe(false);
  });

  it("sends stable session and honest client headers at final provider dispatch", async () => {
    const fixture = captureProvider();
    const firstConversation = withOpenCodeSessionHeaders(fixture.models, "session-one");
    const secondConversation = withOpenCodeSessionHeaders(fixture.models, "session-two");

    await firstConversation.completeSimple(fixture.model, CONTEXT);
    await firstConversation.completeSimple(fixture.model, CONTEXT);
    await secondConversation.completeSimple(fixture.model, CONTEXT);

    expect(fixture.calls.map((call) => call?.headers)).toEqual([
      { "x-opencode-session": "session-one", "x-opencode-client": "mono-agent" },
      { "x-opencode-session": "session-one", "x-opencode-client": "mono-agent" },
      { "x-opencode-session": "session-two", "x-opencode-client": "mono-agent" },
    ]);
  });

  it("lets existing headers, null suppression, and a caller transform win case-insensitively", async () => {
    const fixture = captureProvider("opencode-go", {
      headers: { "X-Model-Header": "model" },
    }, { "X-Auth-Header": "auth" });
    const transformHeaders = vi.fn((headers) => ({
      ...headers,
      "X-OpenCode-Session": "transformed-session",
    }));

    await withOpenCodeSessionHeaders(fixture.models, "mono-default").completeSimple(
      fixture.model,
      CONTEXT,
      {
        headers: {
          "x-openCODE-session": "caller-session",
          "X-OpenCode-Client": null,
          "X-Request-Header": "request",
        },
        transformHeaders,
      },
    );

    expect(transformHeaders).toHaveBeenCalledWith(expect.objectContaining({
      "x-openCODE-session": "caller-session",
      "X-OpenCode-Client": null,
      "X-Model-Header": "model",
      "X-Auth-Header": "auth",
      "X-Request-Header": "request",
    }));
    expect(fixture.calls[0]?.headers).toEqual(expect.objectContaining({
      "X-OpenCode-Session": "transformed-session",
      "X-OpenCode-Client": null,
      "X-Model-Header": "model",
      "X-Auth-Header": "auth",
      "X-Request-Header": "request",
    }));
    expect(Object.keys(fixture.calls[0]?.headers ?? {}).filter((name) => name.toLowerCase() === "x-opencode-client"))
      .toEqual(["X-OpenCode-Client"]);
  });

  it.each([
    ["anthropic", "https://api.anthropic.com"],
    ["openai-codex", "https://api.openai.com/v1"],
  ])("is a strict no-op for %s", async (provider, baseUrl) => {
    const fixture = captureProvider(provider, { baseUrl });
    await withOpenCodeSessionHeaders(fixture.models, "must-not-leak").completeSimple(
      fixture.model,
      CONTEXT,
      { headers: { "X-Existing": "kept" } },
    );

    expect(fixture.calls[0]?.headers).toEqual({ "X-Existing": "kept" });
    expect(Object.keys(fixture.calls[0]?.headers ?? {}).some((name) => name.toLowerCase().startsWith("x-opencode-")))
      .toBe(false);
  });
});

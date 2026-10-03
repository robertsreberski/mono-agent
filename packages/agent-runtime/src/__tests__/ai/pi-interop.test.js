import { beforeEach, describe, expect, it, vi } from "vitest";

const piMocks = vi.hoisted(() => ({
  getBuiltinModel: vi.fn(),
  getBuiltinModels: vi.fn(),
  getBuiltinProviders: vi.fn(),
  builtinProviders: vi.fn(),
  builtinModels: vi.fn(),
  resolveOAuthApiKey: vi.fn(),
  getPiOAuthAuth: vi.fn(),
  getSupportedThinkingLevels: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getSupportedThinkingLevels: piMocks.getSupportedThinkingLevels,
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: piMocks.builtinModels,
  builtinProviders: piMocks.builtinProviders,
  getBuiltinModel: piMocks.getBuiltinModel,
  getBuiltinModels: piMocks.getBuiltinModels,
  getBuiltinProviders: piMocks.getBuiltinProviders,
}));

vi.mock("../../ai/pi-oauth-compat.js", () => ({
  resolveOAuthApiKey: piMocks.resolveOAuthApiKey,
  getPiOAuthAuth: piMocks.getPiOAuthAuth,
  // The callbacks -> AuthInteraction bridge is covered by its own unit tests;
  // here it stays identity-ish so login assertions still see the callbacks.
  toAuthInteraction: (callbacks) => callbacks,
}));

import {
  checkPiProviderAuth,
  describePiProviderAuth,
  getPiBuiltinModel,
  isPiOAuthLoginEnabled,
  listPiBuiltinModels,
  loginPiProviderAuth,
  loginPiOAuth,
  reasoningLevelsForPiModel,
  resolvePiOAuthApiKey,
} from "../../ai/pi-interop.js";

const rawModel = {
  id: "model-1",
  name: "Model One",
  api: "openai-responses",
  provider: "provider-1",
  baseUrl: "https://provider.example/v1",
  reasoning: true,
  thinkingLevelMap: { off: "none" },
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  compat: { supportsStore: false },
};

beforeEach(() => {
  for (const mock of Object.values(piMocks)) mock.mockReset();
  piMocks.getBuiltinModels.mockReturnValue([rawModel]);
  piMocks.getBuiltinModel.mockReturnValue(rawModel);
  piMocks.getBuiltinProviders.mockReturnValue(["provider-1"]);
  piMocks.builtinProviders.mockReturnValue([]);
});

describe("Pi interoperability facade", () => {
  it("returns fresh defensive model snapshots without exposing the Pi catalog", () => {
    const listed = listPiBuiltinModels("provider-1");
    const selected = getPiBuiltinModel("provider-1", "model-1");

    expect(piMocks.getBuiltinModels).toHaveBeenCalledWith("provider-1");
    expect(piMocks.getBuiltinModel).toHaveBeenCalledWith("provider-1", "model-1");
    expect(listed).toEqual([rawModel]);
    expect(selected).toEqual(rawModel);
    expect(listed[0]).not.toBe(rawModel);
    expect(selected).not.toBe(rawModel);

    listed[0].cost.input = 999;
    listed[0].input.push("image");
    selected.compat.supportsStore = true;

    expect(rawModel.cost.input).toBe(1);
    expect(rawModel.input).toEqual(["text"]);
    expect(rawModel.compat.supportsStore).toBe(false);
  });

  it("preserves unknown-provider and unknown-model results", () => {
    piMocks.getBuiltinModels.mockReturnValueOnce([]);
    piMocks.getBuiltinModel.mockReturnValueOnce(undefined);

    expect(listPiBuiltinModels("missing")).toEqual([]);
    expect(getPiBuiltinModel("provider-1", "missing")).toBeUndefined();
  });

  it("normalizes Pi's off thinking level to mono-agent's none vocabulary", () => {
    piMocks.getSupportedThinkingLevels.mockReturnValue(["off", "low", "xhigh"]);

    expect(reasoningLevelsForPiModel(rawModel)).toEqual(["none", "low", "xhigh"]);
    expect(piMocks.getSupportedThinkingLevels).toHaveBeenCalledWith(rawModel);
  });

  it("clones credentials across OAuth API-key resolution in both directions", async () => {
    const credentials = {
      "openai-codex": {
        refresh: "refresh-original",
        access: "access-original",
        expires: 1,
        metadata: { account: "original" },
      },
    };
    let delegatedCredentials;
    piMocks.resolveOAuthApiKey.mockImplementation(async (_providerId, received) => {
      delegatedCredentials = received;
      received["openai-codex"].access = "access-refreshed";
      received["openai-codex"].metadata.account = "delegated";
      return {
        apiKey: "resolved-key",
        newCredentials: received["openai-codex"],
      };
    });

    const result = await resolvePiOAuthApiKey("openai-codex", credentials);

    expect(delegatedCredentials).not.toBe(credentials);
    expect(credentials["openai-codex"]).toMatchObject({
      access: "access-original",
      metadata: { account: "original" },
    });
    expect(result).toEqual({
      apiKey: "resolved-key",
      newCredentials: expect.objectContaining({
        access: "access-refreshed",
        metadata: { account: "delegated" },
      }),
    });

    result.newCredentials.metadata.account = "consumer";
    expect(delegatedCredentials["openai-codex"].metadata.account).toBe("delegated");
  });

  it("preserves a null OAuth resolution and propagates refresh failures", async () => {
    piMocks.resolveOAuthApiKey.mockResolvedValueOnce(null);
    await expect(resolvePiOAuthApiKey("openai-codex", {})).resolves.toBeNull();

    piMocks.resolveOAuthApiKey.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(resolvePiOAuthApiKey("openai-codex", {})).rejects.toThrow("refresh failed");
  });

  it("runs login through a copied callback object and clones returned credentials", async () => {
    const returnedCredentials = {
      refresh: "refresh",
      access: "access",
      expires: 42,
      metadata: { account: "original" },
    };
    const login = vi.fn(async () => returnedCredentials);
    piMocks.getPiOAuthAuth.mockReturnValue({ login });
    const callbacks = {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(async () => "answer"),
      onSelect: vi.fn(async () => "browser"),
    };

    const result = await loginPiOAuth("openai-codex", callbacks);

    expect(login).toHaveBeenCalledOnce();
    expect(login.mock.calls[0][0]).toEqual(callbacks);
    expect(login.mock.calls[0][0]).not.toBe(callbacks);
    expect(result).toEqual(returnedCredentials);
    expect(result).not.toBe(returnedCredentials);

    result.metadata.account = "consumer";
    expect(returnedCredentials.metadata.account).toBe("original");
  });

  it("rejects unavailable providers and missing required callbacks", async () => {
    piMocks.getPiOAuthAuth.mockReturnValueOnce(undefined);
    await expect(loginPiOAuth("missing", {})).rejects.toThrow(
      "Pi OAuth provider is unavailable: missing",
    );

    piMocks.getPiOAuthAuth.mockReturnValueOnce({ login: vi.fn() });
    await expect(loginPiOAuth("openai-codex", {})).rejects.toThrow(
      "loginPiOAuth requires callbacks.onAuth()",
    );
  });

  it("propagates provider login failures after validating callbacks", async () => {
    piMocks.getPiOAuthAuth.mockReturnValueOnce({
      login: vi.fn(async () => {
        throw new Error("login failed");
      }),
    });
    await expect(loginPiOAuth("openai-codex", {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(async () => "answer"),
      onSelect: vi.fn(async () => "browser"),
    })).rejects.toThrow("login failed");
  });

  it("describes provider-owned auth methods without returning provider objects", () => {
    piMocks.builtinProviders.mockReturnValueOnce([{
      id: "opencode-go",
      name: "OpenCode Go",
      auth: {
        apiKey: { name: "OpenCode API key", login: vi.fn() },
      },
    }]);

    expect(describePiProviderAuth("opencode-go")).toEqual({
      providerId: "opencode-go",
      label: "OpenCode Go",
      methods: [{ type: "api_key", label: "OpenCode API key", interactive: true }],
    });
    expect(describePiProviderAuth("missing")).toBeUndefined();
  });

  it("advertises Pi's ChatGPT OAuth alongside OpenAI API keys without changing Codex OAuth", () => {
    piMocks.builtinProviders.mockReturnValue([
      {
        id: "openai", name: "OpenAI", auth: {
          oauth: { name: "Sign in with ChatGPT" },
          apiKey: { name: "OpenAI API key" },
        },
      },
      {
        id: "openai-codex", name: "OpenAI Codex (legacy)", auth: {
          oauth: { name: "Codex sign-in" },
        },
      },
    ]);

    expect(isPiOAuthLoginEnabled("openai")).toBe(true);
    expect(isPiOAuthLoginEnabled("openai-codex")).toBe(true);
    expect(describePiProviderAuth("openai")).toEqual({
      providerId: "openai", label: "OpenAI",
      methods: [
        { type: "oauth", label: "Sign in with ChatGPT", interactive: true },
        { type: "api_key", label: "OpenAI API key", interactive: false },
      ],
    });
    expect(describePiProviderAuth("openai-codex")).toEqual({
      providerId: "openai-codex", label: "OpenAI Codex (legacy)",
      methods: [{ type: "oauth", label: "Codex sign-in", interactive: true }],
    });
  });

  it("requires a stable callback and passes it to both OpenAI OAuth facades", async () => {
    const interaction = { prompt: vi.fn(), notify: vi.fn() };
    await expect(loginPiProviderAuth("openai", "oauth", interaction)).rejects.toThrow(/installation device ID/u);
    await expect(loginPiOAuth("openai", {})).rejects.toThrow(/installation device ID/u);
    const getDeviceId = vi.fn(() => "3e53b686-a244-45b6-8267-4dd9e6dce936");
    const login = vi.fn(async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: 1, clientId: "issued" }));
    piMocks.builtinModels.mockReturnValueOnce({ login });
    const credentials = await loginPiProviderAuth("openai", "oauth", interaction, { getDeviceId });
    expect(credentials.clientId).toBe("issued");
    expect(login).toHaveBeenCalledWith("openai", "oauth", expect.any(Object), { getDeviceId });
    const oauthLogin = vi.fn(async () => credentials);
    piMocks.getPiOAuthAuth.mockReturnValueOnce({ login: oauthLogin });
    await loginPiOAuth("openai", { onAuth() {}, onDeviceCode() {}, onPrompt() {}, onSelect() {} }, { getDeviceId });
    expect(oauthLogin).toHaveBeenCalledWith(expect.any(Object), { getDeviceId });
  });

  it("checks auth through Pi Models without refreshing or exposing credentials", async () => {
    const checkAuth = vi.fn(async () => ({ source: "OPENCODE_API_KEY", type: "api_key" }));
    piMocks.builtinModels.mockReturnValueOnce({ checkAuth });

    await expect(checkPiProviderAuth(
      "opencode-go",
      { type: "api_key", key: "sentinel" },
      { OPENCODE_API_KEY: "ambient" },
    )).resolves.toEqual({ source: "environment", type: "api_key" });
    expect(checkAuth).toHaveBeenCalledWith("opencode-go", undefined);
  });

  it("runs generic provider login against only an in-memory credential store", async () => {
    let suppliedOptions;
    piMocks.builtinModels.mockImplementationOnce((options) => {
      suppliedOptions = options;
      return {
        login: vi.fn(async (_provider, _type, interaction) => {
          interaction.notify({ type: "progress", message: "Waiting" });
          expect(await interaction.prompt({ type: "secret", message: "Key" })).toBe("entered");
          return { type: "api_key", key: "credential" };
        }),
      };
    });
    const notify = vi.fn();
    const prompt = vi.fn(async () => "entered");

    const result = await loginPiProviderAuth("opencode-go", "api_key", { prompt, notify });

    expect(result).toEqual({ type: "api_key", key: "credential" });
    expect(notify).toHaveBeenCalledWith({ type: "progress", message: "Waiting" });
    expect(suppliedOptions.credentials).toBeDefined();
  });

  describe("pi catalog reads", () => {
    it("lists upstream rows snapshot-cloned for providers without supplements", () => {
      piMocks.getBuiltinModels.mockReturnValue([rawModel]);

      const listed = listPiBuiltinModels("provider-1");
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: "model-1", provider: "provider-1" });
      expect(listed[0]).not.toBe(rawModel);
      expect(piMocks.getBuiltinModels).toHaveBeenCalledWith("provider-1");

      // Mutating the snapshot never touches the shared upstream row.
      listed[0].cost.input = 999;
      listed[0].input.push("video");
      expect(listPiBuiltinModels("provider-1")[0]).toMatchObject({
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        input: ["text"],
      });
    });

    it("reads one row straight from upstream with no miss-fallback", () => {
      // All former backfill rows ship upstream by 0.99.1. The facade reports
      // the upstream row verbatim and undefined on a genuine miss.
      piMocks.getBuiltinModel.mockImplementation((provider, id) =>
        id === "model-1" ? rawModel : undefined);

      expect(getPiBuiltinModel("provider-1", "model-1")).toEqual(rawModel);
      expect(getPiBuiltinModel("provider-1", "model-1")).not.toBe(rawModel);
      expect(getPiBuiltinModel("provider-1", "missing")).toBeUndefined();
    });

    it("leaves unrelated providers untouched", () => {
      piMocks.getBuiltinModels.mockReturnValue([rawModel]);
      expect(listPiBuiltinModels("provider-1")).toHaveLength(1);
      expect(listPiBuiltinModels("provider-1")[0].id).toBe("model-1");
    });
  });
});

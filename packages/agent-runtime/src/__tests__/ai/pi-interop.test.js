import { beforeEach, describe, expect, it, vi } from "vitest";

const piMocks = vi.hoisted(() => ({
  getBuiltinModel: vi.fn(),
  getBuiltinModels: vi.fn(),
  resolveOAuthApiKey: vi.fn(),
  getPiOAuthAuth: vi.fn(),
  getSupportedThinkingLevels: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getSupportedThinkingLevels: piMocks.getSupportedThinkingLevels,
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: piMocks.getBuiltinModel,
  getBuiltinModels: piMocks.getBuiltinModels,
}));

vi.mock("../../ai/pi-oauth-compat.js", () => ({
  resolveOAuthApiKey: piMocks.resolveOAuthApiKey,
  getPiOAuthAuth: piMocks.getPiOAuthAuth,
  // The callbacks -> AuthInteraction bridge is covered by its own unit tests;
  // here it stays identity-ish so login assertions still see the callbacks.
  toAuthInteraction: (callbacks) => callbacks,
}));

import {
  getPiBuiltinModel,
  listPiBuiltinModels,
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
});

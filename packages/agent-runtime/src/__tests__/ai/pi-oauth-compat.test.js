import { beforeEach, describe, expect, it, vi } from "vitest";

const piMocks = vi.hoisted(() => ({ builtinProviders: vi.fn() }));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinProviders: piMocks.builtinProviders,
}));

const {
  getPiOAuthAuth,
  getPiOAuthProviderIds,
  resetPiProviderIndexForTests,
  resolveOAuthApiKey,
  toAuthInteraction,
} = await import("../../ai/pi-oauth-compat.js");

/** The stored credential shape mono-agent keeps in auth.json. */
function credential(overrides = {}) {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 4_200_000_000_000,
    ...overrides,
  };
}

function providers({ refresh = vi.fn(), toAuth = vi.fn() } = {}) {
  return [
    { id: "anthropic", auth: { oauth: { name: "Anthropic", login: vi.fn(), refresh, toAuth } } },
    { id: "openai-codex", auth: { oauth: { name: "Codex", login: vi.fn(), refresh, toAuth } } },
    // API-key only, exactly like the real opencode-go provider.
    { id: "opencode-go", auth: { apiKey: { name: "OpenCode API key" } } },
  ];
}

beforeEach(() => {
  piMocks.builtinProviders.mockReset();
  piMocks.builtinProviders.mockReturnValue(providers());
  resetPiProviderIndexForTests();
});

describe("getPiOAuthProviderIds", () => {
  it("lists only providers that actually support OAuth", () => {
    expect(getPiOAuthProviderIds()).toEqual(["anthropic", "openai-codex"]);
  });

  it("indexes the catalog once because it sits on the per-request credential path", () => {
    getPiOAuthProviderIds();
    getPiOAuthAuth("anthropic");
    getPiOAuthAuth("openai-codex");

    expect(piMocks.builtinProviders).toHaveBeenCalledOnce();
  });
});

describe("getPiOAuthAuth", () => {
  it("returns undefined for unknown, api-key-only, and empty provider ids", () => {
    expect(getPiOAuthAuth("nope")).toBeUndefined();
    expect(getPiOAuthAuth("opencode-go")).toBeUndefined();
    expect(getPiOAuthAuth("")).toBeUndefined();
  });
});

describe("resolveOAuthApiKey", () => {
  it("throws for a provider with no OAuth support", async () => {
    await expect(resolveOAuthApiKey("opencode-go", { "opencode-go": credential() }))
      .rejects.toThrow("Unknown OAuth provider: opencode-go");
  });

  it("returns null when the credential map has nothing for this provider", async () => {
    await expect(resolveOAuthApiKey("anthropic", { "openai-codex": credential() }))
      .resolves.toBeNull();
    await expect(resolveOAuthApiKey("anthropic", undefined)).resolves.toBeNull();
  });

  it("derives the api key without refreshing an unexpired credential", async () => {
    const refresh = vi.fn();
    const toAuth = vi.fn(async () => ({ apiKey: "derived-key" }));
    piMocks.builtinProviders.mockReturnValue(providers({ refresh, toAuth }));
    resetPiProviderIndexForTests();

    const stored = credential({ expires: Date.now() + 60_000 });
    const result = await resolveOAuthApiKey("anthropic", { anthropic: stored });

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ newCredentials: expect.objectContaining({ access: "access-token" }), apiKey: "derived-key" });
  });

  it("refreshes only once the credential has actually expired", async () => {
    const refreshed = credential({ access: "fresh-access", expires: Date.now() + 3_600_000 });
    const refresh = vi.fn(async () => refreshed);
    const toAuth = vi.fn(async (cred) => ({ apiKey: cred.access }));
    piMocks.builtinProviders.mockReturnValue(providers({ refresh, toAuth }));
    resetPiProviderIndexForTests();

    const result = await resolveOAuthApiKey("anthropic", {
      anthropic: credential({ expires: Date.now() - 1 }),
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(result?.apiKey).toBe("fresh-access");
    // Pure: the refreshed credential comes back for pi-auth.js to persist.
    expect(result?.newCredentials).toBe(refreshed);
  });

  it("tags the credential so a file written without the 0.83 discriminant still works", async () => {
    const toAuth = vi.fn(async () => ({ apiKey: "k" }));
    piMocks.builtinProviders.mockReturnValue(providers({ toAuth }));
    resetPiProviderIndexForTests();

    const { type: _dropped, ...untagged } = credential({ expires: Date.now() + 60_000 });
    await resolveOAuthApiKey("anthropic", { anthropic: untagged });

    expect(toAuth).toHaveBeenCalledWith(expect.objectContaining({ type: "oauth" }));
  });

  it("reports a refresh failure as a refresh failure", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    piMocks.builtinProviders.mockReturnValue(providers({ refresh }));
    resetPiProviderIndexForTests();

    await expect(resolveOAuthApiKey("anthropic", { anthropic: credential({ expires: 1 }) }))
      .rejects.toThrow("Failed to refresh OAuth token for anthropic");
  });

  it("drops the per-credential baseUrl, preserving the pre-0.83 contract", async () => {
    const toAuth = vi.fn(async () => ({ apiKey: "copilot-key", baseUrl: "https://proxy.example" }));
    piMocks.builtinProviders.mockReturnValue(providers({ toAuth }));
    resetPiProviderIndexForTests();

    const result = await resolveOAuthApiKey("anthropic", {
      anthropic: credential({ expires: Date.now() + 60_000 }),
    });

    expect(result).not.toHaveProperty("baseUrl");
    expect(result?.apiKey).toBe("copilot-key");
  });
});

describe("toAuthInteraction", () => {
  function callbacks(overrides = {}) {
    return {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(async () => "typed"),
      onSelect: vi.fn(async () => "chosen"),
      onProgress: vi.fn(),
      ...overrides,
    };
  }

  it("routes text prompts to onPrompt and select prompts to onSelect", async () => {
    const cb = callbacks();
    const interaction = toAuthInteraction(cb);

    await expect(interaction.prompt({ type: "text", message: "Key?", placeholder: "sk-" }))
      .resolves.toBe("typed");
    expect(cb.onPrompt).toHaveBeenCalledWith({ message: "Key?", placeholder: "sk-" });

    await expect(interaction.prompt({
      type: "select",
      message: "Pick",
      options: [{ id: "browser", label: "Browser" }],
    })).resolves.toBe("chosen");
    expect(cb.onSelect).toHaveBeenCalledWith({
      message: "Pick",
      options: [{ id: "browser", label: "Browser" }],
    });
  });

  it("keeps manual_code on onManualCodeInput, the Anthropic paste path", async () => {
    const onManualCodeInput = vi.fn(async () => "https://localhost/callback?code=c&state=s");
    const cb = callbacks({ onManualCodeInput });
    const interaction = toAuthInteraction(cb);

    await expect(interaction.prompt({ type: "manual_code", message: "Paste" }))
      .resolves.toBe("https://localhost/callback?code=c&state=s");
    expect(onManualCodeInput).toHaveBeenCalledOnce();
    expect(cb.onPrompt).not.toHaveBeenCalled();
  });

  it("falls back to onPrompt when the optional manual-code callback is absent", async () => {
    const cb = callbacks();
    await expect(toAuthInteraction(cb).prompt({ type: "manual_code", message: "Paste" }))
      .resolves.toBe("typed");
    expect(cb.onPrompt).toHaveBeenCalledWith({ message: "Paste" });
  });

  it("rejects a cancelled selection, which the legacy callback signalled with undefined", async () => {
    const cb = callbacks({ onSelect: vi.fn(async () => undefined) });
    await expect(toAuthInteraction(cb).prompt({
      type: "select",
      message: "Pick",
      options: [{ id: "a", label: "A" }],
    })).rejects.toThrow("OAuth provider selection was cancelled.");
  });

  it("maps notify events onto the matching legacy callbacks", () => {
    const cb = callbacks();
    const interaction = toAuthInteraction(cb);

    interaction.notify({ type: "auth_url", url: "https://auth", instructions: "go" });
    expect(cb.onAuth).toHaveBeenCalledWith({ url: "https://auth", instructions: "go" });

    interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://dev" });
    expect(cb.onDeviceCode).toHaveBeenCalledWith({ userCode: "ABCD", verificationUri: "https://dev" });

    interaction.notify({ type: "info", message: "hello" });
    interaction.notify({ type: "progress", message: "working" });
    expect(cb.onProgress).toHaveBeenNthCalledWith(1, "hello");
    expect(cb.onProgress).toHaveBeenNthCalledWith(2, "working");
  });

  it("tolerates the optional progress callback being absent", () => {
    const { onProgress: _omitted, ...withoutProgress } = callbacks();
    expect(() => toAuthInteraction(withoutProgress).notify({ type: "info", message: "hi" }))
      .not.toThrow();
  });

  it("forwards an abort signal only when one was supplied", () => {
    const signal = new AbortController().signal;
    expect(toAuthInteraction(callbacks({ signal })).signal).toBe(signal);
    expect(Object.hasOwn(toAuthInteraction(callbacks()), "signal")).toBe(false);
  });
});

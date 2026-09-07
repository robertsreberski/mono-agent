import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { classifyProviderCheckFailure, runPiProviderCheck } from "../../ai/provider-check.js";

describe("provider check", () => {
  it("runs one isolated target request with bounded output and the supplied auth context", async () => {
    const resolver = vi.fn();
    const execute = vi.fn(async () => ({ text: "OK", failureKind: null }));
    const outcome = await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap", reference: "fixture:cheap" },
      resolvePiApiKey: resolver,
      environment: { FIXTURE_API_KEY: "secret-not-returned" },
      execute,
    });

    expect(outcome).toEqual({ state: "passed", code: "passed", message: "Provider request succeeded." });
    expect(execute).toHaveBeenCalledOnce();
    const [system, options] = execute.mock.calls[0];
    expect(system).toBe("Provider connectivity check. Reply OK.");
    expect(options).toMatchObject({
      model: { provider: "fixture", model: "cheap", reference: "fixture:cheap" },
      messages: [{ role: "user", content: "OK" }],
      effort: "none",
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      maxTurns: 1,
      piMaxRetries: 0,
      providerCheckMaxTokens: 4,
      resolvePiApiKey: resolver,
    });
    expect(await options.providerCheckAuthContext.env("FIXTURE_API_KEY")).toBe("secret-not-returned");
    expect(options).not.toHaveProperty("sessionId");
    expect(JSON.stringify(outcome)).not.toContain("secret-not-returned");
  });

  it("caps the model dispatched to the real provider transport", async () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "provider-check-cap-"));
    try {
      const faux = fauxProvider({
        provider: "provider-check-cap",
        models: [{ id: "fixture", maxTokens: 64 }],
        tokensPerSecond: undefined,
      });
      const models = createModels();
      models.setProvider(faux.provider);
      const model = faux.getModel("fixture");
      if (!model) throw new Error("faux model missing");
      /** @type {number|undefined} */
      let dispatchedMaxTokens;
      faux.setResponses([(_context, _options, _state, requestModel) => {
        dispatchedMaxTokens = requestModel.maxTokens;
        return fauxAssistantMessage([fauxText("OK")]);
      }]);

      const outcome = await runPiProviderCheck({
        model: { provider: model.provider, model: model.id },
        resolvePiApiKey: async () => "FAUX_ONLY_NOT_A_CREDENTIAL",
        runtimeOptions: {
          piResolvedModel: model,
          piResolvedModels: models,
          piSessionsRoot: sessionsRoot,
        },
      });

      expect(outcome.state).toBe("passed");
      expect(faux.state.callCount).toBe(1);
      expect(dispatchedMaxTokens).toBe(4);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("returns only closed sanitized categories for provider-controlled failures", async () => {
    const secret = "RAW_PROVIDER_SECRET_SENTINEL";
    const outcome = await runPiProviderCheck({
      model: { provider: "fixture", model: "cheap" },
      execute: vi.fn(async () => ({ error: `401 token_revoked ${secret}`, failureKind: "provider_auth" })),
    });
    expect(outcome).toEqual({
      state: "auth_failed",
      code: "credential_rejected",
      message: "Provider rejected the configured credential.",
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it.each([
    ["401 Unauthorized", undefined, "auth_failed"],
    ["invalid_grant", undefined, "auth_failed"],
    ["429 insufficient_quota", undefined, "quota_limited"],
    ["model_not_found", undefined, "model_not_entitled"],
    ["403 Forbidden", undefined, "inconclusive"],
    ["ECONNREFUSED", "provider_unavailable", "network_failed"],
  ])("classifies %s narrowly", (text, failureKind, state) => {
    expect(classifyProviderCheckFailure(text, failureKind).state).toBe(state);
  });
});

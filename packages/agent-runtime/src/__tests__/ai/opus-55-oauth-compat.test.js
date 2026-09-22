import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { registerPiSupplementModels } from "../../ai/pi-supplement.js";
import { withOpus55OAuthVersion } from "../../ai/providers/pi-native/opus-55-oauth-compat.js";

const OAUTH = "sk-ant-oat-synthetic-test-only";
const API_KEY = "sk-ant-api03-synthetic-test-only";
const context = { systemPrompt: "test", messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function catalog() {
  const models = builtinModels();
  registerPiSupplementModels(models);
  withOpus55OAuthVersion(models);
  return models;
}

async function capturedRequest(models, model, apiKey, headers) {
  let captured;
  const result = await models.streamSimple(model, context, {
    apiKey,
    ...(headers ? { headers } : {}),
    maxRetries: 0,
    fetch: async (_url, init) => {
      captured = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
      // No provider network, token or live auth: stop after capturing the real
      // pi-ai + Anthropic SDK request bytes.
      return new Response(JSON.stringify({ error: { type: "test_error", message: "intercepted" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    },
  }).result();
  expect(result.stopReason).toBe("error");
  expect(captured).toBeDefined();
  return captured;
}

describe("temporary Opus 5.5 Anthropic OAuth compatibility", () => {
  it("sends Claude Code 2.1.280 through the real OAuth transport, not just the catalog row", async () => {
    const models = catalog();
    const model = models.getModel("anthropic", "claude-opus-5-5");
    expect(model.headers).toBeUndefined();
    const { headers, body } = await capturedRequest(models, model, OAUTH);
    expect(body.model).toBe("claude-opus-5-5");
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.280");
    expect(headers.get("x-app")).toBe("cli");
  });

  it("leaves API-key requests and other OAuth models on pi's original identity", async () => {
    const models = catalog();
    const opus = models.getModel("anthropic", "claude-opus-5-5");
    const sibling = models.getModel("anthropic", "claude-opus-5");
    const api = await capturedRequest(models, opus, API_KEY);
    expect(api.headers.get("user-agent")).not.toBe("claude-cli/2.1.280");
    expect(api.headers.get("x-api-key")).toBe(API_KEY);
    const oauth = await capturedRequest(models, sibling, OAUTH);
    // Removal gate: when pi-ai ships 3a624b82 this will become 2.1.280.
    // Remove the compatibility wrapper and this test on that upgrade.
    expect(oauth.headers.get("user-agent")).toBe("claude-cli/2.1.251");
  });

  it("does not replace explicit model and request user agents", async () => {
    const models = catalog();
    const opus = models.getModel("anthropic", "claude-opus-5-5");
    const modelHeader = await capturedRequest(models,
      { ...opus, headers: { "user-agent": "caller-model" } }, OAUTH);
    expect(modelHeader.headers.get("user-agent")).toBe("caller-model");
    const requestHeader = await capturedRequest(models, opus, OAUTH, { "user-agent": "caller-request" });
    expect(requestHeader.headers.get("user-agent")).toBe("caller-request");
  });

  it("still applies when the upstream catalog owns the Opus 5.5 row", async () => {
    const models = catalog();
    const provider = models.getProvider("anthropic");
    const opus = models.getModel("anthropic", "claude-opus-5-5");
    models.setProvider({ ...provider, getModels: () => [...provider.getModels(), opus] });
    // A real upstream row is not replaced by the supplement. The transport
    // fix has a separate removal condition: the upstream OAuth version bump.
    expect(registerPiSupplementModels(models)).not.toContain("anthropic:claude-opus-5-5");
    withOpus55OAuthVersion(models);
    const sent = await capturedRequest(models, models.getModel("anthropic", "claude-opus-5-5"), OAUTH);
    expect(sent.headers.get("user-agent")).toBe("claude-cli/2.1.280");
  });
});

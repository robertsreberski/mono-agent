import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

const context = { systemPrompt: "test", messages: [{ role: "user", content: "hello", timestamp: 1 }] };

async function capturedRequest(model, apiKey) {
  let captured;
  const result = await builtinModels().streamSimple(model, context, {
    apiKey,
    maxRetries: 0,
    fetch: async (_url, init) => {
      captured = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
      // Intercept Pi's real transport before network; synthetic credentials only.
      return new Response(JSON.stringify({ error: { type: "test_error", message: "intercepted" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    },
  }).result();
  expect(result.stopReason).toBe("error");
  expect(captured).toBeDefined();
  return captured;
}

describe("Pi 0.87.1 Anthropic OAuth transport", () => {
  it("sends the upstream Claude Code 2.1.280 identity for native Opus 5.5", async () => {
    const model = builtinModels().getModel("anthropic", "claude-opus-5-5");
    expect(model).toBeDefined();
    const sent = await capturedRequest(model, "sk-ant-oat-synthetic-test-only");
    expect(sent.body.model).toBe("claude-opus-5-5");
    expect(sent.headers.get("user-agent")).toBe("claude-cli/2.1.280");
    expect(sent.headers.get("x-app")).toBe("cli");
  });

  it("does not apply OAuth identity to an API-key request", async () => {
    const model = builtinModels().getModel("anthropic", "claude-opus-5-5");
    const sent = await capturedRequest(model, "sk-ant-api03-synthetic-test-only");
    expect(sent.headers.get("user-agent")).not.toBe("claude-cli/2.1.280");
  });
});

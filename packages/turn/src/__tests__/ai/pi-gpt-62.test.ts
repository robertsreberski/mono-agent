import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getPiBuiltinModel, listPiBuiltinModels, reasoningLevelsForPiModel } from "../../providers/pi/catalog.js";
import { effectivePayloadEffort } from "../../providers/pi/effective-effort.js";
import { resolvePiRuntimeModel } from "../../providers/pi/models.js";
import { supportsPiContext1M } from "../../providers/pi/context-1m.js";
import { estimateCost, resolvePricing } from "../../telemetry/cost.js";
import { buildRunModels } from "../../execution/pi/run.js";
import type { PiRuntime } from "../../execution/pi/types.js";

const providers = ["openai", "openai-codex"] as const;
const variants = ["sol", "astra"] as const;
afterEach(() => vi.unstubAllGlobals());

for (const provider of providers) for (const variant of variants) {
  const id = `gpt-6.2-${variant}` as const;
  const reference = `${provider}:${id}`;
  const input = variant === "sol" ? 2 : 8;

  describe(reference, () => {
    it("uses Pi's native GPT-6.2 row without changing the model reference or opt-in context", () => {
      const model = getPiBuiltinModel(provider, id)!;
      expect(model).toEqual(getBuiltinModel(provider, id));
      expect(model).toMatchObject({ id, name: `GPT-6.2 ${variant === "sol" ? "Sol" : "Astra"}`, maxTokens: 128_000 });
      expect(listPiBuiltinModels(provider).filter((row) => row.id === id)).toEqual([model]);
      expect(reasoningLevelsForPiModel(model)).not.toContain("none");
      expect(supportsPiContext1M(reference)).toBe(true);
      const runtime = resolvePiRuntimeModel({ provider, model: id }, {});
      expect(runtime.model).toEqual(model);
      expect(resolvePiRuntimeModel({ provider, model: id }, { context1MModels: { [reference]: true } }).model.contextWindow).toBe(1_000_000);
      model.cost.input = -1;
      expect(getPiBuiltinModel(provider, id)!.cost.input).toBe(input);
    });

    it("prices base, boundary and whole-request long-input tiers including caches", () => {
      expect(resolvePricing({ model: reference })).toMatchObject({ input, output: input * 5, cacheRead: input / 20, cacheWrite: input * 1.25, priced: true });
      for (const tokens of [271999, 272000, 272001]) {
        const long = tokens > 272000;
        // Pi counts cached tokens toward the prompt threshold.
        const cost = estimateCost({ model: reference, inputTokens: tokens - 2000, cachedTokens: 1000, cacheWriteTokens: 1000, outputTokens: 100 });
        const expected = ((tokens - 2000) * input * (long ? 2 : 1)
          + 1000 * input / 20 * (long ? 2 : 1)
          + 1000 * input * 1.25 * (long ? 2 : 1)
          + 100 * input * 5 * (long ? 1.5 : 1)) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 10);
      }
    });

    it("dispatches through the real built-in provider implementation with isolated transport", async () => {
      const access = ["fictional", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64"), "fictional"].join(".");
      const credential = provider === "openai-codex"
        ? { type: "oauth" as const, access, refresh: "fictional", expires: Date.now() + 3_600_000 }
        : { type: "api_key" as const, key: "sk-fictional-test-only" };
      const resolver = Object.assign(async () => "sk-fictional-test-only", { readCredential: async () => credential });
      const models = buildRunModels({ apiKeys: new Map() } as PiRuntime, { resolvePiApiKey: resolver }, []);
      const model = models.getModel(provider, id)!;
      expect(model).toEqual(getPiBuiltinModel(provider, id));
      const transport = vi.fn(async () => new Response([
        { type: "response.created", response: { id: "fictional", status: "in_progress", output: [] } },
        { type: "response.completed", response: { id: "fictional", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
      vi.stubGlobal("fetch", transport);
      const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Fictional request", timestamp: 0 }] }, { reasoning: "high", transport: "sse", maxRetries: 0 });
      expect(result.stopReason).not.toBe("error");
      expect(transport).toHaveBeenCalledOnce();
      const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain(provider === "openai" ? "api.openai.com/v1/responses" : "chatgpt.com/backend-api/codex/responses");
      const body = new Headers(init.headers).get("content-encoding") === "zstd"
        ? zstdDecompressSync(Buffer.from(init.body as Uint8Array)).toString()
        : init.body as string;
      const payload = JSON.parse(body);
      expect(payload.model).toBe(id);
      expect(payload.reasoning.effort).toBeDefined();
      // Native mid-conversation effort puts the selected level on the input,
      // not on the fixed top-level reasoning cache anchor.
      expect(effectivePayloadEffort(payload, model)).toBe("high");
      expect(payload.input).toContainEqual(expect.objectContaining({ type: "configuration_update", reasoning: { effort: "high" } }));
    });
  });
}

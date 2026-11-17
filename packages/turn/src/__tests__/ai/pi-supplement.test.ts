import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getPiBuiltinModel, listPiBuiltinModels, reasoningLevelsForPiModel } from "../../providers/pi/catalog.js";
import { registerPiSupplementModels } from "../../providers/pi/supplement.js";
import { resolvePiRuntimeModel } from "../../providers/pi/models.js";
import { supportsPiContext1M } from "../../providers/pi/context-1m.js";
import { estimateCost, resolvePricing } from "../../telemetry/cost.js";
import { buildRunModels } from "../../execution/pi/run.js";
import type { PiRuntime } from "../../execution/pi/types.js";

const providers = ["openai", "openai-codex"] as const;
const variants = ["sol", "astra"] as const;
afterEach(() => vi.unstubAllGlobals());

for (const provider of providers) for (const variant of variants) {
  const id = `gpt-6.2-${variant}`;
  const reference = `${provider}:${id}`;
  const siblingId = variant === "sol" ? "gpt-6.1-sol" : "gpt-6-astra";
  const input = variant === "sol" ? 2 : 8;

  describe(reference, () => {
    it("backfills only the pinned upstream gap with sibling capabilities", () => {
      // Remove this supplement once these preconditions stop holding after a Pi upgrade.
      expect(getBuiltinModel(provider as any, id)).toBeUndefined();
      const sibling = getBuiltinModel(provider, siblingId)!;
      const model = getPiBuiltinModel(provider, id)!;
      expect(model).toEqual({ ...sibling, id, name: `GPT-6.2 ${variant === "sol" ? "Sol" : "Astra"}`, cost: {
        input, output: input * 5, cacheRead: input / 20, cacheWrite: input * 1.25,
        tiers: [{ inputTokensAbove: 272000, input: input * 2, output: input * 7.5, cacheRead: input / 10, cacheWrite: input * 2.5 }],
      } });
      expect(listPiBuiltinModels(provider).filter((row) => row.id === id)).toEqual([model]);
      expect(reasoningLevelsForPiModel(model)).toEqual(reasoningLevelsForPiModel(sibling));
      expect(reasoningLevelsForPiModel(model)).not.toContain("none");
      expect(supportsPiContext1M(reference)).toBe(supportsPiContext1M(`${provider}:${siblingId}`));
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
        : { type: "api_key" as const, key: "fictional-unused-key" };
      const resolver = Object.assign(async () => "fictional-unused-key", { readCredential: async () => credential });
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
      expect(JSON.parse(body)).toMatchObject({ model: id, reasoning: { effort: "high" } });
    });
  });
}

it("registers both missing rows per provider once, preserves siblings, and is idempotent", () => {
  const models = builtinModels();
  const setProvider = vi.spyOn(models, "setProvider");
  registerPiSupplementModels(models);
  registerPiSupplementModels(models);
  expect(setProvider).toHaveBeenCalledTimes(2);
  for (const provider of providers) {
    for (const id of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6-astra"]) {
      expect(models.getModel(provider, id)?.id).toBe(id);
    }
  }
});

it("does not populate absent providers or alter the verbatim Models seam", () => {
  const models = { getProvider: () => undefined, setProvider: vi.fn() };
  registerPiSupplementModels(models as never);
  expect(models.setProvider).not.toHaveBeenCalled();
  expect(buildRunModels({} as PiRuntime, { piResolvedModels: models as never }, [])).toBe(models);
});

it("keeps unknown refs and unverified providers out of the supplement", () => {
  expect(() => resolvePiRuntimeModel({ provider: "openai-codex", model: "gpt-6.3-sol" }, {})).toThrow("pi model not found");
  expect(getPiBuiltinModel("github-copilot", "gpt-6.2-sol")).toBeUndefined();
});

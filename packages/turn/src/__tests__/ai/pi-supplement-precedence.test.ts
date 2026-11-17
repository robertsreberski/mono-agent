import { expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/providers/all", async (original) => {
  const upstream = await original<typeof import("@earendil-works/pi-ai/providers/all")>();
  const native = { ...upstream.getBuiltinModel("openai", "gpt-6.1-sol")!, id: "gpt-6.2-sol", name: "Fictional upstream row", contextWindow: 900000, cost: { input: 99, output: 199, cacheRead: 9, cacheWrite: 19 } };
  return {
    ...upstream,
    getBuiltinModel: (provider: string, id: string) => provider === "openai" && id === native.id ? native : upstream.getBuiltinModel(provider as never, id),
    getBuiltinModels: (provider: string) => [...upstream.getBuiltinModels(provider as never), ...(provider === "openai" ? [native] : [])],
  };
});

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getPiBuiltinModel, listPiBuiltinModels } from "../../providers/pi/catalog.js";
import { registerPiSupplementModels } from "../../providers/pi/supplement.js";
import { estimateCost } from "../../telemetry/cost.js";
import { supportsPiContext1M } from "../../providers/pi/context-1m.js";
import { resolvePiRuntimeModel } from "../../providers/pi/models.js";

it("lets a future upstream row win in lookup, listing and runtime resolution", () => {
  const native = getPiBuiltinModel("openai", "gpt-6.2-sol")!;
  expect(native.name).toBe("Fictional upstream row");
  expect(native.contextWindow).toBe(900000);
  expect(estimateCost({ model: "openai:gpt-6.2-sol", inputTokens: 1_000_000 })).toBe(99);
  expect(supportsPiContext1M("openai:gpt-6.2-sol")).toBe(false);
  expect(listPiBuiltinModels("openai").filter((row) => row.id === native.id)).toEqual([native]);
  expect(resolvePiRuntimeModel({ provider: "openai", model: native.id }, {}).model).toEqual(native);
});

it("preserves collection-owned upstream rows while registering the other missing row", () => {
  const models = builtinModels();
  const provider = models.getProvider("openai")!;
  const native = getPiBuiltinModel("openai", "gpt-6.2-sol")!;
  models.setProvider({ ...provider, getModels: () => [...provider.getModels(), native as never] });
  registerPiSupplementModels(models);
  expect(models.getModel("openai", native.id)).toEqual(native);
  expect(models.getModels("openai").filter((row) => row.id === native.id)).toHaveLength(1);
  expect(models.getModel("openai", "gpt-6.2-astra")).toBeDefined();
});

import { createModels } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
  getPiSupplementModel,
  listPiSupplementModels,
  registerPiSupplementModels,
} from "../../ai/pi-supplement.js";
import { reasoningLevelsForPiModel } from "../../ai/providers/pi-models.js";

const EXPECTED_ROW = {
  id: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  },
  promptCache: { short: 300, long: 3600 },
  inputLimits: {
    maxRequestBytes: 33_554_432,
    images: {
      maxPerRequest: 600,
      resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
    },
  },
};

describe("Pi catalog supplement", () => {
  it("fills exactly the pinned Pi 0.87.1 gap for Claude Sonnet 5.5", () => {
    expect(getBuiltinModel("anthropic", "claude-sonnet-5-5")).toBeUndefined();
    expect(getPiSupplementModel("anthropic", "claude-sonnet-5-5")).toEqual(EXPECTED_ROW);
    expect(listPiSupplementModels("anthropic")).toEqual([EXPECTED_ROW]);
  });

  it("uses adaptive low-through-max effort without unsupported disabled thinking", () => {
    expect(reasoningLevelsForPiModel(EXPECTED_ROW))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("never creates rows for unrelated providers or ids", () => {
    expect(getPiSupplementModel("anthropic", "claude-sonnet-5")).toBeUndefined();
    expect(getPiSupplementModel("openai", "claude-sonnet-5-5")).toBeUndefined();
    expect(listPiSupplementModels("openai")).toEqual([]);
  });

  it("returns defensive snapshots", () => {
    const row = getPiSupplementModel("anthropic", "claude-sonnet-5-5");
    row.cost.input = 999;
    row.input.push("video");
    expect(getPiSupplementModel("anthropic", "claude-sonnet-5-5")).toEqual(EXPECTED_ROW);
  });
});

describe("registerPiSupplementModels", () => {
  it("registers the missing row for Pi harness dispatch and is idempotent", () => {
    const models = builtinModels();
    const before = models.getModels("anthropic").length;
    expect(registerPiSupplementModels(models)).toEqual(["anthropic:claude-sonnet-5-5"]);
    expect(models.getModel("anthropic", "claude-sonnet-5-5")).toEqual(EXPECTED_ROW);
    expect(models.getModels("anthropic")).toHaveLength(before + 1);
    expect(registerPiSupplementModels(models)).toEqual([]);
  });

  it("does not shadow a row already present in the collection", () => {
    const models = builtinModels();
    const provider = models.getProvider("anthropic");
    const baseGetModels = provider.getModels.bind(provider);
    const upstream = { ...EXPECTED_ROW, name: "Claude Sonnet 5.5 (upstream)" };
    models.setProvider({ ...provider, getModels: () => [...baseGetModels(), upstream] });

    expect(registerPiSupplementModels(models)).toEqual([]);
    expect(models.getModel("anthropic", "claude-sonnet-5-5"))
      .toMatchObject({ name: "Claude Sonnet 5.5 (upstream)" });
  });

  it("leaves collections without Anthropic untouched", () => {
    const models = createModels();
    expect(registerPiSupplementModels(models)).toEqual([]);
  });
});

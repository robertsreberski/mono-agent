// Catalog supplement for `opencode-go:deepseek-v4.1-flash` (see
// `ai/pi-supplement.js`). These tests run against pi-ai's REAL pinned catalog:
// the supplement must fill exactly the upstream gap, never shadow a real
// builtin, and register into a real `Models` collection for dispatch.

import { createModels } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
  getPiSupplementModel,
  listPiSupplementModels,
  registerPiSupplementModels,
} from "../../ai/pi-supplement.js";

const EXPECTED_ROW = {
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
  contextWindow: 1000000,
  maxTokens: 384000,
  thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
};

describe("pi catalog supplement", () => {
  it("fills exactly the upstream gap for opencode-go:deepseek-v4.1-flash", () => {
    // Precondition: the pinned pi-ai really does not ship this model. If this
    // fails after a pi-ai upgrade, the supplement is dead weight — delete it
    // per the removal instruction at the top of ai/pi-supplement.js.
    expect(getBuiltinModel("opencode-go", "deepseek-v4.1-flash")).toBeUndefined();
    expect(getPiSupplementModel("opencode-go", "deepseek-v4.1-flash")).toEqual(EXPECTED_ROW);
  });

  it("never shadows a real pi builtin", () => {
    expect(getPiSupplementModel("opencode-go", "deepseek-v4-flash")).toBeUndefined();
    expect(getPiSupplementModel("anthropic", "claude-sonnet-4-6")).toBeUndefined();
    expect(listPiSupplementModels("anthropic")).toEqual([]);
  });

  it("returns undefined for unknown providers and models", () => {
    expect(getPiSupplementModel("opencode-go", "deepseek-v9-flash")).toBeUndefined();
    expect(getPiSupplementModel("mystery", "deepseek-v4.1-flash")).toBeUndefined();
    expect(listPiSupplementModels("mystery")).toEqual([]);
  });

  it("lists the single supplemented row per provider and overall", () => {
    expect(listPiSupplementModels("opencode-go").map((row) => row.id))
      .toEqual(["deepseek-v4.1-flash"]);
    expect(listPiSupplementModels().map((row) => `${row.provider}:${row.id}`))
      .toEqual(["opencode-go:deepseek-v4.1-flash"]);
  });

  it("hands out fresh snapshots so callers cannot mutate shared state", () => {
    const first = getPiSupplementModel("opencode-go", "deepseek-v4.1-flash");
    first.cost.input = 999;
    first.input.push("video");
    expect(getPiSupplementModel("opencode-go", "deepseek-v4.1-flash")).toEqual(EXPECTED_ROW);

    const listed = listPiSupplementModels("opencode-go");
    listed[0].compat.supportsStore = true;
    expect(getPiSupplementModel("opencode-go", "deepseek-v4.1-flash")).toEqual(EXPECTED_ROW);
  });
});

describe("registerPiSupplementModels", () => {
  it("registers the supplement into a real builtin Models collection for dispatch", () => {
    const models = builtinModels();
    const upstreamCount = models.getModels("opencode-go").length;

    expect(registerPiSupplementModels(models)).toEqual(["opencode-go:deepseek-v4.1-flash"]);
    expect(models.getModel("opencode-go", "deepseek-v4.1-flash")).toMatchObject({
      id: "deepseek-v4.1-flash",
      provider: "opencode-go",
      api: "openai-completions",
    });
    // Upstream rows are untouched: same count plus exactly one.
    expect(models.getModels("opencode-go")).toHaveLength(upstreamCount + 1);
    expect(models.getModel("opencode-go", "deepseek-v4-flash")).toMatchObject({
      id: "deepseek-v4-flash",
      input: ["text"],
    });
    expect(models.getModel("opencode-go", "deepseek-v9-flash")).toBeUndefined();
  });

  it("is idempotent and prefers collection state over re-registering", () => {
    const models = builtinModels();
    expect(registerPiSupplementModels(models)).toEqual(["opencode-go:deepseek-v4.1-flash"]);
    // Second call sees the id already resolving and registers nothing.
    expect(registerPiSupplementModels(models)).toEqual([]);
    const ids = models.getModels("opencode-go").map((model) => model.id);
    expect(ids.filter((id) => id === "deepseek-v4.1-flash")).toHaveLength(1);
  });

  it("leaves collections without the provider untouched", () => {
    const models = createModels();
    expect(registerPiSupplementModels(models)).toEqual([]);
    expect(models.getModel("opencode-go", "deepseek-v4.1-flash")).toBeUndefined();
  });
});

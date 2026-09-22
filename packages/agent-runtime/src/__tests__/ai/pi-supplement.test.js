// Catalog supplement for `anthropic:claude-opus-5-5`,
// `openai-codex:gpt-6-sol` and `openai-codex:gpt-6-luna` (see
// `ai/pi-supplement.js`). These tests run against pi-ai's REAL pinned catalog:
// every row must fill exactly its upstream gap, never shadow a real builtin,
// and register into a real `Models` collection for dispatch.

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
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  contextWindow: 1000000,
  maxTokens: 128000,
  compat: {
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  },
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  promptCache: { short: 300, long: 3600 },
  inputLimits: {
    maxRequestBytes: 33554432,
    images: {
      maxPerRequest: 600,
      resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
    },
  },
};

const CODEX_SHARED = {
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1050000,
  maxTokens: 128000,
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true,
  },
  // `minimal` maps onto the provider's `low` exactly as pi-ai's own
  // gpt-5.6-sol/luna rows do, and `off` is NOT nulled: both models support
  // `reasoning.effort: none`.
  thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
  inputLimits: {
    images: {
      resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
    },
  },
};

const EXPECTED_SOL_ROW = {
  ...CODEX_SHARED,
  id: "gpt-6-sol",
  name: "GPT-6 Sol",
  cost: {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    // Published rule: over 272K input tokens the whole request bills at 2x
    // input and cache rates and 1.5x output.
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
  },
};

const EXPECTED_LUNA_ROW = {
  ...CODEX_SHARED,
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  cost: {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{
      inputTokensAbove: 272000,
      input: 0.2,
      output: 0.75,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    }],
  },
};

describe("pi catalog supplement", () => {
  it("fills exactly the upstream gap for anthropic:claude-opus-5-5", () => {
    // Precondition: the pinned pi-ai really does not ship this model. If this
    // fails after a pi-ai upgrade, the supplement is dead weight — delete it
    // per the removal instruction at the top of ai/pi-supplement.js.
    expect(getBuiltinModel("anthropic", "claude-opus-5-5")).toBeUndefined();
    expect(getPiSupplementModel("anthropic", "claude-opus-5-5")).toEqual(EXPECTED_ROW);
  });

  it("derives exactly low/medium/high/xhigh/max effort levels (no none, no minimal)", () => {
    // Thinking is always on for this model, so `off` maps to null (no `none`)
    // and `minimal` is nulled: every other level is supported unless nulled,
    // and xhigh/max are included only when explicitly mapped.
    const row = getPiSupplementModel("anthropic", "claude-opus-5-5");
    expect(reasoningLevelsForPiModel(row)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("fills exactly the upstream gap for openai-codex:gpt-6-sol and gpt-6-luna", () => {
    // Same live precondition as the anthropic row: pinned pi-ai 0.87.0 ships
    // gpt-5.6-sol/luna and gpt-6-astra on `openai-codex`, but neither GPT-6
    // model. A failure here means upstream caught up — drop that row.
    expect(getBuiltinModel("openai-codex", "gpt-6-sol")).toBeUndefined();
    expect(getBuiltinModel("openai-codex", "gpt-6-luna")).toBeUndefined();
    expect(getPiSupplementModel("openai-codex", "gpt-6-sol")).toEqual(EXPECTED_SOL_ROW);
    expect(getPiSupplementModel("openai-codex", "gpt-6-luna")).toEqual(EXPECTED_LUNA_ROW);
  });

  it("derives none through max effort levels for the codex rows", () => {
    // `off` is unmapped (so `none` survives as the disabled level) and
    // `minimal` aliases `low`, matching the upstream gpt-5.6 sibling rows.
    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(reasoningLevelsForPiModel(getPiSupplementModel("openai-codex", "gpt-6-sol")))
      .toEqual(levels);
    expect(reasoningLevelsForPiModel(getPiSupplementModel("openai-codex", "gpt-6-luna")))
      .toEqual(levels);
  });

  it("never shadows a real pi builtin", () => {
    expect(getPiSupplementModel("anthropic", "claude-opus-5")).toBeUndefined();
    expect(getPiSupplementModel("anthropic", "claude-sonnet-4-6")).toBeUndefined();
    expect(getPiSupplementModel("opencode-go", "deepseek-v4.1-flash")).toBeUndefined();
    expect(listPiSupplementModels("opencode-go")).toEqual([]);
    // The codex models pi-ai does ship stay upstream-only, including the
    // template row and the other GPT-6 the catalog already carries.
    expect(getPiSupplementModel("openai-codex", "gpt-5.6-sol")).toBeUndefined();
    expect(getPiSupplementModel("openai-codex", "gpt-6-astra")).toBeUndefined();
    expect(getBuiltinModel("openai-codex", "gpt-5.6-sol")).toMatchObject({ id: "gpt-5.6-sol" });
    expect(getBuiltinModel("openai-codex", "gpt-6-astra")).toMatchObject({ id: "gpt-6-astra" });
    // `openai` is a different provider and gets no codex backfill.
    expect(getPiSupplementModel("openai", "gpt-6-sol")).toBeUndefined();
    expect(listPiSupplementModels("openai")).toEqual([]);
  });

  it("returns undefined for unknown providers and models", () => {
    expect(getPiSupplementModel("anthropic", "claude-opus-9")).toBeUndefined();
    expect(getPiSupplementModel("mystery", "claude-opus-5-5")).toBeUndefined();
    expect(getPiSupplementModel("openai-codex", "gpt-6-nemesis")).toBeUndefined();
    expect(getPiSupplementModel("mystery", "gpt-6-sol")).toBeUndefined();
    expect(listPiSupplementModels("mystery")).toEqual([]);
  });

  it("lists the supplemented rows per provider and across providers", () => {
    expect(listPiSupplementModels("anthropic").map((row) => row.id))
      .toEqual(["claude-opus-5-5"]);
    expect(listPiSupplementModels("openai-codex").map((row) => row.id))
      .toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect(listPiSupplementModels().map((row) => `${row.provider}:${row.id}`))
      .toEqual([
        "anthropic:claude-opus-5-5",
        "openai-codex:gpt-6-sol",
        "openai-codex:gpt-6-luna",
      ]);
  });

  it("hands out fresh snapshots so callers cannot mutate shared state", () => {
    const first = getPiSupplementModel("anthropic", "claude-opus-5-5");
    first.cost.input = 999;
    first.input.push("video");
    expect(getPiSupplementModel("anthropic", "claude-opus-5-5")).toEqual(EXPECTED_ROW);

    const listed = listPiSupplementModels("anthropic");
    listed[0].compat.supportsTemperature = true;
    expect(getPiSupplementModel("anthropic", "claude-opus-5-5")).toEqual(EXPECTED_ROW);

    const sol = getPiSupplementModel("openai-codex", "gpt-6-sol");
    sol.cost.tiers[0].input = 999;
    sol.thinkingLevelMap.max = null;
    expect(getPiSupplementModel("openai-codex", "gpt-6-sol")).toEqual(EXPECTED_SOL_ROW);

    const codex = listPiSupplementModels("openai-codex");
    codex[1].compat.supportsToolSearch = false;
    expect(getPiSupplementModel("openai-codex", "gpt-6-luna")).toEqual(EXPECTED_LUNA_ROW);
  });
});

const ALL_SUPPLEMENT_REFS = [
  "anthropic:claude-opus-5-5",
  "openai-codex:gpt-6-sol",
  "openai-codex:gpt-6-luna",
];

describe("registerPiSupplementModels", () => {
  it("registers every supplemented row across providers for dispatch", () => {
    const models = builtinModels();
    const upstreamAnthropic = models.getModels("anthropic").length;
    const upstreamCodex = models.getModels("openai-codex").length;

    // The helper walks MORE THAN ONE provider group: both providers gain their
    // own rows in a single pass.
    expect(registerPiSupplementModels(models)).toEqual(ALL_SUPPLEMENT_REFS);
    expect(models.getModel("anthropic", "claude-opus-5-5")).toMatchObject({
      id: "claude-opus-5-5",
      provider: "anthropic",
      api: "anthropic-messages",
    });
    expect(models.getModel("openai-codex", "gpt-6-sol")).toMatchObject({
      id: "gpt-6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      contextWindow: 1050000,
    });
    expect(models.getModel("openai-codex", "gpt-6-luna")).toMatchObject({
      id: "gpt-6-luna",
      provider: "openai-codex",
      api: "openai-codex-responses",
      contextWindow: 1050000,
    });
    // Upstream rows are untouched: each provider grows by exactly its own rows.
    expect(models.getModels("anthropic")).toHaveLength(upstreamAnthropic + 1);
    expect(models.getModels("openai-codex")).toHaveLength(upstreamCodex + 2);
    expect(models.getModel("anthropic", "claude-opus-5")).toMatchObject({
      id: "claude-opus-5",
    });
    expect(models.getModel("openai-codex", "gpt-5.6-sol")).toMatchObject({
      id: "gpt-5.6-sol",
    });
    expect(models.getModel("anthropic", "claude-opus-9")).toBeUndefined();
    expect(models.getModel("openai-codex", "gpt-6-nemesis")).toBeUndefined();
    // A provider with no supplemented rows is left exactly as upstream shipped.
    expect(models.getModel("openai", "gpt-6-sol")).toBeUndefined();
  });

  it("is idempotent and prefers collection state over re-registering", () => {
    const models = builtinModels();
    expect(registerPiSupplementModels(models)).toEqual(ALL_SUPPLEMENT_REFS);
    // Second call sees every id already resolving and registers nothing.
    expect(registerPiSupplementModels(models)).toEqual([]);
    const anthropicIds = models.getModels("anthropic").map((model) => model.id);
    expect(anthropicIds.filter((id) => id === "claude-opus-5-5")).toHaveLength(1);
    const codexIds = models.getModels("openai-codex").map((model) => model.id);
    expect(codexIds.filter((id) => id === "gpt-6-sol")).toHaveLength(1);
    expect(codexIds.filter((id) => id === "gpt-6-luna")).toHaveLength(1);
  });

  it("registers only the rows a provider is still missing", () => {
    const models = builtinModels();
    const provider = models.getProvider("openai-codex");
    const baseGetModels = provider.getModels.bind(provider);
    const shipped = {
      ...getPiSupplementModel("openai-codex", "gpt-6-sol"),
      name: "GPT-6 Sol (upstream)",
    };
    models.setProvider({ ...provider, getModels: () => [...baseGetModels(), shipped] });

    // Simulates pi-ai shipping ONE of the two codex ids: the collection already
    // resolves it, so only the still-missing row is registered and the
    // collection's own row survives untouched (upstream wins at dispatch too).
    expect(registerPiSupplementModels(models)).toEqual([
      "anthropic:claude-opus-5-5",
      "openai-codex:gpt-6-luna",
    ]);
    expect(models.getModel("openai-codex", "gpt-6-sol"))
      .toMatchObject({ name: "GPT-6 Sol (upstream)" });
    expect(models.getModel("openai-codex", "gpt-6-luna")).toMatchObject({ name: "GPT-6 Luna" });
  });

  it("leaves collections without the provider untouched", () => {
    const models = createModels();
    expect(registerPiSupplementModels(models)).toEqual([]);
    expect(models.getModel("anthropic", "claude-opus-5-5")).toBeUndefined();
    expect(models.getModel("openai-codex", "gpt-6-sol")).toBeUndefined();
  });
});

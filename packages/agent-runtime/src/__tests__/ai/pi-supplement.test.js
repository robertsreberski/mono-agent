// Catalog supplement for `anthropic:claude-opus-5-5` (see
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

  it("never shadows a real pi builtin", () => {
    expect(getPiSupplementModel("anthropic", "claude-opus-5")).toBeUndefined();
    expect(getPiSupplementModel("anthropic", "claude-sonnet-4-6")).toBeUndefined();
    expect(getPiSupplementModel("opencode-go", "deepseek-v4.1-flash")).toBeUndefined();
    expect(listPiSupplementModels("opencode-go")).toEqual([]);
  });

  it("returns undefined for unknown providers and models", () => {
    expect(getPiSupplementModel("anthropic", "claude-opus-9")).toBeUndefined();
    expect(getPiSupplementModel("mystery", "claude-opus-5-5")).toBeUndefined();
    expect(listPiSupplementModels("mystery")).toEqual([]);
  });

  it("lists the single supplemented row per provider and overall", () => {
    expect(listPiSupplementModels("anthropic").map((row) => row.id))
      .toEqual(["claude-opus-5-5"]);
    expect(listPiSupplementModels().map((row) => `${row.provider}:${row.id}`))
      .toEqual(["anthropic:claude-opus-5-5"]);
  });

  it("hands out fresh snapshots so callers cannot mutate shared state", () => {
    const first = getPiSupplementModel("anthropic", "claude-opus-5-5");
    first.cost.input = 999;
    first.input.push("video");
    expect(getPiSupplementModel("anthropic", "claude-opus-5-5")).toEqual(EXPECTED_ROW);

    const listed = listPiSupplementModels("anthropic");
    listed[0].compat.supportsTemperature = true;
    expect(getPiSupplementModel("anthropic", "claude-opus-5-5")).toEqual(EXPECTED_ROW);
  });
});

describe("registerPiSupplementModels", () => {
  it("registers the supplement into a real builtin Models collection for dispatch", () => {
    const models = builtinModels();
    const upstreamCount = models.getModels("anthropic").length;

    expect(registerPiSupplementModels(models)).toEqual(["anthropic:claude-opus-5-5"]);
    expect(models.getModel("anthropic", "claude-opus-5-5")).toMatchObject({
      id: "claude-opus-5-5",
      provider: "anthropic",
      api: "anthropic-messages",
    });
    // Upstream rows are untouched: same count plus exactly one.
    expect(models.getModels("anthropic")).toHaveLength(upstreamCount + 1);
    expect(models.getModel("anthropic", "claude-opus-5")).toMatchObject({
      id: "claude-opus-5",
    });
    expect(models.getModel("anthropic", "claude-opus-9")).toBeUndefined();
  });

  it("is idempotent and prefers collection state over re-registering", () => {
    const models = builtinModels();
    expect(registerPiSupplementModels(models)).toEqual(["anthropic:claude-opus-5-5"]);
    // Second call sees the id already resolving and registers nothing.
    expect(registerPiSupplementModels(models)).toEqual([]);
    const ids = models.getModels("anthropic").map((model) => model.id);
    expect(ids.filter((id) => id === "claude-opus-5-5")).toHaveLength(1);
  });

  it("leaves collections without the provider untouched", () => {
    const models = createModels();
    expect(registerPiSupplementModels(models)).toEqual([]);
    expect(models.getModel("anthropic", "claude-opus-5-5")).toBeUndefined();
  });
});

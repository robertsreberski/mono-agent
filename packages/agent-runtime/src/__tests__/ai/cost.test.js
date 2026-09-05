// Pricing precedence for ai/cost.js:
//   custom (resolveCustomPricing) -> pi catalog (getBuiltinModel) -> unknown.
//
// getBuiltinModel is mocked with a vi.fn that DEFAULTS to pi-ai's real catalog
// (so the pi-catalog level is exercised against real data) but can be forced to
// return undefined per-test to deterministically drive the unknown level.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/providers/all", () => ({ getBuiltinModel: vi.fn() }));

// The REAL catalog fn (importActual bypasses the mock above). Used as the mock's
// default so the pi-catalog level runs against real data; individual tests force
// undefined to drive the unknown level.
const { getBuiltinModel: realGetBuiltinModel } = await vi.importActual("@earendil-works/pi-ai/providers/all");
const { getBuiltinModel } = await import("@earendil-works/pi-ai/providers/all");
const { resolvePricing, estimateCost } = await import("../../ai/cost.js");

beforeEach(() => {
  getBuiltinModel.mockReset();
  getBuiltinModel.mockImplementation(realGetBuiltinModel);
});

describe("resolvePricing precedence", () => {
  it("1) custom pricing (resolveCustomPricing) wins over everything", () => {
    const custom = { input: 42, cacheRead: 1, cacheWrite: 2, output: 84, source: "custom", priced: true };
    const resolveCustomPricing = vi.fn(() => custom);
    const pricing = resolvePricing({
      model: "anthropic:claude-sonnet-4-5",
      resolveCustomPricing,
    });
    expect(pricing).toEqual(custom);
    expect(resolveCustomPricing).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-sonnet-4-5" });
    // Custom short-circuits before the catalog is ever consulted.
    expect(getBuiltinModel).not.toHaveBeenCalled();
  });

  it("2) pi catalog prices a model via its canonical provider (source pi-catalog)", () => {
    const pricing = resolvePricing({ model: "anthropic:claude-sonnet-4-5" });
    expect(getBuiltinModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
    expect(pricing.source).toBe("pi-catalog");
    expect(pricing.priced).toBe(true);
    expect(pricing.input).toBe(3);
    expect(pricing.output).toBe(15);
  });

  it("2b) pi catalog prices OpenAI and OpenAI Codex providers directly", () => {
    const openai = resolvePricing({ model: "openai:gpt-4o" });
    expect(openai.source).toBe("pi-catalog");
    expect(openai.priced).toBe(true);
    // A codex model id pi's catalog does not carry falls through to unknown.
    const codex = resolvePricing({ model: "openai-codex:gpt-5-codex" });
    expect(getBuiltinModel).toHaveBeenCalledWith("openai-codex", "gpt-5-codex");
    expect(codex.source).toBe("unknown");
    expect(codex.priced).toBe(false);
  });

  it.each(["openai", "openai-codex"])("prices GPT-6 Astra for %s from Pi's real catalog", (provider) => {
    const pricing = resolvePricing({ model: `${provider}:gpt-6-astra` });
    expect(pricing).toMatchObject({
      source: "pi-catalog",
      priced: true,
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    });
  });

  it("preserves colons inside model ids when consulting the catalog", () => {
    getBuiltinModel.mockReturnValue(undefined);
    const pricing = resolvePricing({ model: "amazon-bedrock:anthropic.claude-opus-4-5-20251101-v1:0" });
    expect(getBuiltinModel).toHaveBeenCalledWith("amazon-bedrock", "anthropic.claude-opus-4-5-20251101-v1:0");
    expect(pricing.source).toBe("unknown");
  });

  it("3) returns unknown when no source can price the model", () => {
    getBuiltinModel.mockReturnValue(undefined);
    const claudeUnknown = resolvePricing({ model: "anthropic:claude-does-not-exist-9" });
    expect(claudeUnknown.source).toBe("unknown");
    expect(claudeUnknown.priced).toBe(false);
    const bareUnknown = resolvePricing({ model: "mystery:model-x" });
    expect(bareUnknown.source).toBe("unknown");
    expect(bareUnknown.priced).toBe(false);
  });

  it("returns unknown for an unparseable reference", () => {
    expect(resolvePricing({ model: "" }).source).toBe("unknown");
    expect(resolvePricing({}).source).toBe("unknown");
  });
});

describe("estimateCost", () => {
  it("returns null for an unpriced (unknown) model", () => {
    getBuiltinModel.mockReturnValue(undefined);
    expect(estimateCost({ model: "mystery:model-x", inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it("computes cost from the resolved per-million rates", () => {
    // claude-sonnet-4-5 via pi catalog: input 3/M, output 15/M.
    const cost = estimateCost({ model: "anthropic:claude-sonnet-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it("delegates Pi request-wide tier selection at the catalog threshold", () => {
    const atThreshold = estimateCost({
      model: "openai-codex:gpt-5.6-sol",
      inputTokens: 272_000,
      outputTokens: 1_000_000,
    });
    const aboveThreshold = estimateCost({
      model: "openai-codex:gpt-5.6-sol",
      inputTokens: 272_001,
      outputTokens: 1_000_000,
    });

    expect(atThreshold).toBeCloseTo(1.36 + 30, 6);
    expect(aboveThreshold).toBeCloseTo(2.72001 + 45, 6);
  });

  it.each(["openai", "openai-codex"])("delegates GPT-6 Astra tier selection for %s", (provider) => {
    const model = `${provider}:gpt-6-astra`;
    expect(estimateCost({ model, inputTokens: 272_000, outputTokens: 1_000_000 }))
      .toBeCloseTo(2.72 + 50, 6);
    expect(estimateCost({ model, inputTokens: 272_001, outputTokens: 1_000_000 }))
      .toBeCloseTo(5.44002 + 75, 6);
  });

  it("uses Pi's cache-write rate in the native catalog estimate", () => {
    expect(estimateCost({
      model: "openai-codex:gpt-5.6-terra",
      cacheWriteTokens: 100_000,
    })).toBeCloseTo(0.25, 6);
  });
});

// resolvePiRuntimeModel's builtin-catalog-miss guard.
//
// getPiModel (Pi's getBuiltinModel) returns `undefined` on an unknown
// provider/model instead of throwing, so a raw `!!model.reasoning` read used
// to throw an unguarded TypeError ("Cannot read properties of undefined") —
// a message that doesn't match any classifyFailure/retryableProviderFailureInfo
// pattern, so it fell through to a misleading provider_unavailable classification
// instead of failing cleanly as a non-retryable, unambiguous "model not found".
import { describe, expect, it } from "vitest";
import { reasoningLevelsForPiModel, resolvePiRuntimeModel } from "../../ai/providers/pi-models.js";
import { retryableProviderFailureInfo } from "../../ai/failure.js";
import { thinkingLevelForEffort } from "../../ai/providers/pi-native/turn-runner.js";

describe("resolvePiRuntimeModel — unknown builtin model guard", () => {
  it("throws a clean 'pi model not found' error instead of a raw TypeError on a catalog miss", () => {
    expect(() => resolvePiRuntimeModel({ provider: "ollama", model: "nope", reference: "ollama:nope" }, {}))
      .toThrow("pi model not found: ollama:nope");
  });

  it("rejects a malformed reference before reaching the catalog lookup", () => {
    expect(() => resolvePiRuntimeModel({ provider: "", model: "claude-sonnet-4-6", reference: ":claude-sonnet-4-6" }, {}))
      .toThrow("invalid pi model reference: provider and model are required");
  });
});

describe("retryableProviderFailureInfo — 'pi model not found' classifies as non-retryable", () => {
  it("matches NON_RETRYABLE_PROVIDER_RE's model[_ ]not[_ ]found alternation", () => {
    expect(retryableProviderFailureInfo({
      errorText: "pi model not found: ollama:nope",
      failureKind: "provider_unavailable",
    })).toMatchObject({ retryable: false, subkind: "non_retryable" });
  });
});

describe("resolvePiRuntimeModel — OpenAI Codex GPT-5.6 metadata", () => {
  const expected = {
    "gpt-5.6-sol": {
      name: "GPT-5.6 Sol",
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tiers: [{
          inputTokensAbove: 272_000,
          input: 10,
          output: 45,
          cacheRead: 1,
          cacheWrite: 12.5,
        }],
      },
    },
    "gpt-5.6-terra": {
      name: "GPT-5.6 Terra",
      cost: {
        input: 2,
        output: 12,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [{
          inputTokensAbove: 272_000,
          input: 4,
          output: 18,
          cacheRead: 0.4,
          cacheWrite: 5,
        }],
      },
    },
  };

  for (const [model, metadata] of Object.entries(expected)) {
    it(`resolves ${model} context, pricing tiers, and native max`, () => {
      const resolved = resolvePiRuntimeModel({
        provider: "openai-codex",
        model,
        reference: `openai-codex:${model}`,
      }, {});

      expect(resolved.model).toMatchObject({
        id: model,
        name: metadata.name,
        api: "openai-codex-responses",
        provider: "openai-codex",
        reasoning: true,
        // Mirrors pi's generated catalog, which corrected this from 372_000 to
        // 272_000 in the 0.83.0 upgrade — matching the tier boundary below.
        contextWindow: 272_000,
        maxTokens: 128_000,
        cost: metadata.cost,
      });
      expect(resolved.capabilities).toMatchObject({
        reasoning: true,
        reasoning_mode: "effort",
        reasoning_levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        vision: true,
      });
      expect(thinkingLevelForEffort("max", resolved.capabilities)).toBe("max");
    });
  }

  it("retains the xhigh compatibility ceiling when older model metadata omits max", () => {
    expect(thinkingLevelForEffort("max", {
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: ["none", "low", "medium", "high", "xhigh"],
    })).toBe("xhigh");
  });

  it("preserves minimal for sparse upstream maps instead of letting Pi clamp low upward", () => {
    const capabilities = {
      reasoning: true,
      reasoning_mode: "effort",
      reasoning_levels: reasoningLevelsForPiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "MINIMAL",
          low: null,
          medium: null,
          high: "HIGH",
        },
      }),
    };

    expect(capabilities.reasoning_levels).toEqual(["minimal", "high"]);
    expect(thinkingLevelForEffort("minimal", capabilities)).toBe("minimal");
  });
});

describe("resolvePiRuntimeModel — GPT-6 Astra metadata", () => {
  const expected = {
    openai: {
      api: "openai-responses",
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    "openai-codex": {
      api: "openai-codex-responses",
      reasoningLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    },
  };

  for (const [provider, metadata] of Object.entries(expected)) {
    it(`resolves ${provider}:gpt-6-astra through the real Pi catalog`, () => {
      const resolved = resolvePiRuntimeModel({
        provider,
        model: "gpt-6-astra",
        reference: `${provider}:gpt-6-astra`,
      }, {});

      expect(resolved.model).toMatchObject({
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        api: metadata.api,
        provider,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 272_000,
        maxTokens: 128_000,
        cost: {
          input: 10,
          output: 50,
          cacheRead: 1,
          cacheWrite: 12.5,
          tiers: [{
            inputTokensAbove: 272_000,
            input: 20,
            output: 75,
            cacheRead: 2,
            cacheWrite: 25,
          }],
        },
      });
      expect(resolved.capabilities).toMatchObject({
        reasoning: true,
        reasoning_mode: "effort",
        reasoning_levels: metadata.reasoningLevels,
        vision: true,
      });
      expect(thinkingLevelForEffort("max", resolved.capabilities)).toBe("max");
    });
  }
});

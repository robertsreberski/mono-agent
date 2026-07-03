// resolvePiRuntimeModel's builtin-catalog-miss guard.
//
// getPiModel (Pi's getBuiltinModel) returns `undefined` on an unknown
// provider/model instead of throwing, so a raw `!!model.reasoning` read used
// to throw an unguarded TypeError ("Cannot read properties of undefined") —
// a message that doesn't match any classifyFailure/retryableProviderFailureInfo
// pattern, so it fell through to a misleading provider_unavailable classification
// instead of failing cleanly as a non-retryable, unambiguous "model not found".
import { describe, expect, it } from "vitest";
import { resolvePiRuntimeModel } from "../../ai/providers/pi-models.js";
import { retryableProviderFailureInfo } from "../../ai/failure.js";

describe("resolvePiRuntimeModel — unknown builtin model guard", () => {
  it("throws a clean 'pi model not found' error instead of a raw TypeError on a catalog miss", () => {
    expect(() => resolvePiRuntimeModel({ sdk: "pi", provider: "ollama", model: "nope" }, {}))
      .toThrow("pi model not found: ollama:nope");
  });

  it("rejects a non-pi sdk before reaching the catalog lookup", () => {
    expect(() => resolvePiRuntimeModel({ sdk: "claude", provider: "anthropic", model: "claude-sonnet-4-6" }, {}))
      .toThrow("unsupported pi sdk: claude");
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

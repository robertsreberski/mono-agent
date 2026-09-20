import { describe, expect, it } from "vitest";

import { textFromMemoryRuntimeResult } from "../memory-llm-result.js";

describe("agent-host memory runtime results", () => {
  it("serializes a successful structured result instead of accepting free-form text", () => {
    expect(textFromMemoryRuntimeResult({
      text: "not accepted on the selected structured path",
      structuredResult: { memories: [], entities: [], relations: [] },
    }, { structuredOutputRequested: true })).toBe('{"memories":[],"entities":[],"relations":[]}');
  });

  it("serializes the selected structured property for an established non-object text contract", () => {
    expect(textFromMemoryRuntimeResult({
      structuredResult: { decisions: [{ index: 0, action: "add" }] },
    }, { structuredOutputRequested: true, structuredResultKey: "decisions" }))
      .toBe('[{"index":0,"action":"add"}]');
  });

  it("rejects a structured result missing the selected property", () => {
    expect(() => textFromMemoryRuntimeResult({ structuredResult: { other: [] } }, {
      structuredOutputRequested: true,
      structuredResultKey: "decisions",
    })).toThrow(/missing decisions/u);
  });

  it("fails a selected structured request with no structured result", () => {
    expect(() => textFromMemoryRuntimeResult({ text: "plausible fallback JSON" }, {
      structuredOutputRequested: true,
    })).toThrow(/without the required structured result/u);
  });

  it("preserves the text path when no schema was selected", () => {
    expect(textFromMemoryRuntimeResult({ text: "legacy validated text" })).toBe("legacy validated text");
  });

  it.each([
    [
      "cancellation",
      { cancelled: true, structuredResult: { accepted: true } },
      /run was cancelled/u,
    ],
    [
      "provider failure",
      { failureKind: "provider_error", error: "offline", structuredResult: { accepted: true } },
      /failed \(provider_error\): offline/u,
    ],
    [
      "runtime error",
      { error: "broken", structuredResult: { accepted: true } },
      /failed: broken/u,
    ],
  ] as const)("reports %s before consuming a structured payload", (_label, result, expected) => {
    expect(() => textFromMemoryRuntimeResult(result, {
      structuredOutputRequested: true,
    })).toThrow(expected);
  });
});

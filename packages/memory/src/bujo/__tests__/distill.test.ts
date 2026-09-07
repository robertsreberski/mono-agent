import { describe, expect, it } from "vitest";
import {
  MAX_RECONCILIATION_TEXT_CODE_POINTS,
  normalizeReconciliationText,
} from "../distill.js";

describe("legacy reconciliation normalization", () => {
  it("uses the separate 280-code-point reconciliation cap", () => {
    expect(MAX_RECONCILIATION_TEXT_CODE_POINTS).toBe(280);
    const exactBoundary = `${"a".repeat(279)}🧠`;
    const overBoundary = `${exactBoundary}tail`;

    expect(normalizeReconciliationText(exactBoundary)).toBe(exactBoundary);
    expect(normalizeReconciliationText(overBoundary)).toBe(exactBoundary);
    expect(Array.from(normalizeReconciliationText(overBoundary) ?? "")).toHaveLength(280);
  });

  it("removes escaped lone surrogates while preserving valid astral pairs", () => {
    const loneHigh = JSON.parse('"\\ud83d"') as string;
    const loneLow = JSON.parse('"\\udc00"') as string;
    const embedded = JSON.parse('"A\\ud83dB\\udc00C"') as string;
    const validPair = JSON.parse('"\\ud83e\\udde0"') as string;

    expect(normalizeReconciliationText(loneHigh)).toBeUndefined();
    expect(normalizeReconciliationText(loneLow)).toBeUndefined();
    expect(normalizeReconciliationText(embedded)).toBe("ABC");
    expect(normalizeReconciliationText(validPair)).toBe("🧠");
    expect(normalizeReconciliationText(embedded)).not.toContain("�");
    expect(normalizeReconciliationText(embedded)).not.toMatch(/\p{Cs}/u);
  });
});

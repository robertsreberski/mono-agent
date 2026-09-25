import { describe, expect, it } from "vitest";
import {
  MAX_RECONCILIATION_TEXT_CODE_POINTS,
  normalizeReconciliationText,
} from "../distill.js";

describe("legacy reconciliation normalization", () => {
  it("shares the 160-code-point capture cap and preserves word boundaries", () => {
    expect(MAX_RECONCILIATION_TEXT_CODE_POINTS).toBe(160);
    const exactBoundary = `${"a".repeat(159)}🧠`;
    expect(normalizeReconciliationText(exactBoundary)).toBe(exactBoundary);
    expect(normalizeReconciliationText(`${"word ".repeat(32)}tail`)).toBe(`${"word ".repeat(31)}word`);
    expect(Array.from(normalizeReconciliationText(`${"a".repeat(160)} tail`) ?? "")).toHaveLength(160);
  });

  it("uses real sentence endings rather than abbreviations when clamping", () => {
    const first = "Dr. Morgan works at St. Anne's clinic, e.g. on weekdays, i.e. most mornings.";
    expect(normalizeReconciliationText(`${first} ${"another lengthy unpunctuated continuation ".repeat(10)}`)).toBe(first);
    expect(normalizeReconciliationText(`The measurement is 7.5 units. ${"another lengthy unpunctuated continuation ".repeat(10)}`))
      .toBe("The measurement is 7.5 units.");
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

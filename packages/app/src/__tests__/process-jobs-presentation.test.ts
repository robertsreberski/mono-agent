import { expect, expectTypeOf, it } from "vitest";

import type { DurableProcessJobRecord } from "../process-jobs-store.js";
import { boundedNewestRecords } from "../process-jobs/policy.js";
import { boundOutput, boundedSafeDiagnostic, outputPreview } from "../process-jobs/presentation.js";

it("preserves UTF-8 output limits and the exact truncation marker", () => {
  const bounded = boundOutput("🙂".repeat(30), 32);
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(32);
  expect(bounded.text.endsWith("\n[output truncated]\n")).toBe(true);
  expect(bounded.text).not.toContain("�");
  expect(boundOutput("🙂", 1)).toEqual({ text: "", truncated: true });
});

it("keeps empty previews and fixed safe diagnostics bounded", () => {
  expect(outputPreview("", "", 100)).toBe("(no output)");
  expect(outputPreview("", "", 3)).toBe("(no");
  expect(boundedSafeDiagnostic("unknown wake-settlement failure")).toBe("unknown wake-settlement failure");
});

it("accepts readonly snapshots without granting mutation to policy consumers", () => {
  expectTypeOf<Parameters<typeof boundedNewestRecords>[0]>().toEqualTypeOf<readonly DurableProcessJobRecord[]>();
  const records: Parameters<typeof boundedNewestRecords>[0] = [];
  if (false) {
    // @ts-expect-error policy inputs are readonly arrays
    records.push({});
  }
});

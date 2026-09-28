import { describe, expect, it } from "vitest";
import { runningManualCompaction } from "./manual-compaction";
import { thread } from "./test/fixtures";

describe("manual compaction thread hint", () => {
  it("accepts only a valid in-memory manual-running projection", () => {
    const base = thread("garden", "alpha");
    expect(runningManualCompaction(base)).toBe(false);
    const value = { status: "running", trigger: "manual", startedAt: "2026-09-28T10:00:00Z" } as const;
    expect(runningManualCompaction({ ...base, compaction: value })).toBe(true);
    for (const compaction of [{ ...value, startedAt: "not a date" }, { ...value, trigger: "automatic" }, { ...value, status: "failed" }]) {
      expect(runningManualCompaction({ ...base, compaction } as typeof base)).toBe(false);
    }
  });
});

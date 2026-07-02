import { describe, expect, it } from "vitest";

import { formatDurationMs } from "../ui/format.js";

describe("formatDurationMs", () => {
  it("never renders an impossible 60s remainder near minute boundaries", () => {
    expect(formatDurationMs(119_800)).toBe("1m 59s"); // round() would say "1m 60s"
    expect(formatDurationMs(119_999)).toBe("1m 59s");
    expect(formatDurationMs(120_000)).toBe("2m");
  });

  it("formats the sub-minute ranges", () => {
    expect(formatDurationMs(42)).toBe("42ms");
    expect(formatDurationMs(1_500)).toBe("1.5s");
    expect(formatDurationMs(60_000)).toBe("1m");
  });
});

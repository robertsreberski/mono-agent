import { describe, expect, it } from "vitest";
import { formatElapsed } from "./duration";

describe("formatElapsed", () => {
  it("renders whole seconds, then minutes, then hours", () => {
    expect(formatElapsed(0)).toBe("<1s");
    expect(formatElapsed(999)).toBe("<1s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });

  it("never renders a negative window", () => {
    expect(formatElapsed(-5_000)).toBe("<1s");
  });
});

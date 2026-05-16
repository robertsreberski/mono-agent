import { describe, expect, it } from "vitest";

import { CORE_AGENT_FIELD_GROUPS } from "./field-groups.js";

describe("CORE_AGENT_FIELD_GROUPS", () => {
  it("contains only adapter-neutral Mono Agent settings sections", () => {
    expect(CORE_AGENT_FIELD_GROUPS.map((group) => group.id)).toEqual([
      "identity",
      "runtime",
      "memory",
      "tools",
      "artifacts",
    ]);
    expect(CORE_AGENT_FIELD_GROUPS.some((group) => group.id === "telegram")).toBe(false);
  });
});

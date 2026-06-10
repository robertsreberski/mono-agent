import { describe, expect, it } from "vitest";

import { CORE_AGENT_FIELD_GROUPS, runtimeFieldGroup } from "../field-groups.js";

describe("CORE_AGENT_FIELD_GROUPS", () => {
  it("contains only adapter-neutral core agent settings sections", () => {
    expect(CORE_AGENT_FIELD_GROUPS.map((group) => group.id)).toEqual([
      "identity",
      "runtime",
      "memory",
      "tools",
      "artifacts",
      "traceability",
    ]);
    expect(CORE_AGENT_FIELD_GROUPS.some((group) => group.id === "telegram")).toBe(false);
  });

  it("exposes runtime session fields with nested paths", () => {
    const mode = runtimeFieldGroup.fields.find((field) => field.id === "runtime.session.mode");
    const idleTimeout = runtimeFieldGroup.fields.find((field) => field.id === "runtime.session.idleTimeoutMs");

    expect(mode).toMatchObject({
      kind: "select",
      options: [
        { value: "continuous", label: "continuous" },
        { value: "per-message", label: "per-message" },
      ],
      path: ["runtime", "session", "mode"],
    });
    expect(idleTimeout).toMatchObject({
      kind: "integer",
      placeholder: "1800000",
      path: ["runtime", "session", "idleTimeoutMs"],
    });
  });
});

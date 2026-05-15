import { describe, expect, it } from "vitest";

import type { FieldGroup } from "../schema/types.js";
import { validatePatch } from "./patch-validator.js";

const groups: readonly FieldGroup[] = [
  {
    id: "runtime",
    label: "Runtime",
    fields: [
      {
        id: "runtime.model",
        label: "Model",
        kind: "string",
        path: ["runtime", "model"],
      },
      {
        id: "runtime.executionMode",
        label: "Mode",
        kind: "select",
        options: [
          { value: "sdk", label: "SDK" },
          { value: "cli", label: "CLI" },
        ],
        path: ["runtime", "executionMode"],
      },
      {
        id: "runtime.maxTurns",
        label: "Turns",
        kind: "integer",
        min: 1,
        max: 100,
        path: ["runtime", "maxTurns"],
      },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    fields: [
      {
        id: "telegram.botToken",
        label: "Token",
        kind: "secret",
        path: ["telegram", "botToken"],
      },
      {
        id: "telegram.allowedChatIds",
        label: "Chat ids",
        kind: "csv",
        path: ["telegram", "allowedChatIds"],
      },
    ],
  },
];

describe("validatePatch", () => {
  it("rejects unregistered top-level keys", () => {
    const result = validatePatch({ notRegistered: { arbitrary: "persisted" } }, groups);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unregistered).toEqual(["notRegistered.arbitrary"]);
      expect(result.invalid).toEqual([]);
    }
  });

  it("rejects unregistered nested keys inside a registered group", () => {
    const result = validatePatch({ runtime: { sneaky: "value" } }, groups);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unregistered).toEqual(["runtime.sneaky"]);
    }
  });

  it("rejects values whose select option is not in the registered list", () => {
    const result = validatePatch({ runtime: { executionMode: "wat" } }, groups);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalid).toHaveLength(1);
      expect(result.invalid[0]?.path).toBe("runtime.executionMode");
    }
  });

  it("rejects integers outside the declared range", () => {
    const lo = validatePatch({ runtime: { maxTurns: 0 } }, groups);
    const hi = validatePatch({ runtime: { maxTurns: 101 } }, groups);
    expect(lo.ok).toBe(false);
    expect(hi.ok).toBe(false);
  });

  it("coerces string integers to numbers", () => {
    const result = validatePatch({ runtime: { maxTurns: "12" } }, groups);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({ runtime: { maxTurns: 12 } });
    }
  });

  it("coerces csv strings to arrays and arrays back through trim/filter", () => {
    const fromString = validatePatch(
      { telegram: { allowedChatIds: "111, 222 ,, 333 " } },
      groups,
    );
    const fromArray = validatePatch(
      { telegram: { allowedChatIds: ["111", "  222  ", ""] } },
      groups,
    );
    expect(fromString.ok).toBe(true);
    expect(fromArray.ok).toBe(true);
    if (fromString.ok && fromArray.ok) {
      expect(fromString.patch).toEqual({
        telegram: { allowedChatIds: ["111", "222", "333"] },
      });
      expect(fromArray.patch).toEqual({
        telegram: { allowedChatIds: ["111", "222"] },
      });
    }
  });

  it("treats null / empty string / empty array as a delete", () => {
    const result = validatePatch(
      {
        runtime: { model: "" },
        telegram: { allowedChatIds: [] },
      },
      groups,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Empty inputs are stripped — patch is empty so writeMonoAgentConfigJson
      // collapses keys via its own delete-on-undefined logic.
      expect(result.patch).toEqual({});
    }
  });

  it("preserves multiple registered leaves in one patch", () => {
    const result = validatePatch(
      {
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
        telegram: { botToken: "abc:123" },
      },
      groups,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
        telegram: { botToken: "abc:123" },
      });
    }
  });

  it("aggregates multiple errors in one response", () => {
    const result = validatePatch(
      {
        runtime: { executionMode: "wat", maxTurns: 9999 },
        unregisteredGroup: { x: 1 },
      },
      groups,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unregistered).toContain("unregisteredGroup.x");
      expect(result.invalid.map((entry) => entry.path).sort()).toEqual([
        "runtime.executionMode",
        "runtime.maxTurns",
      ]);
    }
  });

  it("ignores empty patch and returns ok with empty object", () => {
    const result = validatePatch({}, groups);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({});
    }
  });

  it("rejects non-object root payloads", () => {
    const fromArray = validatePatch([{ runtime: { model: "x" } }], groups);
    // Arrays at the root collapse to nothing meaningful — every numeric index
    // is unregistered. We just need ok=false.
    expect(fromArray.ok).toBe(false);
  });
});

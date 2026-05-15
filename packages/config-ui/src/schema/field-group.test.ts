import { describe, expect, it } from "vitest";

import {
  CORE_FIELD_GROUPS,
  defineFieldGroup,
  readFieldValue,
  writeFieldValue,
} from "./field-group.js";

describe("CORE_FIELD_GROUPS", () => {
  it("ships identity, runtime, memory, tools, telegram in that order", () => {
    expect(CORE_FIELD_GROUPS.map((g) => g.id)).toEqual([
      "identity",
      "runtime",
      "memory",
      "tools",
      "telegram",
    ]);
  });

  it("declares the telegram bot token as a secret field", () => {
    const telegram = CORE_FIELD_GROUPS.find((g) => g.id === "telegram");
    expect(telegram).toBeDefined();
    const botToken = telegram?.fields.find((f) => f.id === "telegram.botToken");
    expect(botToken?.kind).toBe("secret");
  });

  it("flags the identity path as required", () => {
    const identity = CORE_FIELD_GROUPS.find((g) => g.id === "identity");
    const identityPath = identity?.fields.find((f) => f.id === "context.identityPath");
    expect(identityPath?.required).toBe(true);
  });
});

describe("defineFieldGroup", () => {
  it("returns the group unchanged (identity helper)", () => {
    const group = defineFieldGroup({
      id: "custom",
      label: "Custom",
      fields: [
        { id: "custom.flag", label: "Flag", kind: "switch", path: ["custom", "flag"] },
      ],
    });
    expect(group.id).toBe("custom");
    expect(group.fields).toHaveLength(1);
  });
});

describe("readFieldValue / writeFieldValue", () => {
  const runtimeGroup = CORE_FIELD_GROUPS.find((g) => g.id === "runtime");
  const modelField = runtimeGroup?.fields.find((f) => f.id === "runtime.model");
  const maxTurnsField = runtimeGroup?.fields.find((f) => f.id === "runtime.maxTurns");
  const identityGroup = CORE_FIELD_GROUPS.find((g) => g.id === "identity");
  const selectedSkillsField = identityGroup?.fields.find(
    (f) => f.id === "context.selectedSkills",
  );

  it("reads string fields", () => {
    expect(
      readFieldValue({ runtime: { model: "pi:openai-codex:gpt-5.5" } }, modelField!),
    ).toBe("pi:openai-codex:gpt-5.5");
  });

  it("reads integer fields", () => {
    expect(readFieldValue({ runtime: { maxTurns: 12 } }, maxTurnsField!)).toBe(12);
  });

  it("reads csv fields as comma-joined strings", () => {
    expect(
      readFieldValue({ context: { selectedSkills: ["a", "b"] } }, selectedSkillsField!),
    ).toBe("a, b");
  });

  it("returns undefined when the path is empty", () => {
    expect(readFieldValue({}, modelField!)).toBeUndefined();
  });

  it("writes string fields and creates intermediate objects", () => {
    const next = writeFieldValue({}, modelField!, "codex:gpt-5.5");
    expect(next.runtime?.model).toBe("codex:gpt-5.5");
  });

  it("writes integer fields and rejects non-integer input", () => {
    const next = writeFieldValue({}, maxTurnsField!, "20");
    expect(next.runtime?.maxTurns).toBe(20);
    expect(() => writeFieldValue({}, maxTurnsField!, "abc")).toThrow(/integer/u);
  });

  it("writes csv fields by splitting on commas and trimming", () => {
    const next = writeFieldValue({}, selectedSkillsField!, "a, b , c");
    expect(next.context?.selectedSkills).toEqual(["a", "b", "c"]);
  });

  it("clears the field when the input is empty", () => {
    const next = writeFieldValue(
      { runtime: { maxTurns: 8 } },
      maxTurnsField!,
      "",
    );
    expect(next.runtime?.maxTurns).toBeUndefined();
  });
});

describe("round-trip", () => {
  it("serializing then deserializing each field preserves values", () => {
    const sample = {
      runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
      context: { identityPath: "IDENTITY.md", selectedSkills: ["a", "b"] },
      tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
      memory: { path: "MEMORY.md", maxBytes: 1024, scope: "single-file" as const, writeMode: "disabled" as const },
      telegram: { allowedChatIds: ["111", "222"] },
    };

    let rebuilt: ReturnType<typeof writeFieldValue> = {};
    for (const group of CORE_FIELD_GROUPS) {
      for (const field of group.fields) {
        const current = readFieldValue(sample, field);
        if (current === undefined) {
          continue;
        }
        rebuilt = writeFieldValue(rebuilt, field, String(current));
      }
    }

    expect(rebuilt.runtime?.model).toBe(sample.runtime.model);
    expect(rebuilt.runtime?.maxTurns).toBe(sample.runtime.maxTurns);
    expect(rebuilt.context?.identityPath).toBe(sample.context.identityPath);
    expect(rebuilt.context?.selectedSkills).toEqual(sample.context.selectedSkills);
    expect(rebuilt.tools?.allowedTools).toEqual(sample.tools.allowedTools);
    expect(rebuilt.memory?.maxBytes).toBe(sample.memory.maxBytes);
    expect(rebuilt.telegram?.allowedChatIds).toEqual(sample.telegram.allowedChatIds);
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defineFieldGroup,
  readFieldValue,
  readSettingsJson,
  redactSettingsForFieldGroups,
  validateSettingsPatch,
  writeFieldValue,
  writeSettingsJson,
} from "../index.js";
import type { FieldGroup, SettingsJson } from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const groups: readonly FieldGroup[] = [
  defineFieldGroup({
    id: "runtime",
    label: "Runtime",
    fields: [
      { id: "runtime.model", label: "Model", kind: "string", path: ["runtime", "model"] },
      { id: "runtime.maxTurns", label: "Max turns", kind: "integer", min: 1, max: 100, path: ["runtime", "maxTurns"] },
      { id: "runtime.enabled", label: "Enabled", kind: "switch", path: ["runtime", "enabled"] },
    ],
  }),
  defineFieldGroup({
    id: "telegram",
    label: "Telegram",
    fields: [
      { id: "telegram.botToken", label: "Bot token", kind: "secret", path: ["telegram", "botToken"] },
      { id: "telegram.allowedChatIds", label: "Allowed chats", kind: "csv", path: ["telegram", "allowedChatIds"] },
    ],
  }),
];

describe("field groups", () => {
  it("reads and writes field values without knowing package-specific config shapes", () => {
    const modelField = groups[0]?.fields[0];
    const turnsField = groups[0]?.fields[1];
    const enabledField = groups[0]?.fields[2];
    const chatsField = groups[1]?.fields[1];
    if (!modelField || !turnsField || !enabledField || !chatsField) {
      throw new Error("missing fixture field");
    }

    let patch: SettingsJson = {};
    patch = writeFieldValue(patch, modelField, " pi:openai-codex:gpt-5.5 ");
    patch = writeFieldValue(patch, turnsField, "12");
    patch = writeFieldValue(patch, enabledField, "true");
    patch = writeFieldValue(patch, chatsField, "111, 222");

    expect(patch).toEqual({
      runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12, enabled: true },
      telegram: { allowedChatIds: ["111", "222"] },
    });
    expect(readFieldValue(patch, turnsField)).toBe(12);
    expect(readFieldValue(patch, enabledField)).toBe(true);
    expect(readFieldValue(patch, chatsField)).toBe("111, 222");
  });
});

describe("validateSettingsPatch", () => {
  it("rejects unregistered leaves and invalid values before persistence", () => {
    const result = validateSettingsPatch(
      {
        runtime: { maxTurns: 0, model: "pi:openai-codex:gpt-5.5" },
        unknown: { value: "nope" },
      },
      groups,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unregistered).toEqual(["unknown.value"]);
      expect(result.invalid).toEqual([{ path: "runtime.maxTurns", reason: "runtime.maxTurns must be >= 1." }]);
    }
  });

  it("returns a clean sparse patch containing only registered field paths", () => {
    const result = validateSettingsPatch(
      {
        runtime: { maxTurns: "14", enabled: "false" },
        telegram: { allowedChatIds: "111, 222" },
      },
      groups,
    );

    expect(result).toEqual({
      ok: true,
      patch: {
        runtime: { maxTurns: 14, enabled: false },
        telegram: { allowedChatIds: ["111", "222"] },
      },
    });
  });
});

describe("redactSettingsForFieldGroups", () => {
  it("replaces registered secret fields without leaking stored values", () => {
    const redacted = redactSettingsForFieldGroups(
      { telegram: { botToken: "123456:secret-token", allowedChatIds: ["111"] } },
      groups,
    );

    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(redacted).toEqual({
      telegram: {
        botToken: { __secret: true, set: true },
        allowedChatIds: ["111"],
      },
    });
  });
});

describe("settings JSON store", () => {
  it("preserves unknown top-level sections and merges object sections generically", async () => {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      `${JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 8 },
        telegram: { botToken: "abc" },
        a2a: { agent: { name: "Before", description: "Keep me", version: "0.1.0" } },
        futureAdapter: { enabled: true, mode: "alpha" },
      })}\n`,
      "utf8",
    );

    await writeSettingsJson({
      path,
      patch: {
        runtime: { maxTurns: 12 },
        a2a: { agent: { name: "After" } },
        futureAdapter: { mode: "beta" },
      },
    });

    const { json } = await readSettingsJson(path);
    expect(json).toEqual({
      runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
      telegram: { botToken: "abc" },
      a2a: { agent: { name: "After", description: "Keep me", version: "0.1.0" } },
      futureAdapter: { enabled: true, mode: "beta" },
    });
    expect(await readFile(path, "utf8")).toContain("\"futureAdapter\"");
  });
});

import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defineFieldGroup,
  isSecretMarker,
  readFieldValue,
  readRawFieldValue,
  readSettingsJson,
  redactSettingsForFieldGroups,
  SettingsJsonError,
  validateSettingsPatch,
  writeFieldValue,
  writeSettingsJson,
} from "../index.js";
import type { FieldDefinition, FieldGroup, SettingsJson } from "../index.js";

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
      { telegram: { botToken: "123456:test-token", allowedChatIds: ["111"] } },
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

describe("readSettingsJson error paths", () => {
  it("returns a missing result instead of throwing when the file is absent", async () => {
    const result = await readSettingsJson(join(dir, "absent.json"));
    expect(result).toEqual({ json: {}, version: "", path: join(dir, "absent.json"), missing: true });
  });

  it("treats an empty/whitespace file as an empty object", async () => {
    const path = join(dir, "empty.json");
    await writeFile(path, "   \n", "utf8");
    const result = await readSettingsJson(path);
    expect(result.json).toEqual({});
    expect(result.missing).toBe(false);
  });

  it("throws invalid_json_source when the file is not valid JSON", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readSettingsJson(path)).rejects.toMatchObject({
      name: "SettingsJsonError",
      code: "invalid_json_source",
      details: { code: "invalid_json_source", path },
    });
  });

  it("throws invalid_json_source when the JSON is not an object", async () => {
    const path = join(dir, "array.json");
    await writeFile(path, "[1, 2, 3]", "utf8");
    await expect(readSettingsJson(path)).rejects.toMatchObject({
      code: "invalid_json_source",
      message: `${path} must contain a JSON object.`,
    });
  });

  it("exposes the error code via the SettingsJsonError class", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "nope", "utf8");
    const error = await readSettingsJson(path).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SettingsJsonError);
    expect((error as SettingsJsonError).details.code).toBe("invalid_json_source");
  });
});

describe("writeSettingsJson atomic write", () => {
  it("creates the file with 0600 permissions and leaves no tmp file behind", async () => {
    const path = join(dir, "nested", "settings.json");
    await writeSettingsJson({ path, patch: { runtime: { model: "m" } } });

    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const entries = await readdir(join(dir, "nested"));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual([basename(path)]);
  });

  it("returns a content version hash", async () => {
    const path = join(dir, "settings.json");
    const { version } = await writeSettingsJson({ path, patch: { runtime: { model: "m" } } });
    expect(version).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("cleans up the tmp file and surfaces invalid_json_source when the rename target is a directory", async () => {
    const path = join(dir, "as-dir");
    await writeFile(`${path}-keep`, "x", "utf8");
    // Make the destination path a non-empty directory so rename(tmp -> path) fails.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "child"), "x", "utf8");

    await expect(writeSettingsJson({ path, patch: { runtime: { model: "m" } } })).rejects.toMatchObject({
      code: "invalid_json_source",
    });

    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});

describe("field read/write edge cases", () => {
  const stringField: FieldDefinition = { id: "runtime.model", label: "Model", kind: "string", path: ["runtime", "model"] };
  const intField: FieldDefinition = { id: "runtime.maxTurns", label: "Max turns", kind: "integer", min: 1, max: 100, path: ["runtime", "maxTurns"] };
  const selectField: FieldDefinition = {
    id: "runtime.mode",
    label: "Mode",
    kind: "select",
    options: [
      { value: "fast", label: "Fast" },
      { value: "slow", label: "Slow" },
    ],
    path: ["runtime", "mode"],
  };

  it("clears a path when an empty string is written", () => {
    let patch: SettingsJson = { runtime: { model: "keep" } };
    patch = writeFieldValue(patch, stringField, "");
    expect(patch).toEqual({ runtime: {} });
  });

  it("throws when a non-integer string is written to an integer field", () => {
    expect(() => writeFieldValue({}, intField, "abc")).toThrow("runtime.maxTurns must be an integer.");
  });

  it("enforces min/max bounds on integer writes (aligned with validateSettingsPatch)", () => {
    expect(() => writeFieldValue({}, intField, "0")).toThrow("runtime.maxTurns must be >= 1.");
    expect(() => writeFieldValue({}, intField, "1000")).toThrow("runtime.maxTurns must be <= 100.");
  });

  it("accepts negative integers consistently in write and validate paths", () => {
    const signedField: FieldDefinition = { id: "runtime.offset", label: "Offset", kind: "integer", path: ["runtime", "offset"] };
    expect(writeFieldValue({}, signedField, "-5")).toEqual({ runtime: { offset: -5 } });
    const validated = validateSettingsPatch({ runtime: { offset: "-5" } }, [
      defineFieldGroup({ id: "runtime", label: "Runtime", fields: [signedField] }),
    ]);
    expect(validated).toEqual({ ok: true, patch: { runtime: { offset: -5 } } });
  });

  it("rejects a select value that is not in the declared options", () => {
    const result = validateSettingsPatch({ runtime: { mode: "turbo" } }, [
      defineFieldGroup({ id: "runtime", label: "Runtime", fields: [selectField] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalid).toEqual([
        { path: "runtime.mode", reason: "runtime.mode must be one of: fast, slow." },
      ]);
    }
  });

  it("reads raw stored values and secret markers without re-traversing paths", () => {
    const secretField: FieldDefinition = { id: "telegram.botToken", label: "Bot token", kind: "secret", path: ["telegram", "botToken"] };
    const redacted = redactSettingsForFieldGroups(
      { telegram: { botToken: "real-secret" } },
      [defineFieldGroup({ id: "telegram", label: "Telegram", fields: [secretField] })],
    );
    const raw = readRawFieldValue(redacted, secretField);
    expect(isSecretMarker(raw)).toBe(true);
    expect(isSecretMarker({ __secret: true })).toBe(false);
    expect(isSecretMarker("real-secret")).toBe(false);
    expect(readRawFieldValue({ runtime: { model: "m" } }, stringField)).toBe("m");
    expect(readRawFieldValue({}, stringField)).toBeUndefined();
  });
});

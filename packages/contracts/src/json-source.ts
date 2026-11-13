import { existsSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SettingsJson } from "./types.js";
import { readSettingsJson, SettingsJsonError } from "./json-read.js";
import { writeGuardedSettingsJson, withSettingsJsonLock, type GuardedSettingsJsonWrite } from "./guarded-json-source.js";
export { readSettingsJson, findDuplicateJsonKeyPaths, SettingsJsonError } from "./json-read.js";

export async function writeSettingsJson(input: {
  readonly path: string;
  readonly patch: SettingsJson;
  readonly guarded?: GuardedSettingsJsonWrite;
}): Promise<{ readonly version: string }> {
  const { path, patch } = input;
  if (input.guarded !== undefined) return await writeGuardedSettingsJson(path, (existing) => deepMergeObject(existing, patch) as SettingsJson, input.guarded);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return await withSettingsJsonLock(path, async () => {
    const merged = await mergePatch(path, patch);
    const serialized = `${JSON.stringify(merged, null, 2)}\n`;
    const tmp = `${path}.tmp`;
    try {
      await writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
      await chmod(path, 0o600).catch(() => undefined);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new SettingsJsonError("invalid_json_source", `Cannot write ${path}: ${reason}.`, { path, reason });
    }
    return { version: await sha256(serialized) };
  });
}

async function mergePatch(path: string, patch: SettingsJson): Promise<SettingsJson> {
  const existing = (await readSettingsJson(path)).json;
  return deepMergeObject(existing, patch) as SettingsJson;
}

/**
 * Recursively merge a sparse patch onto an existing object. Plain-object values
 * merge in place; `undefined` deletes a key; everything else replaces.
 */
function deepMergeObject(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }
    const previous = merged[key];
    if (isPlainObject(previous) && isPlainObject(value)) {
      merged[key] = deepMergeObject(previous, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

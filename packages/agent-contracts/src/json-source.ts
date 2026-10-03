import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SettingsJson } from "./types.js";

export type SettingsJsonErrorCode = "invalid_json_source";

export interface SettingsJsonErrorDetails {
  readonly code?: SettingsJsonErrorCode;
  readonly path?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class SettingsJsonError extends Error {
  readonly code: SettingsJsonErrorCode;
  readonly details: SettingsJsonErrorDetails;

  constructor(code: SettingsJsonErrorCode, message: string, details: SettingsJsonErrorDetails = {}) {
    super(message);
    this.name = "SettingsJsonError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface ReadSettingsJsonResult {
  readonly json: SettingsJson;
  /** sha-256 of the parsed content, or empty string when the file is missing. */
  readonly version: string;
  readonly path: string;
  readonly missing: boolean;
  /** Duplicate object-key paths in the original JSON text; parsing still uses last-wins semantics. */
  readonly duplicateKeyPaths: readonly string[];
}

/** Scan valid JSON text, preserving object boundaries and decoded (including escaped) key identity. */
export function findDuplicateJsonKeyPaths(text: string): readonly string[] {
  const paths = new Set<string>();
  let pos = 0;
  const whitespace = (): void => {
    while (pos < text.length && /\s/u.test(text[pos] ?? "")) pos++;
  };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos] === "\\") { pos += 2; continue; }
      if (text[pos++] === '"') break;
    }
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const childPath = (parent: string, key: string): string =>
    /^[A-Za-z_$][\w$]*$/u.test(key)
      ? (parent ? `${parent}.${key}` : key)
      : `${parent}[${JSON.stringify(key)}]`;
  const value = (path: string): void => {
    whitespace();
    if (text[pos] === "{") {
      pos++;
      const seen = new Set<string>();
      whitespace();
      while (text[pos] !== "}") {
        const key = string();
        const next = childPath(path, key);
        if (seen.has(key)) paths.add(next);
        seen.add(key);
        whitespace();
        pos++; // colon
        value(next);
        whitespace();
        if (text[pos] !== ",") break;
        pos++;
        whitespace();
      }
      pos++; // closing brace
    } else if (text[pos] === "[") {
      pos++;
      whitespace();
      let index = 0;
      while (text[pos] !== "]") {
        value(`${path}[${index++}]`);
        whitespace();
        if (text[pos] !== ",") break;
        pos++;
      }
      pos++; // closing bracket
    } else if (text[pos] === '"') {
      string();
    } else {
      while (pos < text.length && !/[\s,}\]]/u.test(text[pos] ?? "")) pos++;
    }
  };
  value("");
  return [...paths];
}

export async function readSettingsJson(path: string): Promise<ReadSettingsJsonResult> {
  if (!existsSync(path)) {
    return { json: {}, version: "", path, missing: true, duplicateKeyPaths: [] };
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SettingsJsonError("invalid_json_source", `Cannot read ${path}: ${reason}.`, { path, reason });
  }
  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SettingsJsonError("invalid_json_source", `Cannot parse ${path}: ${reason}.`, { path, reason });
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsJsonError("invalid_json_source", `${path} must contain a JSON object.`, { path });
  }
  return {
    json: parsed as SettingsJson,
    version: await sha256(raw),
    path,
    missing: false,
    duplicateKeyPaths: findDuplicateJsonKeyPaths(raw.trim().length === 0 ? "{}" : raw),
  };
}

export async function writeSettingsJson(input: {
  readonly path: string;
  readonly patch: SettingsJson;
}): Promise<{ readonly version: string }> {
  const { path, patch } = input;
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
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

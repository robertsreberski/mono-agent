import { readFile, writeFile, rename, chmod, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { MonoAgentConfigError } from "./config.js";
import type { MemoryScope, MemoryWriteMode } from "./types.js";

/**
 * Serializable shape of MonoAgentConfig persisted as `mono-agent.config.json`.
 *
 * All fields are optional so a partially-configured file is acceptable. Env
 * variables can still satisfy missing fields when the layered loader runs.
 *
 * Paths inside this file are relative to the file's containing directory (or
 * the loader's `cwd`); they are resolved by the loader, not at write time.
 */
export interface MonoAgentConfigJson {
  readonly telegram?: {
    readonly botToken?: string;
    readonly allowedChatIds?: readonly string[];
  };
  readonly runtime?: {
    readonly model?: string;
    readonly executionMode?: string;
    readonly effort?: string;
    readonly maxTurns?: number;
    readonly workspace?: string;
  };
  readonly context?: {
    readonly identityPath?: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills?: readonly string[];
  };
  readonly memory?: {
    readonly path?: string;
    readonly maxBytes?: number;
    readonly scope?: MemoryScope;
    readonly writeMode?: MemoryWriteMode;
  };
  readonly tools?: {
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly mcpConfigPath?: string;
  };
  readonly artifacts?: {
    readonly dir?: string;
  };
}

export interface ReadMonoAgentConfigJsonResult {
  readonly json: MonoAgentConfigJson;
  /** sha-256 of the parsed content (or empty string when the file is missing). */
  readonly version: string;
  /** Absolute path actually read. */
  readonly path: string;
  /** True when the file did not exist on disk. */
  readonly missing: boolean;
}

/**
 * Read a JSON config file. Missing file returns an empty config rather than
 * throwing; that lets hosts ship a blank config and fall back to env defaults.
 */
export async function readMonoAgentConfigJson(path: string): Promise<ReadMonoAgentConfigJsonResult> {
  if (!existsSync(path)) {
    return { json: {}, version: "", path, missing: true };
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MonoAgentConfigError("invalid_env", `Cannot read ${path}: ${reason}.`, { path, reason });
  }
  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MonoAgentConfigError("invalid_env", `Cannot parse ${path}: ${reason}.`, { path, reason });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MonoAgentConfigError("invalid_env", `${path} must contain a JSON object.`, { path });
  }
  const version = await sha256(raw);
  return { json: parsed as MonoAgentConfigJson, version, path, missing: false };
}

/**
 * Atomically write a JSON config file. Writes to `<path>.tmp` first, fsyncs,
 * then renames over the target. The temp file is unlinked on failure so we
 * never leave a half-written `.tmp` behind on the next run.
 */
export async function writeMonoAgentConfigJson(input: {
  readonly path: string;
  readonly patch: MonoAgentConfigJson;
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
    throw new MonoAgentConfigError("invalid_env", `Cannot write ${path}: ${reason}.`, { path, reason });
  }
  return { version: await sha256(serialized) };
}

async function mergePatch(path: string, patch: MonoAgentConfigJson): Promise<MonoAgentConfigJson> {
  const existing = (await readMonoAgentConfigJson(path)).json;
  const merged: Record<string, unknown> = { ...existing, ...patch };
  const sections = ["telegram", "runtime", "context", "memory", "tools", "artifacts"] as const;
  for (const key of sections) {
    const section = mergeSection(existing[key], patch[key]);
    if (section === undefined) {
      delete merged[key];
    } else {
      merged[key] = section;
    }
  }
  return merged as MonoAgentConfigJson;
}

function mergeSection<T extends Record<string, unknown> | undefined>(existing: T, patch: T): T {
  if (patch === undefined) {
    return existing;
  }
  if (existing === undefined) {
    return patch;
  }
  return { ...existing, ...patch } as T;
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

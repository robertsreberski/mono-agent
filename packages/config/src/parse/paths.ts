import { homedir } from "node:os";

import { resolve } from "node:path";

import { normalizeOptionalString } from "@mono-agent/contracts";

import { MonoAgentConfigError } from "../errors.js";

export function readPath(raw: string | undefined, cwd: string, defaultPath?: string): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    if (defaultPath !== undefined) {
      return defaultPath;
    }
    throw new MonoAgentConfigError("invalid_json", "Path value is required.");
  }
  return resolve(cwd, normalized);
}

export function readUserPath(raw: string | undefined, cwd: string, defaultPath?: string): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    if (defaultPath !== undefined) {
      return defaultPath;
    }
    throw new MonoAgentConfigError("invalid_json", "Path value is required.");
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return resolve(homedir(), normalized.slice(2));
  }
  return resolve(cwd, normalized);
}

export function readOptionalPath(raw: string | undefined, cwd: string): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized === undefined ? undefined : resolve(cwd, normalized);
}

export function normalizeCwd(value: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    throw new MonoAgentConfigError("invalid_json", "cwd must be a non-empty path.");
  }
  return resolve(normalized);
}

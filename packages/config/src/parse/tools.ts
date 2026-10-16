

import { isPrivateBaseUrl } from "@mono-agent/turn/host/config";

import { normalizeOptionalString, readBoolean, readCsv, readInteger } from "@mono-agent/contracts";

import type { MonoAgentConfig, WebSearchBackend } from "../types.js";

import { invalidJson, MonoAgentConfigError } from "../errors.js";

import { jsonContainer, jsonRecord, jsonString } from "./scalars.js";

import { readPath } from "./paths.js";

/** Optional per-MCP-call timeout override; unset defers to the runtime defaults (120s inactivity / 45 min total). */
export function readOptionalTimeoutMs(raw: string | undefined, name: string): number | undefined {
  if (normalizeOptionalString(raw) === undefined) {
    return undefined;
  }
  return readInteger(raw, name, 0, invalidJson, { min: 1000, max: 86_400_000 });
}

export function readWebSearchEndpoint(raw: string | undefined, source: string): string | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) return undefined;
  try {
    const endpoint = new URL(normalized);
    const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      endpoint.protocol !== "http:"
      || !["localhost", "127.0.0.1", "::1"].includes(host)
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) {
      throw new Error("not loopback HTTP");
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
    return endpoint.href.replace(/\/+$/u, "");
  } catch {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source} must be an unauthenticated loopback HTTP URL.`,
      { path: source },
    );
  }
}

const DEFAULT_OLLAMA_WEB_SEARCH_BASE_URL = "http://127.0.0.1:11434";

const OFFICIAL_OLLAMA_ORIGIN = "https://ollama.com";

export function readOllamaWebSearchConfig(
  value: unknown,
  backend: WebSearchBackend | readonly WebSearchBackend[],
): NonNullable<NonNullable<MonoAgentConfig["tools"]["web"]>["search"]["ollama"]> | undefined {
  const ollama = jsonRecord(value, "tools.web.search.ollama");
  if (ollama === undefined && !selectedWebProvider(backend, "ollama")) {
    return undefined;
  }
  const block = ollama ?? {};

  const source = "tools.web.search.ollama.baseUrl";
  const baseUrlRaw = normalizeOptionalString(jsonString(block.baseUrl, source));
  const apiKeyEnv = normalizeOptionalString(jsonString(block.apiKeyEnv, "tools.web.search.ollama.apiKeyEnv"));
  const trustRaw = jsonString(block.trustPublicUrl, "tools.web.search.ollama.trustPublicUrl");
  let parsed: URL;
  try {
    parsed = new URL(baseUrlRaw ?? DEFAULT_OLLAMA_WEB_SEARCH_BASE_URL);
  } catch {
    throw new MonoAgentConfigError("invalid_json", `${source} must be a valid HTTP(S) origin URL.`, { path: source });
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !["", "/"].includes(parsed.pathname)
  ) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source} must be an HTTP(S) origin without credentials, path, query, or fragment.`,
      { path: source },
    );
  }
  const baseUrl = parsed.origin;
  const official = baseUrl === OFFICIAL_OLLAMA_ORIGIN;
  const trustPublicUrl = trustRaw === undefined
    ? false
    : readBoolean(trustRaw, "tools.web.search.ollama.trustPublicUrl", false, invalidJson);
  if (!official && !isPrivateBaseUrl(baseUrl)) {
    if (parsed.protocol !== "https:" || !trustPublicUrl) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `${source} points to a public custom origin; use HTTPS and set tools.web.search.ollama.trustPublicUrl to true after reviewing it.`,
        { path: source },
      );
    }
  }
  if (!official && apiKeyEnv !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.ollama.apiKeyEnv is allowed only for the exact https://ollama.com origin.",
      { path: "tools.web.search.ollama.apiKeyEnv" },
    );
  }
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.ollama.apiKeyEnv must name an environment variable.",
      { path: "tools.web.search.ollama.apiKeyEnv" },
    );
  }
  if (official && apiKeyEnv === undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.ollama.apiKeyEnv is required for hosted Ollama Web Search.",
      { path: "tools.web.search.ollama.apiKeyEnv" },
    );
  }
  // The named credential stays unresolved at load: the web runtime reads it
  // from the effective environment when it calls the provider.
  return {
    baseUrl,
    trustPublicUrl,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  };
}

export function readWebSearchCodexModel(raw: string | undefined): string {
  const value = normalizeOptionalString(raw) ?? "gpt-5.6-luna";
  if (value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.codex.model must be a non-empty model id of at most 160 characters without control characters.",
      { path: "tools.web.search.codex.model" },
    );
  }
  return value;
}

export function readWebBrowserCommand(raw: string | undefined): string {
  const value = normalizeOptionalString(raw) ?? "agent-browser";
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.fetch.browserCommand must be one executable name or path without control characters.",
      { path: "tools.web.fetch.browserCommand" },
    );
  }
  return value;
}

// JSON arrays stay element-wise so roots containing commas retain their
// boundaries. A lone comma-separated string is still split for tolerance.
export function readFileToolRoots(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    const normalized = normalizeOptionalString(value);
    if (normalized === undefined) return [];
    if (normalized.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(normalized);
        if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
          return parsed;
        }
      } catch {
        // Report the same deterministic error as a parsed non-string array below.
      }
      throw new MonoAgentConfigError(
        "invalid_json",
        `${path} must be a comma-separated path list or an array of strings.`,
        { path, reason: "invalid_string_array" },
      );
    }
    return readCsv(value);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new MonoAgentConfigError(
    "invalid_json",
    `${path} must be a comma-separated path list or an array of strings.`,
    { path, reason: "invalid_string_array" },
  );
}

export function selectedWebProvider(selection: string | readonly string[], name: string): boolean {
  return typeof selection === "string" ? selection === name : selection.includes(name);
}

/**
 * The previous `auto` order for a search block, derived from the providers the
 * block actually configures. Used only to repair a stale `"auto"` selection.
 */
export function searchAutoRepair(search: Record<string, unknown> | undefined): readonly string[] {
  return [
    ...(search?.ollama !== undefined ? ["ollama"] : []),
    ...(normalizeOptionalString(jsonString((search?.searxng as Record<string, unknown> | undefined)?.endpoint, "tools.web.search.searxng.endpoint")) !== undefined
      || normalizeOptionalString(jsonString(search?.endpoint, "tools.web.search.endpoint")) !== undefined
      ? ["searxng"]
      : []),
    "codex", "keyless",
  ];
}

export function readWebProviderSelection<T extends string>(
  value: unknown, path: string, names: readonly T[], fallback: T | readonly T[],
  autoRepair?: readonly string[], renamed?: Record<string, string>,
): T | readonly T[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) {
    const retired = value.find((name) => typeof name === "string" && renamed && Object.hasOwn(renamed, name));
    if (typeof retired === "string") throw new MonoAgentConfigError("invalid_json", renamed![retired]!, { path });
    if (value.length === 0 || value.some((name) => typeof name !== "string" || !names.includes(name as T))) {
      throw new MonoAgentConfigError("invalid_json", `${path} must be one provider or a non-empty ordered chain of: ${names.join(", ")}.`, { path });
    }
    if (new Set(value).size !== value.length) {
      throw new MonoAgentConfigError("invalid_json", `${path} contains duplicate provider names.`, { path });
    }
    return value as T | readonly T[];
  }
  const raw = jsonString(value, path);
  const trimmed = normalizeOptionalString(raw);
  if (trimmed === undefined) return fallback;
  if (trimmed === "auto" && autoRepair !== undefined) {
    throw new MonoAgentConfigError("invalid_json", `tools.web.search.backend "auto" was removed; use ${JSON.stringify(autoRepair)} (the previous auto order for this configuration)`, { path });
  }
  let selection: unknown;
  try { selection = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.includes(",") ? trimmed.split(",").map((name) => name.trim()) : trimmed; }
  catch { selection = null; }
  const list = Array.isArray(selection) ? selection : [selection];
  if (renamed) {
    const retired = list.find((name) => typeof name === "string" && Object.hasOwn(renamed, name));
    if (typeof retired === "string") throw new MonoAgentConfigError("invalid_json", renamed[retired]!, { path });
  }
  if (!list.length || list.some((name) => typeof name !== "string" || !names.includes(name as T))) {
    throw new MonoAgentConfigError("invalid_json", `${path} must be one provider or a non-empty ordered chain of: ${names.join(", ")}.`, { path });
  }
  if (new Set(list).size !== list.length) {
    throw new MonoAgentConfigError("invalid_json", `${path} contains duplicate provider names.`, { path });
  }
  return selection as T | readonly T[];
}

export function readParallelWebConfig(value: unknown, path: string): { readonly apiKeyEnv: string } | undefined {
  const raw = jsonContainer(value)?.apiKeyEnv;
  if (raw === undefined) return undefined;
  const name = normalizeOptionalString(jsonString(raw, path)) ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new MonoAgentConfigError("invalid_json", `${path} must name an environment variable.`, { path });
  }
  // The named credential stays unresolved at load: the Parallel runtime reads
  // it from the effective environment at call time, so anonymous access is an
  // omitted field rather than a load error.
  return { apiKeyEnv: name };
}

export function readComputerUseConfig(value: unknown, cwd: string): MonoAgentConfig["tools"]["computerUse"] {
  if (value === undefined) return undefined;
  const fail = (message: string): never => {
    throw new MonoAgentConfigError("invalid_json", `${message} See docs/tools/computer-use.md#restricting-cua-driver.`, { path: "tools.computerUse" });
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("tools.computerUse must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "backend" && key !== "command")) {
    return fail("tools.computerUse accepts only backend and command; permission modes and manifests are not supported.");
  }
  if (record.backend !== "cua-driver") return fail('tools.computerUse.backend must be "cua-driver".');
  if (record.command === undefined) return { backend: "cua-driver" };
  if (typeof record.command !== "string" || record.command.trim().length === 0 || /[\x00-\x1f\x7f]/u.test(record.command)) {
    return fail("tools.computerUse.command must be a non-empty executable name or path, without control characters.");
  }
  const command = record.command.trim();
  return { backend: "cua-driver", command: /[\\/]/u.test(command) || command.startsWith("~") ? readPath(command, cwd) : command };
}

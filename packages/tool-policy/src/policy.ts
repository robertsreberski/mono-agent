import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ToolPolicyInput {
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Record<string, unknown>;
  readonly mcpConfigPath?: string;
  readonly approvalDefaultRiskTier?: string;
  readonly approvalAlwaysAllowTools?: readonly string[];
  readonly approvalTimeoutMs?: number;
  readonly toolRiskTiers?: Record<string, string>;
}

export interface ToolPolicy {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly mcpServers?: Record<string, unknown>;
  readonly mcpConfigPath?: string;
  readonly approvalDefaultRiskTier?: string;
  readonly approvalAlwaysAllowTools?: readonly string[];
  readonly approvalTimeoutMs?: number;
  readonly toolRiskTiers?: Record<string, string>;
}

export class ToolPolicyError extends Error {
  readonly code: "invalid_tool_policy" | "tool_policy_read_failed";
  readonly details: Record<string, unknown>;

  constructor(code: ToolPolicyError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolPolicyError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export function createToolPolicy(input: ToolPolicyInput = {}): ToolPolicy {
  const allowedTools = normalizeToolList(input.allowedTools, "allowedTools");
  const disallowedTools = normalizeToolList(input.disallowedTools, "disallowedTools");
  const overlap = allowedTools.filter((tool) => disallowedTools.includes(tool));
  if (overlap.length > 0) {
    throw new ToolPolicyError("invalid_tool_policy", "Tools cannot be both allowed and disallowed.", { overlap });
  }

  const policy: ToolPolicy = {
    allowedTools,
    disallowedTools,
    ...(input.mcpServers === undefined ? {} : { mcpServers: normalizeMcpServers(input.mcpServers) }),
    ...(input.mcpConfigPath === undefined ? {} : { mcpConfigPath: normalizeInlineString(input.mcpConfigPath, "mcpConfigPath") }),
    ...(input.approvalDefaultRiskTier === undefined ? {} : { approvalDefaultRiskTier: normalizeInlineString(input.approvalDefaultRiskTier, "approvalDefaultRiskTier") }),
    ...(input.approvalAlwaysAllowTools === undefined ? {} : { approvalAlwaysAllowTools: normalizeToolList(input.approvalAlwaysAllowTools, "approvalAlwaysAllowTools") }),
    ...(input.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: normalizePositiveInteger(input.approvalTimeoutMs, "approvalTimeoutMs") }),
    ...(input.toolRiskTiers === undefined ? {} : { toolRiskTiers: normalizeStringRecord(input.toolRiskTiers, "toolRiskTiers") }),
  };
  return policy;
}

export function failClosedToolPolicy(): ToolPolicy {
  return createToolPolicy({ allowedTools: [], disallowedTools: [] });
}

export async function loadToolPolicyFromJsonFile(filePath: string): Promise<ToolPolicy> {
  const resolvedPath = resolveRequiredPath(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new ToolPolicyError("tool_policy_read_failed", "Unable to read tool policy JSON.", {
      path: resolvedPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) {
    throw new ToolPolicyError("invalid_tool_policy", "Tool policy JSON must be an object.", { path: resolvedPath });
  }
  return createToolPolicy(parsedToPolicyInput(parsed));
}

export function toolPolicyToRuntimeOptions(policy: ToolPolicy): Record<string, unknown> {
  const options: Record<string, unknown> = {
    allowedTools: [...policy.allowedTools],
    disallowedTools: [...policy.disallowedTools],
  };
  if (policy.mcpServers !== undefined) {
    options.mcpServers = policy.mcpServers;
  }
  if (policy.mcpConfigPath !== undefined) {
    options.mcpConfigPath = policy.mcpConfigPath;
  }
  if (policy.approvalDefaultRiskTier !== undefined) {
    options.approvalDefaultRiskTier = policy.approvalDefaultRiskTier;
  }
  if (policy.approvalAlwaysAllowTools !== undefined) {
    options.approvalAlwaysAllowTools = [...policy.approvalAlwaysAllowTools];
  }
  if (policy.approvalTimeoutMs !== undefined) {
    options.approvalTimeoutMs = policy.approvalTimeoutMs;
  }
  if (policy.toolRiskTiers !== undefined) {
    options.toolRiskTiers = policy.toolRiskTiers;
  }
  return options;
}

function parsedToPolicyInput(parsed: Record<string, unknown>): ToolPolicyInput {
  return {
    ...(parsed.allowedTools === undefined ? {} : { allowedTools: asStringArray(parsed.allowedTools, "allowedTools") }),
    ...(parsed.disallowedTools === undefined ? {} : { disallowedTools: asStringArray(parsed.disallowedTools, "disallowedTools") }),
    ...(parsed.mcpServers === undefined ? {} : { mcpServers: asRecord(parsed.mcpServers, "mcpServers") }),
    ...(parsed.mcpConfigPath === undefined ? {} : { mcpConfigPath: asUnknownString(parsed.mcpConfigPath, "mcpConfigPath") }),
    ...(parsed.approvalDefaultRiskTier === undefined ? {} : { approvalDefaultRiskTier: asUnknownString(parsed.approvalDefaultRiskTier, "approvalDefaultRiskTier") }),
    ...(parsed.approvalAlwaysAllowTools === undefined ? {} : { approvalAlwaysAllowTools: asStringArray(parsed.approvalAlwaysAllowTools, "approvalAlwaysAllowTools") }),
    ...(parsed.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: asUnknownNumber(parsed.approvalTimeoutMs, "approvalTimeoutMs") }),
    ...(parsed.toolRiskTiers === undefined ? {} : { toolRiskTiers: asStringRecord(parsed.toolRiskTiers, "toolRiskTiers") }),
  };
}

function normalizeToolList(value: readonly unknown[] | undefined, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an array.`, { field });
  }
  const tools = value.map((tool, index) => normalizeInlineString(tool, `${field}[${index}]`));
  const seen = new Set<string>();
  for (const tool of tools) {
    const key = tool.toLowerCase();
    if (seen.has(key)) {
      throw new ToolPolicyError("invalid_tool_policy", `${field} contains duplicate tool names.`, { field, tool });
    }
    seen.add(key);
  }
  return tools;
}

function normalizeMcpServers(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ToolPolicyError("invalid_tool_policy", "mcpServers must be an object.");
  }
  return structuredClone(value);
}

function normalizeStringRecord(value: Record<string, string>, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an object.`, { field });
  }
  const out: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    out[normalizeInlineString(key, `${field}.key`)] = normalizeInlineString(entryValue, `${field}.${key}`);
  }
  return out;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be a positive integer.`, { field });
  }
  return value;
}

function normalizeInlineString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be a string.`, { field });
  }
  const normalized = value.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
  if (normalized.length === 0) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must not be empty.`, { field });
  }
  return normalized;
}

function resolveRequiredPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolPolicyError("invalid_tool_policy", "filePath must be a non-empty string.");
  }
  return resolve(value);
}

function asStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an array.`, { field });
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new ToolPolicyError("invalid_tool_policy", `${field}[${index}] must be a string.`, { field });
    }
  }
  return value;
}

function asUnknownString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be a string.`, { field });
  }
  return value;
}

function asUnknownNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be a number.`, { field });
  }
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an object.`, { field });
  }
  return value;
}

function asStringRecord(value: unknown, field: string): Record<string, string> {
  const record = asRecord(value, field);
  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue !== "string") {
      throw new ToolPolicyError("invalid_tool_policy", `${field}.${key} must be a string.`, { field });
    }
  }
  return record as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

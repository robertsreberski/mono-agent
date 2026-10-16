

import { modelReferenceKey,parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";

import type { RuntimeModelReference } from "@mono-agent/turn/host/types";



import {
readChoice
} from "@mono-agent/contracts";

import {
ALLOW_ALL_TOOLS,
EFFORT_LEVELS,
renamedToolMessage,
renamedToolName
} from "../enums.js";


import type { EffortLevel,MonoAgentConfig,MonoAgentInlineSubagentsConfig,MonoAgentSubagentConfig,MonoAgentSubagentModelChoice,MonoAgentSubagentsConfig } from "../types.js";

import { invalidJson,MonoAgentConfigError } from "../errors.js";



import { jsonRecord } from "./scalars.js";

import { modelReferenceEcho,modelReferenceReason,readModelSelection } from "./model-reference.js";


import { readPath } from "./paths.js";

const SUBAGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/u;

export function readSubagentsConfig(
  value: unknown,
  cwd: string,
): MonoAgentSubagentsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = jsonRecord(value, "subagents");
  if (parsed === undefined) {
    return undefined;
  }
  const record = parsed;
  const definitions = readSubagentDefinitions(record.definitions, cwd);
  const models = readSubagentModels(record.models, definitions);
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "enabled") }),
    ...(record.maxConcurrent === undefined ? {} : { maxConcurrent: readSubagentInteger(record.maxConcurrent, "maxConcurrent", 1, 10) }),
    ...(record.maxPerTurn === undefined ? {} : { maxPerTurn: readSubagentInteger(record.maxPerTurn, "maxPerTurn", 1, 200) }),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: readSubagentInteger(record.timeoutMs, "timeoutMs", 1_000, 14_400_000) }),
    ...(record.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: readSubagentInteger(record.commandTimeoutMs, "commandTimeoutMs", 1, Number.MAX_SAFE_INTEGER) }),
    ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, "maxTurns", 1, 400) }),
    ...(definitions === undefined ? {} : { definitions }),
    ...(models === undefined ? {} : { models }),
    ...(record.inline === undefined ? {} : { inline: readInlineSubagentsConfig(record.inline) }),
    ...(record.instances === undefined ? {} : { instances: readSubagentInstancesConfig(record.instances, cwd) }),
  };
}

function readSubagentInstancesConfig(value: unknown, cwd: string): NonNullable<MonoAgentSubagentsConfig["instances"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSubagents("instances must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["enabled", "root", "maxPerConversation", "idleTtlMs", "maxTurns"].includes(key)) {
      throw invalidSubagents(`instances contains unknown field "${key}".`);
    }
  }
  if (record.root !== undefined && (typeof record.root !== "string" || !record.root.trim())) {
    throw invalidSubagents("instances.root must be a non-empty path.");
  }
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "instances.enabled") }),
    ...(record.root === undefined ? {} : { root: readPath(String(record.root), cwd) }),
    ...(record.maxPerConversation === undefined ? {} : { maxPerConversation: readSubagentInteger(record.maxPerConversation, "instances.maxPerConversation", 1, 32) }),
    ...(record.idleTtlMs === undefined ? {} : { idleTtlMs: readSubagentInteger(record.idleTtlMs, "instances.idleTtlMs", 60_000, 604_800_000) }),
    ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, "instances.maxTurns", 1, 500) }),
  };
}

function readSubagentModels(
  value: unknown,
  definitions: readonly MonoAgentSubagentConfig[] | undefined,
): readonly MonoAgentSubagentModelChoice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidSubagents("models must be an array.");
  const names = new Set<string>();
  const models = new Set<string>();
  const reserved = new Set(["general-purpose", ...(definitions ?? []).map((definition) => definition.name)]);
  return value.map((entry, index) => {
    const subject = `models[${index}]`;
    if (typeof entry !== "string" && (entry === null || typeof entry !== "object" || Array.isArray(entry))) {
      throw invalidSubagents(`${subject} must be a model reference string or object.`);
    }
    const record = typeof entry === "string" ? { model: entry } : entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "name" && key !== "model" && key !== "context1M") throw invalidSubagents(`${subject} contains unknown field "${key}".`);
    }
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      throw invalidSubagents(`${subject} model must be a model reference string.`);
    }
    let model: RuntimeModelReference;
    try {
      model = parseMonoRuntimeModelReference(record.model);
    } catch (error) {
      const reason = modelReferenceReason(error);
      throw new MonoAgentConfigError("invalid_model_reference",
        `subagents ${subject} model \`${modelReferenceEcho(record.model)}\` is not a valid runtime model reference: ${reason}`,
        { path: "subagents", reason });
    }
    if (record.name !== undefined && (typeof record.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(record.name))) {
      throw invalidSubagents(`${subject} name must be lowercase kebab-case, 1-40 characters, without a colon.`);
    }
    const key = modelReferenceKey(model);
    const name = record.name as string | undefined;
    const effectiveName = name ?? key;
    if (reserved.has(effectiveName)) throw invalidSubagents(`${subject} name "${effectiveName}" collides with a subagent name.`);
    if (models.has(key)) throw invalidSubagents(`${subject} duplicate model reference "${key}".`);
    if (names.has(effectiveName)) throw invalidSubagents(`${subject} duplicate model name "${effectiveName}".`);
    names.add(effectiveName);
    models.add(key);
    return { ...(name === undefined ? {} : { name }), model };
  });
}

function readInlineSubagentsConfig(value: unknown): MonoAgentInlineSubagentsConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSubagents("inline must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowedTools = readSubagentTools(record.allowedTools, "inline", "allowedTools");
  // Same reasoning as a declared profile: the ceiling is what stops an authored
  // subagent reaching past its author, so it must be enumerated, and `Agent`
  // stays out of it because subagents never spawn subagents.
  if (allowedTools?.includes(ALLOW_ALL_TOOLS)) {
    throw invalidSubagents(`inline allowedTools cannot use the ${ALLOW_ALL_TOOLS} wildcard; list the tools it needs.`);
  }
  if (allowedTools?.some((tool) => tool === "Agent" || tool === "AgentManage")) {
    throw invalidSubagents("inline allowedTools cannot allow Agent or AgentManage; subagents never spawn subagents or continue other instances.");
  }
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "inline.enabled") }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  };
}

function readSubagentDefinitions(
  value: unknown,
  cwd: string,
): readonly MonoAgentSubagentConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidSubagents("definitions must be an array.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidSubagents(`definition ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!SUBAGENT_NAME_RE.test(name)) {
      throw invalidSubagents(`definition ${index + 1} name must be lowercase kebab-case (got ${JSON.stringify(record.name)}).`);
    }
    if (seen.has(name)) {
      throw invalidSubagents(`duplicate definition name "${name}".`);
    }
    seen.add(name);
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (description.length === 0) {
      throw invalidSubagents(`definition "${name}" needs a non-empty description; the model picks profiles by it.`);
    }
    const hasPrompt = typeof record.prompt === "string" && record.prompt.trim().length > 0;
    const hasPromptPath = typeof record.promptPath === "string" && record.promptPath.trim().length > 0;
    if (hasPrompt === hasPromptPath) {
      throw invalidSubagents(`definition "${name}" needs exactly one of prompt or promptPath.`);
    }
    const subject = `definition "${name}"`;
    const allowedTools = readSubagentTools(record.allowedTools, subject, "allowedTools");
    const disallowedTools = readSubagentTools(record.disallowedTools, subject, "disallowedTools");
    const mcpServers = readSubagentTools(record.mcpServers, subject, "mcpServers");
    // `"*"` would hand a subagent every built-in including shell and writes.
    // Widening a helper's reach must be an explicit, enumerated decision.
    if (allowedTools?.includes(ALLOW_ALL_TOOLS)) {
      throw invalidSubagents(`definition "${name}" cannot use the ${ALLOW_ALL_TOOLS} wildcard; list the tools it needs.`);
    }
    if (allowedTools?.some((tool) => tool === "Agent" || tool === "AgentManage")) {
      throw invalidSubagents(`definition "${name}" cannot allow Agent or AgentManage; subagents never spawn subagents or continue other instances.`);
    }
    return {
      name,
      description,
      ...(hasPrompt ? { prompt: String(record.prompt).trim() } : {}),
      ...(hasPromptPath ? { promptPath: readPath(String(record.promptPath), cwd) } : {}),
      ...(record.model === undefined ? {} : { model: parseSubagentModel(readModelSelection(record.model, `subagents.definitions[${index}].model`), name) }),
      ...(record.effort === undefined ? {} : {
        effort: readChoice<EffortLevel>(String(record.effort), `subagents.definitions[${index}].effort`, EFFORT_LEVELS, "medium", invalidJson),
      }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, `definition "${name}" maxTurns`, 1, 400) }),
      ...(record.timeoutMs === undefined ? {} : { timeoutMs: readSubagentInteger(record.timeoutMs, `definition "${name}" timeoutMs`, 1_000, 14_400_000) }),
    } satisfies MonoAgentSubagentConfig;
  });
}

function parseSubagentModel(value: unknown, name: string): MonoAgentConfig["runtime"]["model"] {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidSubagents(`definition "${name}" model must be a model reference string.`);
  }
  try {
    return parseMonoRuntimeModelReference(value);
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `subagents definition "${name}" model \`${modelReferenceEcho(value)}\` is not a valid runtime model reference: ${reason}`,
      { path: "subagents", reason },
    );
  }
}

/** `subject` is the already-formatted owner of the field, e.g. `definition "researcher"`. */
function readSubagentTools(value: unknown, subject: string, field: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw invalidSubagents(`${subject} ${field} must be an array of non-empty strings.`);
  }
  const tools = value.map((entry) => String(entry).trim());
  if (field !== "mcpServers") {
    // A renamed tool has no alias, so a stale entry would grant or deny
    // nothing. Name the migration instead of accepting it silently.
    const retired = tools.find((tool) => renamedToolName(tool) !== undefined);
    if (retired !== undefined) {
      throw invalidSubagents(renamedToolMessage(retired, `${subject} ${field}`));
    }
  }
  return tools;
}

function readSubagentBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidSubagents(`${field} must be a boolean.`);
  }
  return value;
}

function readSubagentInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalidSubagents(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function invalidSubagents(detail: string): MonoAgentConfigError {
  return new MonoAgentConfigError("invalid_json", `subagents ${detail}`, {
    path: "subagents",
  });
}

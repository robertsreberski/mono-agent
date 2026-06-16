import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { MonoAgentConfigJson } from "@mono-agent/config";
import type { SettingsJsonValue } from "@mono-agent/settings";

import type { MultiAgentRole } from "./orchestrator-responder.js";

export const DEFAULT_MULTI_AGENT_DEPLOY_MODEL = "gemma4:31b";
export const DEFAULT_MULTI_AGENT_MODEL_REFERENCE = "pi:ollama:gemma4:31b";
export const DEFAULT_MULTI_AGENT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_MULTI_AGENT_CONFIG_DIR = ".mono-agent/multi-agent";
export const DEFAULT_MULTI_AGENT_ROLE_TIMEOUT_MS = 60_000;
export const DEFAULT_MULTI_AGENT_COLLABORATOR_TIMEOUT_MS = 300_000;

export const MULTI_AGENT_ROLES = ["orchestrator", "researcher", "worker"] as const satisfies readonly MultiAgentRole[];

export type OllamaReadiness =
  | { readonly kind: "ready"; readonly model: string; readonly baseUrl: string }
  | { readonly kind: "server_unavailable"; readonly model: string; readonly baseUrl: string; readonly reason: string }
  | { readonly kind: "model_missing"; readonly model: string; readonly baseUrl: string; readonly availableModels: readonly string[] };

export interface MultiAgentDeploymentOptions {
  readonly cwd: string;
  readonly configDir?: string;
  readonly model?: string;
  readonly orchestratorModel?: string;
  readonly researcherModel?: string;
  readonly workerModel?: string;
  readonly ollamaBaseUrl?: string;
  readonly operatorConsolePort?: number;
  readonly orchestratorA2APort?: number;
  readonly researcherA2APort?: number;
  readonly workerA2APort?: number;
}

export interface MultiAgentRoleDeploymentFiles {
  readonly configPath: string;
  readonly memoryPath: string;
  readonly workspaceDir: string;
  readonly artifactDir: string;
}

export interface MultiAgentDeploymentFiles {
  readonly configDir: string;
  readonly traceRegistryDir: string;
  readonly roles: Record<MultiAgentRole, MultiAgentRoleDeploymentFiles>;
}

export type MultiAgentRoleDeploymentConfig = MonoAgentConfigJson & {
  readonly a2a: {
    readonly provider: {
      readonly enabled: true;
      readonly host: "127.0.0.1";
      readonly port: number;
    };
    readonly agent: {
      readonly name: string;
      readonly description: string;
      readonly version: string;
    };
    readonly skill: {
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly tags: readonly string[];
    };
    readonly consumer: {
      readonly remoteAgentUrls: readonly string[];
      readonly timeoutMs: number;
    };
  };
};

export type MultiAgentDeploymentConfigSet = Record<MultiAgentRole, MultiAgentRoleDeploymentConfig>;

export function buildMultiAgentDeploymentConfigs(
  options: MultiAgentDeploymentOptions,
): MultiAgentDeploymentConfigSet {
  const cwd = resolve(options.cwd);
  const baseDir = resolve(cwd, options.configDir ?? DEFAULT_MULTI_AGENT_CONFIG_DIR);
  const traceRegistryDir = join(baseDir, "trace-sources");
  const models = resolveRoleModels(options);
  return {
    orchestrator: buildRoleConfig({
      cwd,
      baseDir,
      traceRegistryDir,
      role: "orchestrator",
      model: models.orchestrator,
      ollamaBaseUrl: options.ollamaBaseUrl,
      allowedTools: [],
      disallowedTools: [],
      a2aPort: options.orchestratorA2APort ?? 0,
    }),
    researcher: buildRoleConfig({
      cwd,
      baseDir,
      traceRegistryDir,
      role: "researcher",
      model: models.researcher,
      ollamaBaseUrl: options.ollamaBaseUrl,
      allowedTools: ["WebSearch", "WebFetch"],
      disallowedTools: ["Bash", "Read", "Write", "Edit"],
      a2aPort: options.researcherA2APort ?? 0,
    }),
    worker: buildRoleConfig({
      cwd,
      baseDir,
      traceRegistryDir,
      role: "worker",
      model: models.worker,
      ollamaBaseUrl: options.ollamaBaseUrl,
      allowedTools: ["Read", "Grep", "Bash"],
      disallowedTools: ["Write", "Edit"],
      a2aPort: options.workerA2APort ?? 0,
    }),
  };
}

export function roleConfigPath(input: {
  readonly cwd: string;
  readonly configDir?: string;
  readonly role: MultiAgentRole;
}): string {
  const baseDir = resolve(input.cwd, input.configDir ?? DEFAULT_MULTI_AGENT_CONFIG_DIR);
  return join(baseDir, "config", `${input.role}.config.json`);
}

export async function writeMultiAgentDeploymentFiles(
  options: MultiAgentDeploymentOptions,
): Promise<MultiAgentDeploymentFiles> {
  const cwd = resolve(options.cwd);
  const baseDir = resolve(cwd, options.configDir ?? DEFAULT_MULTI_AGENT_CONFIG_DIR);
  const configs = buildMultiAgentDeploymentConfigs(options);
  const traceRegistryDir = join(baseDir, "trace-sources");
  const roles = roleFileMap(cwd, baseDir);

  const dirs = new Set<string>([
    join(baseDir, "config"),
    traceRegistryDir,
    ...MULTI_AGENT_ROLES.flatMap((role) => [
      // memoryPath is now the per-role memory root directory; the engine creates memory.db inside it.
      roles[role].memoryPath,
      roles[role].workspaceDir,
      roles[role].artifactDir,
    ]),
  ]);
  await Promise.all([...dirs].map((dir) => mkdir(dir, { recursive: true })));

  await Promise.all(MULTI_AGENT_ROLES.map(async (role) => {
    await writeFile(roles[role].configPath, `${JSON.stringify(configs[role], null, 2)}\n`, { encoding: "utf8" });
  }));

  return {
    configDir: baseDir,
    traceRegistryDir,
    roles,
  };
}

export async function checkOllamaModels(
  options: Pick<MultiAgentDeploymentOptions, "model" | "orchestratorModel" | "researcherModel" | "workerModel" | "ollamaBaseUrl"> = {},
): Promise<readonly OllamaReadiness[]> {
  const models = new Set(Object.values(resolveRoleModels(options)));
  const results: OllamaReadiness[] = [];
  for (const model of models) {
    results.push(await checkOllamaModel({
      model,
      ...(options.ollamaBaseUrl === undefined ? {} : { ollamaBaseUrl: options.ollamaBaseUrl }),
    }));
  }
  return results;
}

export async function checkOllamaModel(options: {
  readonly model?: string;
  readonly ollamaBaseUrl?: string | undefined;
} = {}): Promise<OllamaReadiness> {
  const model = normalizeModel(options.model);
  const baseUrl = normalizeBaseUrl(options.ollamaBaseUrl);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/tags`);
  } catch (error) {
    return {
      kind: "server_unavailable",
      model,
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      kind: "server_unavailable",
      model,
      baseUrl,
      reason: `Ollama returned HTTP ${response.status}.`,
    };
  }

  try {
    const parsed = await response.json() as unknown;
    const availableModels = modelNamesFromTagsResponse(parsed);
    if (availableModels.includes(model)) {
      return { kind: "ready", model, baseUrl };
    }
    return { kind: "model_missing", model, baseUrl, availableModels };
  } catch (error) {
    return {
      kind: "server_unavailable",
      model,
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function modelReferenceFor(model: string): string {
  return `pi:ollama:${normalizeModel(model)}`;
}

function buildRoleConfig(input: {
  readonly cwd: string;
  readonly baseDir: string;
  readonly traceRegistryDir: string;
  readonly role: MultiAgentRole;
  readonly model: string;
  readonly ollamaBaseUrl: string | undefined;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly a2aPort: number;
}): MultiAgentRoleDeploymentConfig {
  const model = normalizeModel(input.model);
  return {
    runtime: {
      model: modelReferenceFor(model),
      executionMode: "sdk",
      maxTurns: input.role === "orchestrator" ? 8 : 6,
      workspace: jsonPath(input.cwd, join(input.baseDir, "workspace", input.role)),
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    providers: {
      local: [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: normalizeBaseUrl(input.ollamaBaseUrl),
          enabled: true,
          models: [
            {
              name: model,
              displayName: displayNameForModel(model),
              capabilities: capabilitiesForModel(model),
            },
          ],
        },
      ],
    },
    context: {
      identityPath: `./demos/multi-agent/IDENTITY.${input.role}.md`,
      selectedSkills: [],
    },
    memory: {
      // Memory v2: a root *directory* per role (holds memory.db + daily/), not a markdown file.
      mode: "lite",
      path: jsonPath(input.cwd, join(input.baseDir, "memory", input.role)),
      maxBytes: 64_000,
      writeMode: "disabled",
    },
    tools: {
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
    },
    artifacts: {
      dir: jsonPath(input.cwd, join(input.baseDir, "artifacts", input.role)),
    },
    traceability: {
      registryDir: jsonPath(input.cwd, input.traceRegistryDir),
      sourceId: `multi-agent-${input.role}`,
      sourceLabel: `Multi-Agent ${titleCase(input.role)}`,
      heartbeatMs: 10_000,
      staleAfterMs: 30_000,
    },
    a2a: {
      provider: {
        enabled: true,
        host: "127.0.0.1",
        port: input.a2aPort,
      },
      agent: {
        name: `Multi-Agent ${titleCase(input.role)}`,
        description: descriptionForRole(input.role),
        version: "0.1.0",
      },
      skill: {
        id: `multi-agent-${input.role}`,
        name: `${titleCase(input.role)} collaboration`,
        description: skillDescriptionForRole(input.role),
        tags: ["agent", "multi-agent", input.role],
      },
      consumer: {
        remoteAgentUrls: [],
        timeoutMs: consumerTimeoutForRole(input.role),
      },
    },
  };
}

function consumerTimeoutForRole(role: MultiAgentRole): number {
  return role === "orchestrator"
    ? DEFAULT_MULTI_AGENT_COLLABORATOR_TIMEOUT_MS
    : DEFAULT_MULTI_AGENT_ROLE_TIMEOUT_MS;
}

function resolveRoleModels(
  options: Pick<MultiAgentDeploymentOptions, "model" | "orchestratorModel" | "researcherModel" | "workerModel">,
): Record<MultiAgentRole, string> {
  const base = normalizeModel(options.model);
  return {
    orchestrator: normalizeModel(options.orchestratorModel ?? base),
    researcher: normalizeModel(options.researcherModel ?? base),
    worker: normalizeModel(options.workerModel ?? base),
  };
}

function roleFileMap(cwd: string, baseDir: string): Record<MultiAgentRole, MultiAgentRoleDeploymentFiles> {
  return {
    orchestrator: roleFiles(cwd, baseDir, "orchestrator"),
    researcher: roleFiles(cwd, baseDir, "researcher"),
    worker: roleFiles(cwd, baseDir, "worker"),
  };
}

function roleFiles(cwd: string, baseDir: string, role: MultiAgentRole): MultiAgentRoleDeploymentFiles {
  return {
    configPath: roleConfigPath({ cwd, configDir: baseDir, role }),
    memoryPath: join(baseDir, "memory", role),
    workspaceDir: join(baseDir, "workspace", role),
    artifactDir: join(baseDir, "artifacts", role),
  };
}

function jsonPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (rel.length === 0) {
    return ".";
  }
  if (rel.startsWith("..") || rel.startsWith("/")) {
    return absolutePath;
  }
  return `./${rel}`;
}

function normalizeModel(value: string | undefined): string {
  const normalized = value?.trim() ?? DEFAULT_MULTI_AGENT_DEPLOY_MODEL;
  return normalized.length === 0 ? DEFAULT_MULTI_AGENT_DEPLOY_MODEL : normalized;
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = value?.trim() ?? DEFAULT_MULTI_AGENT_OLLAMA_BASE_URL;
  return normalized.replace(/\/+$/u, "");
}

function displayNameForModel(model: string): string {
  if (model === DEFAULT_MULTI_AGENT_DEPLOY_MODEL) {
    return "Gemma 4 31B";
  }
  return model;
}

function capabilitiesForModel(model: string): Record<string, SettingsJsonValue> {
  if (model.startsWith("gemma4:")) {
    return {
      family: "gemma4",
      context_window: 256_000,
      reasoning: true,
      reasoning_mode: "toggle",
      vision: true,
      json_mode: true,
    };
  }
  return {
    family: model.split(":")[0] ?? "ollama",
    reasoning: true,
    reasoning_mode: "toggle",
    json_mode: true,
  };
}

function modelNamesFromTagsResponse(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }
  const names: string[] = [];
  for (const item of value.models) {
    if (!isRecord(item)) {
      continue;
    }
    const name = typeof item.name === "string"
      ? item.name
      : typeof item.model === "string"
        ? item.model
        : undefined;
    if (name !== undefined && name.trim().length > 0) {
      names.push(name.trim());
    }
  }
  return names;
}

function titleCase(role: MultiAgentRole): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function descriptionForRole(role: MultiAgentRole): string {
  if (role === "orchestrator") {
    return "Telegram-connected orchestrator that asks researcher and worker agents before synthesizing.";
  }
  if (role === "researcher") {
    return "Research collaborator with web-oriented tools for current external context.";
  }
  return "Worker collaborator with read-only local workspace inspection tools.";
}

function skillDescriptionForRole(role: MultiAgentRole): string {
  if (role === "orchestrator") {
    return "Runs the tool-directed multi-agent flow.";
  }
  if (role === "researcher") {
    return "Provides one concise web-aware research contribution.";
  }
  return "Provides one concise read-only local inspection contribution.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

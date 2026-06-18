import type {
  MonoAgentConfigJson,
  RedactedMonoAgentConfig,
} from "@mono-agent/config";

export type TuiConfigFieldSource = "env" | "json" | "default";

export interface TuiConfigFieldSummary {
  readonly label: string;
  readonly value: string;
  readonly source: TuiConfigFieldSource;
  readonly redacted?: boolean;
}

export interface TuiConfigSummarySection {
  readonly heading: string;
  readonly fields: readonly TuiConfigFieldSummary[];
}

export interface BuildTuiConfigSummaryInput {
  readonly redacted: RedactedMonoAgentConfig;
  readonly json: MonoAgentConfigJson;
  readonly env: Record<string, string | undefined>;
}

interface FieldSpec {
  readonly label: string;
  readonly envKey: string | undefined;
  readonly jsonPresent: boolean;
  readonly value: string;
  readonly redacted?: boolean;
}

const ENV_KEYS = {
  runtimeModel: "MONO_AGENT_MODEL",
  runtimeExecutionMode: "MONO_AGENT_EXECUTION_MODE",
  runtimeEffort: "MONO_AGENT_EFFORT",
  runtimeMaxTurns: "MONO_AGENT_MAX_TURNS",
  runtimeWorkspace: "MONO_AGENT_WORKSPACE",
  contextIdentity: "MONO_AGENT_IDENTITY_PATH",
  contextSoul: "MONO_AGENT_SOUL_PATH",
  contextSkillsRoot: "MONO_AGENT_SKILLS_ROOT",
  contextSelectedSkills: "MONO_AGENT_SELECTED_SKILLS",
  memoryPath: "MONO_AGENT_MEMORY_PATH",
  memoryMaxBytes: "MONO_AGENT_MEMORY_MAX_BYTES",
  memoryWriteMode: "MONO_AGENT_MEMORY_WRITE_MODE",
  toolsAllowed: "MONO_AGENT_ALLOWED_TOOLS",
  toolsDisallowed: "MONO_AGENT_DISALLOWED_TOOLS",
  toolsMcpConfigPath: "MONO_AGENT_MCP_CONFIG_PATH",
  artifactsDir: "MONO_AGENT_ARTIFACT_DIR",
} as const;

function envHas(
  env: Record<string, string | undefined>,
  key: string | undefined,
): boolean {
  if (key === undefined) {
    return false;
  }
  const value = env[key];
  return value !== undefined && value.trim().length > 0;
}

function resolveSource(
  env: Record<string, string | undefined>,
  spec: FieldSpec,
): TuiConfigFieldSource {
  if (envHas(env, spec.envKey)) {
    return "env";
  }
  if (spec.jsonPresent) {
    return "json";
  }
  return "default";
}

function formatRuntimeModelReference(
  reference: RedactedMonoAgentConfig["runtime"]["model"],
): string {
  if (typeof reference === "string") {
    return reference;
  }
  if (reference.reference !== undefined && reference.reference.length > 0) {
    return reference.reference;
  }
  const provider = reference.provider !== undefined ? `${reference.provider}:` : "";
  return `${reference.sdk}:${provider}${reference.model}`;
}

function toField(
  env: Record<string, string | undefined>,
  spec: FieldSpec,
): TuiConfigFieldSummary {
  return {
    label: spec.label,
    value: spec.value,
    source: resolveSource(env, spec),
    ...(spec.redacted === true ? { redacted: true } : {}),
  };
}

/**
 * Build a compact, redacted view of the resolved configuration suitable for
 * the TUI's Config pane. The pane is read-only — edits are made directly in
 * `mono-agent.config.json` and take effect on the next `mono-agent restart`.
 */
export function buildTuiConfigSummary(
  input: BuildTuiConfigSummaryInput,
): readonly TuiConfigSummarySection[] {
  const { redacted, json, env } = input;
  const sections: TuiConfigSummarySection[] = [];

  sections.push({
    heading: "runtime",
    fields: [
      toField(env, {
        label: "model",
        envKey: ENV_KEYS.runtimeModel,
        jsonPresent: json.runtime?.model !== undefined,
        value: formatRuntimeModelReference(redacted.runtime.model),
      }),
      toField(env, {
        label: "executionMode",
        envKey: ENV_KEYS.runtimeExecutionMode,
        jsonPresent: json.runtime?.executionMode !== undefined,
        value: redacted.runtime.executionMode,
      }),
      toField(env, {
        label: "effort",
        envKey: ENV_KEYS.runtimeEffort,
        jsonPresent: json.runtime?.effort !== undefined,
        value: redacted.runtime.effort ?? "—",
      }),
      toField(env, {
        label: "maxTurns",
        envKey: ENV_KEYS.runtimeMaxTurns,
        jsonPresent: json.runtime?.maxTurns !== undefined,
        value: redacted.runtime.maxTurns === undefined ? "unlimited" : String(redacted.runtime.maxTurns),
      }),
      toField(env, {
        label: "workspace",
        envKey: ENV_KEYS.runtimeWorkspace,
        jsonPresent: json.runtime?.workspace !== undefined,
        value: redacted.runtime.workspace,
      }),
    ],
  });

  sections.push({
    heading: "context",
    fields: [
      toField(env, {
        label: "identityPath",
        envKey: ENV_KEYS.contextIdentity,
        jsonPresent: json.context?.identityPath !== undefined,
        value: redacted.context.identityPath,
      }),
      ...(redacted.context.soulPath !== undefined
        ? [
            toField(env, {
              label: "soulPath",
              envKey: ENV_KEYS.contextSoul,
              jsonPresent: json.context?.soulPath !== undefined,
              value: redacted.context.soulPath,
            }),
          ]
        : []),
      toField(env, {
        label: "skillsRoot",
        envKey: ENV_KEYS.contextSkillsRoot,
        jsonPresent: json.context?.skillsRoot !== undefined,
        value: redacted.context.skillsRoot ?? "—",
      }),
      toField(env, {
        label: "selectedSkills",
        envKey: ENV_KEYS.contextSelectedSkills,
        jsonPresent: json.context?.selectedSkills !== undefined,
        value: String(redacted.context.selectedSkills.length),
      }),
    ],
  });

  if (redacted.memory !== undefined) {
    sections.push({
      heading: "memory",
      fields: [
        toField(env, {
          label: "path",
          envKey: ENV_KEYS.memoryPath,
          jsonPresent: json.memory?.path !== undefined,
          value: redacted.memory.path,
        }),
        toField(env, {
          label: "maxBytes",
          envKey: ENV_KEYS.memoryMaxBytes,
          jsonPresent: json.memory?.maxBytes !== undefined,
          value: String(redacted.memory.maxBytes),
        }),
        toField(env, {
          label: "writeMode",
          envKey: ENV_KEYS.memoryWriteMode,
          jsonPresent: json.memory?.writeMode !== undefined,
          value: redacted.memory.writeMode,
        }),
      ],
    });
  } else {
    sections.push({
      heading: "memory",
      fields: [
        {
          label: "status",
          value: "not configured",
          source: "default",
        },
      ],
    });
  }

  sections.push({
    heading: "tools",
    fields: [
      toField(env, {
        label: "allowedTools",
        envKey: ENV_KEYS.toolsAllowed,
        jsonPresent: json.tools?.allowedTools !== undefined,
        value: String(redacted.tools.allowedTools.length),
      }),
      toField(env, {
        label: "disallowedTools",
        envKey: ENV_KEYS.toolsDisallowed,
        jsonPresent: json.tools?.disallowedTools !== undefined,
        value: String(redacted.tools.disallowedTools.length),
      }),
      toField(env, {
        label: "mcpConfigPath",
        envKey: ENV_KEYS.toolsMcpConfigPath,
        jsonPresent: json.tools?.mcpConfigPath !== undefined,
        value: redacted.tools.mcpConfigPath ?? "—",
      }),
    ],
  });

  sections.push({
    heading: "artifacts",
    fields: [
      toField(env, {
        label: "dir",
        envKey: ENV_KEYS.artifactsDir,
        jsonPresent: json.artifacts?.dir !== undefined,
        value: redacted.artifacts.dir,
      }),
    ],
  });

  return sections;
}

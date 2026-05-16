import { defineFieldGroup } from "@worklab-ai/settings";
import type { FieldGroupRegistry } from "@worklab-ai/settings";

export const identityFieldGroup = defineFieldGroup({
  id: "identity",
  label: "Identity",
  description: "Who the agent is and which skills it draws from.",
  fields: [
    {
      id: "context.identityPath",
      label: "Identity document",
      description: "Markdown file describing the agent's persona, role, and discipline.",
      kind: "path",
      required: true,
      placeholder: "./IDENTITY.md",
      path: ["context", "identityPath"],
    },
    {
      id: "context.soulPath",
      label: "Soul document",
      description: "Optional secondary character/voice document layered after identity.",
      kind: "path",
      placeholder: "./SOUL.md",
      path: ["context", "soulPath"],
    },
    {
      id: "context.skillsRoot",
      label: "Skills root",
      description: "Directory that contains the skills available to the agent.",
      kind: "path",
      placeholder: "./skills",
      path: ["context", "skillsRoot"],
    },
    {
      id: "context.selectedSkills",
      label: "Selected skills",
      description: "Comma-separated list of skill names the agent may use.",
      kind: "csv",
      placeholder: "research, review",
      path: ["context", "selectedSkills"],
    },
  ],
});

export const runtimeFieldGroup = defineFieldGroup({
  id: "runtime",
  label: "Runtime",
  description: "Which model to talk to and how aggressively to run it.",
  fields: [
    {
      id: "runtime.model",
      label: "Model",
      description:
        "Runtime model reference, e.g. codex:gpt-5.5, pi:openai-codex:gpt-5.5, claude:claude-sonnet-4-6.",
      kind: "string",
      required: true,
      placeholder: "pi:openai-codex:gpt-5.5",
      path: ["runtime", "model"],
    },
    {
      id: "runtime.executionMode",
      label: "Execution mode",
      description: "sdk talks to the provider over its SDK; cli shells out to a packaged binary.",
      kind: "select",
      options: [
        { value: "sdk", label: "SDK" },
        { value: "cli", label: "CLI" },
      ],
      path: ["runtime", "executionMode"],
    },
    {
      id: "runtime.effort",
      label: "Effort",
      description: "Reasoning effort hint (none, low, medium, high, xhigh, max).",
      kind: "select",
      options: [
        { value: "none", label: "none" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
        { value: "max", label: "max" },
      ],
      path: ["runtime", "effort"],
    },
    {
      id: "runtime.maxTurns",
      label: "Max turns",
      description: "Upper bound on conversation turns per run (1-100).",
      kind: "integer",
      min: 1,
      max: 100,
      placeholder: "8",
      path: ["runtime", "maxTurns"],
    },
    {
      id: "runtime.workspace",
      label: "Workspace",
      description: "Working directory the agent operates from.",
      kind: "path",
      placeholder: ".",
      path: ["runtime", "workspace"],
    },
  ],
});

export const memoryFieldGroup = defineFieldGroup({
  id: "memory",
  label: "Memory",
  description: "Where the agent's persistent notes live (optional).",
  fields: [
    {
      id: "memory.path",
      label: "Memory file",
      description: "Markdown file the memory layer reads and writes. Leave empty to disable memory.",
      kind: "path",
      placeholder: "./MEMORY.md",
      path: ["memory", "path"],
    },
    {
      id: "memory.maxBytes",
      label: "Max bytes",
      description: "Hard cap on the memory file size in bytes (1-1,000,000).",
      kind: "integer",
      min: 1,
      max: 1_000_000,
      placeholder: "64000",
      path: ["memory", "maxBytes"],
    },
    {
      id: "memory.scope",
      label: "Scope",
      description: "Whether memory is one shared file or one per conversation.",
      kind: "select",
      options: [
        { value: "single-file", label: "single-file" },
        { value: "per-conversation", label: "per-conversation" },
      ],
      path: ["memory", "scope"],
    },
    {
      id: "memory.writeMode",
      label: "Write mode",
      description:
        "disabled = never write; append-host-summary = let the host append after each run.",
      kind: "select",
      options: [
        { value: "disabled", label: "disabled" },
        { value: "append-host-summary", label: "append-host-summary" },
      ],
      path: ["memory", "writeMode"],
    },
  ],
});

export const toolsFieldGroup = defineFieldGroup({
  id: "tools",
  label: "Tools",
  description: "Which built-in tools the agent may or may not use, and where MCP servers live.",
  fields: [
    {
      id: "tools.allowedTools",
      label: "Allowed tools",
      description: "Comma-separated allowlist. Empty means default policy applies.",
      kind: "csv",
      placeholder: "Read, Grep, Bash",
      path: ["tools", "allowedTools"],
    },
    {
      id: "tools.disallowedTools",
      label: "Disallowed tools",
      description: "Comma-separated denylist. Wins over the allowlist for overlapping entries.",
      kind: "csv",
      placeholder: "WebFetch",
      path: ["tools", "disallowedTools"],
    },
    {
      id: "tools.mcpConfigPath",
      label: "MCP config",
      description: "JSON file declaring MCP servers and their transport.",
      kind: "path",
      placeholder: "./mcp.json",
      path: ["tools", "mcpConfigPath"],
    },
  ],
});

export const artifactsFieldGroup = defineFieldGroup({
  id: "artifacts",
  label: "Artifacts",
  description: "Where run event JSONL files and summaries are written.",
  fields: [
    {
      id: "artifacts.dir",
      label: "Artifact directory",
      description: "Directory for observability events and run summaries.",
      kind: "path",
      placeholder: "./.mono-agent/artifacts",
      path: ["artifacts", "dir"],
    },
  ],
});

export const traceabilityFieldGroup = defineFieldGroup({
  id: "traceability",
  label: "Traceability",
  description: "How this host registers run artifacts with the local dashboard.",
  fields: [
    {
      id: "traceability.registryDir",
      label: "Trace registry",
      description: "Host-shared directory where running agents publish source manifests.",
      kind: "path",
      placeholder: "~/.mono-agent/trace-sources",
      path: ["traceability", "registryDir"],
    },
    {
      id: "traceability.sourceId",
      label: "Source ID",
      description: "Stable path-safe id for this agent process in the trace registry.",
      kind: "string",
      placeholder: "final-agent",
      path: ["traceability", "sourceId"],
    },
    {
      id: "traceability.sourceLabel",
      label: "Source label",
      description: "Human-readable name shown in the traceability dashboard.",
      kind: "string",
      placeholder: "Final Agent Demo",
      path: ["traceability", "sourceLabel"],
    },
    {
      id: "traceability.heartbeatMs",
      label: "Heartbeat ms",
      description: "How often this host refreshes its registry manifest.",
      kind: "integer",
      min: 250,
      max: 86_400_000,
      placeholder: "10000",
      path: ["traceability", "heartbeatMs"],
    },
    {
      id: "traceability.staleAfterMs",
      label: "Stale after ms",
      description: "How old a running heartbeat can be before the dashboard marks it stale.",
      kind: "integer",
      min: 1_000,
      max: 604_800_000,
      placeholder: "30000",
      path: ["traceability", "staleAfterMs"],
    },
  ],
});

export const CORE_AGENT_FIELD_GROUPS: FieldGroupRegistry = [
  identityFieldGroup,
  runtimeFieldGroup,
  memoryFieldGroup,
  toolsFieldGroup,
  artifactsFieldGroup,
  traceabilityFieldGroup,
];

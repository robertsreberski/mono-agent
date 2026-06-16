import { defineFieldGroup } from "@mono-agent/settings";
import type { FieldGroupRegistry } from "@mono-agent/settings";

/**
 * Closed set of reasoning-effort hints, shared by the runtime field group's
 * select options and the loader's `MONO_AGENT_EFFORT` validation so the two
 * surfaces never drift.
 */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Closed set of runtime permission modes, shared by the runtime field group's
 * select options and the loader's `MONO_AGENT_PERMISSION_MODE` validation.
 */
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;

/**
 * Closed set of reasoning-summary verbosity hints, shared by the runtime field
 * group's select options and the loader's `MONO_AGENT_REASONING_SUMMARY`
 * validation.
 */
export const REASONING_SUMMARIES = ["auto", "concise", "detailed", "off", "on"] as const;

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
    {
      id: "context.skillMaxBytes",
      label: "Skill byte cap",
      description: "Hard cap per selected skill body in bytes (256-1,000,000; default 48,000).",
      kind: "integer",
      min: 256,
      max: 1_000_000,
      placeholder: "48000",
      path: ["context", "skillMaxBytes"],
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
      id: "runtime.fallbackModels",
      label: "Fallback models",
      description:
        "Comma-separated backup model references tried in order when the primary model fails with a retryable provider error.",
      kind: "csv",
      placeholder: "claude:claude-sonnet-4-6, pi:ollama:gemma4:31b",
      path: ["runtime", "fallbackModels"],
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
      options: EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
      path: ["runtime", "effort"],
    },
    {
      id: "runtime.permissionMode",
      label: "Permission mode",
      description: "Tool-permission posture forwarded to the runtime; consumed by CLI execution modes.",
      kind: "select",
      options: PERMISSION_MODES.map((mode) => ({ value: mode, label: mode })),
      path: ["runtime", "permissionMode"],
    },
    {
      id: "runtime.reasoningSummary",
      label: "Reasoning summary",
      description: "How verbosely the runtime surfaces provider reasoning summaries.",
      kind: "select",
      options: REASONING_SUMMARIES.map((summary) => ({ value: summary, label: summary })),
      path: ["runtime", "reasoningSummary"],
    },
    {
      id: "runtime.maxTurns",
      label: "Max turns",
      description: "Optional upper bound on conversation turns per run; blank or 0 means unlimited.",
      kind: "integer",
      min: 0,
      max: 100,
      placeholder: "0",
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
    {
      id: "runtime.session.mode",
      label: "Session mode",
      description: "continuous keeps one runtime session alive across messages; per-message starts fresh each run.",
      kind: "select",
      options: [
        { value: "continuous", label: "continuous" },
        { value: "per-message", label: "per-message" },
      ],
      path: ["runtime", "session", "mode"],
    },
    {
      id: "runtime.session.idleTimeoutMs",
      label: "Session idle timeout ms",
      description: "How long a continuous session may sit idle before it is disposed (1,000-86,400,000).",
      kind: "integer",
      min: 1_000,
      max: 86_400_000,
      placeholder: "1800000",
      path: ["runtime", "session", "idleTimeoutMs"],
    },
  ],
});

export const memoryFieldGroup = defineFieldGroup({
  id: "memory",
  label: "Memory",
  description: "Where the agent's persistent notes live (optional).",
  fields: [
    {
      id: "memory.mode",
      label: "Mode",
      description:
        "lite = FTS keyword recall only, no external dependencies. journal = hybrid vector+keyword recall with decay, needs Ollama embeddings. bujo = full BuJo store with LLM capture/reconcile/reflect/migrate + auto-scheduled rituals, needs embeddings and a local LLM.",
      kind: "select",
      options: [
        { value: "lite", label: "lite" },
        { value: "journal", label: "journal" },
        { value: "bujo", label: "bujo" },
      ],
      path: ["memory", "mode"],
    },
    {
      id: "memory.path",
      label: "Memory path",
      description:
        "Memory root directory. lite/journal/bujo modes: the directory holding memory.db and daily/ rapid-log files. Leave empty to disable memory.",
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
    {
      id: "memory.embeddings.provider",
      label: "Embeddings provider",
      description: "Embedding provider for semantic memory_search; leave unset for keyword-only search.",
      kind: "select",
      options: [
        { value: "ollama", label: "ollama" },
        { value: "openai", label: "openai" },
      ],
      path: ["memory", "embeddings", "provider"],
    },
    {
      id: "memory.embeddings.model",
      label: "Embeddings model",
      description: "Embedding model (default nomic-embed-text for Ollama, text-embedding-3-small for OpenAI).",
      kind: "string",
      placeholder: "nomic-embed-text",
      path: ["memory", "embeddings", "model"],
    },
    {
      id: "memory.embeddings.endpoint",
      label: "Embeddings endpoint",
      description: "Provider endpoint (default http://localhost:11434 for Ollama, https://api.openai.com/v1 for OpenAI).",
      kind: "string",
      placeholder: "http://localhost:11434",
      path: ["memory", "embeddings", "endpoint"],
    },
    {
      id: "memory.embeddings.apiKey",
      label: "Embeddings API key",
      description: "API key for remote embedding providers (required for OpenAI).",
      kind: "secret",
      path: ["memory", "embeddings", "apiKey"],
    },
    {
      id: "memory.embeddings.dim",
      label: "Embeddings dimension",
      description: "Vector dimension of the embedding model (bujo mode; default 768 for nomic-embed-text).",
      kind: "integer",
      min: 1,
      max: 16_384,
      placeholder: "768",
      path: ["memory", "embeddings", "dim"],
    },
    {
      id: "memory.llm.provider",
      label: "LLM provider",
      description: "Local LLM provider for bujo capture/reflect/migrate (ollama only).",
      kind: "select",
      options: [{ value: "ollama", label: "ollama" }],
      path: ["memory", "llm", "provider"],
    },
    {
      id: "memory.llm.model",
      label: "LLM model",
      description: "Ollama chat model for bujo intelligence (e.g. qwen3:8b, qwen3.6:latest).",
      kind: "string",
      placeholder: "qwen3:8b",
      path: ["memory", "llm", "model"],
    },
    {
      id: "memory.llm.endpoint",
      label: "LLM endpoint",
      description: "Ollama endpoint for the chat LLM (default http://localhost:11434).",
      kind: "string",
      placeholder: "http://localhost:11434",
      path: ["memory", "llm", "endpoint"],
    },
    {
      id: "memory.reflection.enabled",
      label: "Reflection enabled",
      description: "Enable the nightly bujo-tier reflection ritual (summarise and compress older memories).",
      kind: "switch",
      path: ["memory", "reflection", "enabled"],
    },
    {
      id: "memory.reflection.cron",
      label: "Reflection cron",
      description: "Cron expression for the nightly reflection ritual (default `0 3 * * *` — 03:00 daily).",
      kind: "string",
      placeholder: "0 3 * * *",
      path: ["memory", "reflection", "cron"],
    },
    {
      id: "memory.migration.enabled",
      label: "Migration enabled",
      description: "Enable the monthly bujo-tier migration ritual (archive and rebalance memory).",
      kind: "switch",
      path: ["memory", "migration", "enabled"],
    },
    {
      id: "memory.migration.cron",
      label: "Migration cron",
      description: "Cron expression for the monthly migration ritual (default `0 4 1 * *` — 04:00 on the 1st).",
      kind: "string",
      placeholder: "0 4 1 * *",
      path: ["memory", "migration", "cron"],
    },
  ],
});

export const sandboxFieldGroup = defineFieldGroup({
  id: "sandbox",
  label: "Sandbox",
  description: "How runtime commands are isolated (optional; omit for no sandboxing).",
  fields: [
    {
      id: "sandbox.mode",
      label: "Mode",
      description: "native wraps runtime commands with the srt sandbox; off disables sandboxing.",
      kind: "select",
      options: [
        { value: "native", label: "native" },
        { value: "off", label: "off" },
      ],
      path: ["sandbox", "mode"],
    },
    {
      id: "sandbox.network.mode",
      label: "Network",
      description: "none blocks all network; localhost allows loopback; allowlist allows listed domains; all is unrestricted.",
      kind: "select",
      options: [
        { value: "none", label: "none" },
        { value: "localhost", label: "localhost" },
        { value: "allowlist", label: "allowlist" },
        { value: "all", label: "all" },
      ],
      path: ["sandbox", "network", "mode"],
    },
    {
      id: "sandbox.network.allowlist",
      label: "Network allowlist",
      description: "Domains allowed in allowlist mode (*.suffix wildcards supported).",
      kind: "csv",
      placeholder: "github.com, *.githubusercontent.com",
      path: ["sandbox", "network", "allowlist"],
    },
    {
      id: "sandbox.readableRoots",
      label: "Readable roots",
      description: "Directories the runtime may read; relative entries resolve against the workspace (default: workspace only).",
      kind: "csv",
      placeholder: ".",
      path: ["sandbox", "readableRoots"],
    },
    {
      id: "sandbox.writableRoots",
      label: "Writable roots",
      description: "Directories the runtime may write; relative entries resolve against the workspace (default: workspace only).",
      kind: "csv",
      placeholder: ".",
      path: ["sandbox", "writableRoots"],
    },
    {
      id: "sandbox.denyWrite",
      label: "Deny-write patterns",
      description: "Glob patterns never writable (default: .env, .env.*, .git/config, .git/hooks/**).",
      kind: "csv",
      placeholder: ".env, secrets/**",
      path: ["sandbox", "denyWrite"],
    },
    {
      id: "sandbox.fallback",
      label: "Fallback",
      description: "What happens when the sandbox engine is unavailable: fail-closed refuses to run commands.",
      kind: "select",
      options: [
        { value: "fail-closed", label: "fail-closed" },
        { value: "unsafe-host-process", label: "unsafe-host-process" },
      ],
      path: ["sandbox", "fallback"],
    },
    {
      id: "sandbox.unsafeAllowHostProcess",
      label: "Allow host process",
      description: "Explicit opt-in required for the unsafe-host-process fallback.",
      kind: "switch",
      path: ["sandbox", "unsafeAllowHostProcess"],
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

export const providersFieldGroup = defineFieldGroup({
  id: "providers",
  label: "Providers",
  description: "Provider-specific credential and registry settings.",
  fields: [
    {
      id: "providers.piAuthPath",
      label: "Pi auth path",
      description: "OAuth credential JSON used by Pi providers such as openai-codex.",
      kind: "path",
      placeholder: "~/.pi/agent/auth.json",
      path: ["providers", "piAuthPath"],
    },
  ],
});

export const CORE_AGENT_FIELD_GROUPS: FieldGroupRegistry = [
  identityFieldGroup,
  runtimeFieldGroup,
  memoryFieldGroup,
  toolsFieldGroup,
  sandboxFieldGroup,
  providersFieldGroup,
  artifactsFieldGroup,
  traceabilityFieldGroup,
];

import type { MonoAgentConfigJson } from "@mono-agent/config";
import { validateCronExpression } from "@mono-agent/cron-adapter";

import { DEFAULT_PI_MEMORY_MODEL, memoryBlock } from "./base.js";
import type { CapabilityModule, ModuleKind } from "./types.js";

/** Split a comma-separated input value into trimmed, non-empty entries. */
function splitCsv(v?: string): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The A2A provider plugin block (Agent Card + provider endpoint). Copied verbatim
 * from `src/recipes/catalog.ts` so the composed fragment stays parity-checked.
 */
function a2aProviderPluginSection(): Partial<MonoAgentConfigJson> & Record<string, unknown> {
  return {
    channels: {
      plugins: [
        {
          package: "@mono-agent/a2a-adapter",
          config: {
            enabled: true,
            agent: {
              name: "Mono Agent",
              description: "A mono-agent provider exposed over A2A.",
              version: "0.1.0",
            },
            skill: {
              id: "default",
              name: "Default agent skill",
              description: "Send a task to this mono-agent and receive its response.",
              tags: ["agent"],
            },
          },
        },
      ],
    },
  } as Partial<MonoAgentConfigJson> & Record<string, unknown>;
}

const SANDBOX_FAIL_CLOSED_ENGINE_NOTE =
  "Install `srt` and keep it on PATH; without it, fail-closed sandboxed commands stop with `sandbox_unavailable` instead of running unsandboxed.";

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const channelWebhook: CapabilityModule = {
  id: "channel:webhook",
  kind: "channel",
  title: "Webhook",
  summary: "HTTP loopback endpoint — the zero-credential smoke channel.",
  riskLevel: "low",
  inputs: [],
  configFragment: () => ({ webhook: { enabled: true } }),
  validateExpectations: [{ sectionId: "channel:webhook", mustBe: "ok" }],
};

const channelTelegram: CapabilityModule = {
  id: "channel:telegram",
  kind: "channel",
  title: "Telegram",
  summary: "Chat with your agent via a Telegram bot.",
  riskLevel: "medium",
  inputs: [
    {
      id: "allowedChatIds",
      label: "Allowed chat IDs",
      description: "Comma-separated Telegram chat IDs the bot may answer (leave blank to set later).",
    },
    {
      id: "telegramToken",
      label: "Telegram bot token",
      description: "BotFather token. Saved to .env; .env.example contains only a placeholder. Never written into JSON.",
      secret: true,
      envVar: "MONO_AGENT_TELEGRAM_BOT_TOKEN",
      required: true,
    },
  ],
  configFragment: (values) => {
    const chatIds = splitCsv(values.allowedChatIds);
    return {
      telegram: {
        enabled: true,
        ...(chatIds.length > 0 ? { allowedChatIds: chatIds } : {}),
      },
    };
  },
  envExampleLines: () => ["# Telegram bot token from @BotFather", "MONO_AGENT_TELEGRAM_BOT_TOKEN="],
  recommendedTools: ["TelegramSendMessage", "TelegramAskButtons"],
  validateExpectations: [
    { sectionId: "channel:telegram", mustBe: "ok", note: "Set MONO_AGENT_TELEGRAM_BOT_TOKEN in .env." },
  ],
};

const channelSlack: CapabilityModule = {
  id: "channel:slack",
  kind: "channel",
  title: "Slack",
  summary: "Socket-Mode Slack bot scoped to a channel allowlist.",
  riskLevel: "medium",
  inputs: [
    {
      id: "allowedChannelIds",
      label: "Allowed channel IDs",
      description: "Comma-separated Slack channel/DM IDs the bot may respond to.",
    },
    {
      id: "botToken",
      label: "Slack bot token",
      description: "xoxb-… token. Saved to .env; .env.example contains only a placeholder.",
      secret: true,
      envVar: "MONO_AGENT_SLACK_BOT_TOKEN",
      required: true,
    },
    {
      id: "appToken",
      label: "Slack app token",
      description: "xapp-… connections:write token for Socket Mode. Saved to .env only.",
      secret: true,
      envVar: "MONO_AGENT_SLACK_APP_TOKEN",
      required: true,
    },
  ],
  configFragment: (values) => {
    const channelIds = splitCsv(values.allowedChannelIds);
    return {
      slack: {
        enabled: true,
        ...(channelIds.length > 0 ? { allowedChannelIds: channelIds } : {}),
      },
    };
  },
  envExampleLines: () => [
    "# Slack Socket Mode tokens",
    "MONO_AGENT_SLACK_BOT_TOKEN=",
    "MONO_AGENT_SLACK_APP_TOKEN=",
  ],
  recommendedTools: ["SlackSendMessage"],
  validateExpectations: [
    {
      sectionId: "channel:slack",
      mustBe: "ok",
      note: "Set MONO_AGENT_SLACK_BOT_TOKEN and MONO_AGENT_SLACK_APP_TOKEN in .env.",
    },
  ],
};

const channelOpenaiApi: CapabilityModule = {
  id: "channel:openai-api",
  kind: "channel",
  title: "OpenAI-compatible API",
  summary: "Expose the runtime as an OpenAI-compatible loopback endpoint.",
  riskLevel: "medium",
  inputs: [
    {
      id: "apiKey",
      label: "Client bearer key",
      description: "Optional bearer clients must present (sk-…). Saved to .env; .env.example contains only a placeholder.",
      secret: true,
      envVar: "MONO_AGENT_OPENAI_API_KEY",
      required: false,
    },
  ],
  configFragment: () => ({ openaiApi: { enabled: true } }),
  envExampleLines: () => ["# Optional bearer required from OpenAI-API clients", "MONO_AGENT_OPENAI_API_KEY="],
  validateExpectations: [{ sectionId: "channel:openai-api", mustBe: "ok" }],
};

const channelCron: CapabilityModule = {
  id: "channel:cron",
  kind: "channel",
  title: "Scheduled jobs (cron)",
  summary: "Run the agent on a schedule; scaffolds cron/digest.md.",
  riskLevel: "low",
  inputs: [
    {
      id: "cronExpression",
      label: "Cron expression",
      description: "Five-field UTC schedule for the digest (default 08:00 UTC daily).",
      default: "0 8 * * *",
      validate: (value) => {
        const result = validateCronExpression(value);
        if (result.ok) return undefined;
        if (result.code === "required") {
          return "Enter a cron expression using five fields: minute hour day-of-month month day-of-week.";
        }
        if (result.code === "field_count") {
          return "Use exactly five fields: minute hour day-of-month month day-of-week (for example, 0 8 * * *).";
        }
        return `Invalid cron expression: ${result.reason}`;
      },
    },
  ],
  // Directory-backed jobs are active by being present and enabled in cron/*.md.
  // Setting cron.enabled would select the legacy single-job form, which also
  // requires inline expression/prompt fields and prevents folder jobs loading.
  configFragment: () => ({ cron: { dir: "cron" } }),
  files: (values) => [
    {
      path: "cron/digest.md",
      contents: [
        "---",
        `expression: "${values.cronExpression ?? "0 8 * * *"}"`,
        "conversationId: cron-digest",
        "notify: true",
        "---",
        "",
        "Produce a concise digest of anything noteworthy since the last run.",
        "Your final reply is delivered to the user verbatim as the notification — write it as the finished message, with no preface. If nothing is noteworthy, reply with exactly NOTHING_TO_REPORT.",
        "",
      ].join("\n"),
    },
  ],
  validateExpectations: [
    { sectionId: "channel:cron", mustBe: "ok", note: "Use at least one valid enabled cron/*.md job." },
  ],
};

const channelA2a: CapabilityModule = {
  id: "channel:a2a",
  kind: "channel",
  title: "A2A provider",
  summary: "Expose the agent over A2A (Agent Card + provider endpoint).",
  riskLevel: "medium",
  wizardSelectable: false,
  inputs: [
    {
      id: "bearerToken",
      label: "A2A bearer token",
      description: "Bearer required from A2A consumers when requireBearer is set. Saved to .env; never written into JSON.",
      secret: true,
      envVar: "MONO_AGENT_A2A_BEARER_TOKEN",
      required: false,
    },
  ],
  configFragment: () => a2aProviderPluginSection(),
  envExampleLines: () => [
    "# Bearer token A2A consumers must present (when requireBearer is set)",
    "MONO_AGENT_A2A_BEARER_TOKEN=",
  ],
  validateExpectations: [{ sectionId: "channel:a2a", mustBe: "ok" }],
};

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const memoryLite: CapabilityModule = {
  id: "memory:lite",
  kind: "memory",
  title: "Lite (full-text search)",
  summary: "SQLite full-text recall, zero external dependencies.",
  riskLevel: "low",
  inputs: [],
  configFragment: () => ({ memory: memoryBlock("lite") }),
  validateExpectations: [{ sectionId: "memory", mustBe: "ok" }],
};

const memoryJournal: CapabilityModule = {
  id: "memory:journal",
  kind: "memory",
  title: "Journal (semantic recall)",
  summary: "Semantic recall via local ollama embeddings.",
  riskLevel: "low",
  inputs: [],
  configFragment: () => ({
    memory: {
      ...memoryBlock("journal"),
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      recallTool: { enabled: true },
    },
  }),
  validateExpectations: [
    {
      sectionId: "memory",
      mustBe: "ok",
      note: "Start ollama (or configure embeddings) so memory leaves `waiting`.",
    },
  ],
};

const memoryBujo: CapabilityModule = {
  id: "memory:bujo",
  kind: "memory",
  title: "BuJo (capture + recall)",
  summary: "Daily-log capture plus semantic recall (needs ollama).",
  riskLevel: "medium",
  inputs: [],
  configFragment: (values) => ({
    memory: {
      ...memoryBlock("bujo"),
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      // Direct Codex is CLI-only, while the memory LLM has an SDK-only safety
      // contract. Route every direct Codex primary through the equivalent Pi
      // Terra model for this internal call, not only the default candidate.
      llm: {
        provider: "agent-host",
        model: values.model?.startsWith("codex:") ? DEFAULT_PI_MEMORY_MODEL : values.model ?? DEFAULT_PI_MEMORY_MODEL,
      },
      recallTool: { enabled: true },
    },
  }),
  validateExpectations: [
    {
      sectionId: "memory",
      mustBe: "ok",
      note: "Start ollama (or configure embeddings) so memory leaves `waiting`.",
    },
  ],
};

const memorySupermemory: CapabilityModule = {
  id: "memory:supermemory",
  kind: "memory",
  title: "Supermemory (external server)",
  summary: "External Supermemory instance for server-side extraction + recall.",
  riskLevel: "medium",
  // The package is optional and no longer part of agent-app's dependency
  // closure. Existing presets/config composition can still resolve the module
  // explicitly, but the core interactive wizard must not advertise an
  // unavailable backend as though it were built in.
  wizardSelectable: false,
  inputs: [
    {
      id: "supermemoryBaseUrl",
      label: "Supermemory base URL",
      description: "REST URL of your supermemory-server (local default http://127.0.0.1:6767) or the hosted cloud.",
      default: "http://127.0.0.1:6767",
    },
    {
      id: "supermemoryApiKey",
      label: "Supermemory API key",
      description: "Bearer key printed by supermemory-server on first boot. Saved to .env; .env.example contains only a placeholder.",
      secret: true,
      envVar: "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY",
      required: false,
    },
  ],
  configFragment: (values) => ({
    memory: {
      backend: "supermemory",
      writeMode: "capture",
      supermemory: { baseUrl: values.supermemoryBaseUrl ?? "http://127.0.0.1:6767" },
      recallTool: { enabled: true },
    },
  }),
  envExampleLines: () => [
    "# Supermemory bearer key (printed by supermemory-server on first boot)",
    "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY=",
  ],
  validateExpectations: [
    {
      sectionId: "memory",
      mustBe: "ok",
      note: "Run `supermemory-server` (or point baseUrl at your instance) before sending turns.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const sandbox: CapabilityModule = {
  id: "sandbox",
  kind: "sandbox",
  title: "Sandbox (native srt)",
  summary: "Native srt sandbox: workspace-only FS, localhost network, fails closed.",
  riskLevel: "medium",
  inputs: [],
  configFragment: () => ({
    sandbox: {
      mode: "native",
      network: { mode: "localhost" },
      readableRoots: ["."],
      writableRoots: ["."],
      fallback: "fail-closed",
    },
  }),
  recommendedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  validateExpectations: [{ sectionId: "sandbox", mustBe: "ok", note: SANDBOX_FAIL_CLOSED_ENGINE_NOTE }],
};

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

const observabilityPhoenix: CapabilityModule = {
  id: "observability:phoenix",
  kind: "observability",
  title: "Phoenix tracing",
  summary: "Best-effort Phoenix OTLP export, sensitive data excluded.",
  riskLevel: "low",
  inputs: [],
  configFragment: () => ({
    observability: { exporters: [{ type: "phoenix", includeSensitiveData: false }] },
  }),
  validateExpectations: [
    { sectionId: "observability", mustBe: "ok", note: "Start Phoenix (or it reports `waiting`)." },
  ],
};

// ---------------------------------------------------------------------------
// Providers (internal — never shown in the wizard, auto-added for pi:<provider> models)
// ---------------------------------------------------------------------------

const providerOllama: CapabilityModule = {
  id: "provider:ollama",
  kind: "provider",
  title: "Ollama local provider",
  summary: "Local Ollama provider block (auto-added for pi:ollama models).",
  riskLevel: "low",
  inputs: [],
  configFragment: () => ({
    providers: { local: [{ id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true }] },
  }),
  validateExpectations: [
    { sectionId: "runtime", mustBe: "ok", note: "Start ollama and pull the configured model." },
  ],
};

const providerLmStudio: CapabilityModule = {
  id: "provider:lmstudio",
  kind: "provider",
  title: "LM Studio local provider",
  summary: "Local LM Studio provider block (auto-added for pi:lmstudio models).",
  riskLevel: "low",
  inputs: [],
  configFragment: () => ({
    providers: { local: [{ id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true }] },
  }),
  validateExpectations: [
    {
      sectionId: "runtime",
      mustBe: "ok",
      note: "Start LM Studio's local server and load the configured model.",
    },
  ],
};

/**
 * Ordered catalog: the six channels, four memory tiers, sandbox, observability,
 * then the two internal provider modules. Wizard-visible modules (all but the two
 * `provider:*`) come first; the composer presents them in this order.
 */
export const CAPABILITY_MODULES: readonly CapabilityModule[] = [
  channelWebhook,
  channelTelegram,
  channelSlack,
  channelOpenaiApi,
  channelCron,
  channelA2a,
  memoryLite,
  memoryJournal,
  memoryBujo,
  memorySupermemory,
  sandbox,
  observabilityPhoenix,
  providerOllama,
  providerLmStudio,
];

/** Resolve a module by its id, or `undefined` when no module owns it. */
export function findModule(id: string): CapabilityModule | undefined {
  return CAPABILITY_MODULES.find((module) => module.id === id);
}

/** All modules of a given kind, in catalog order. */
export function modulesByKind(kind: ModuleKind): readonly CapabilityModule[] {
  return CAPABILITY_MODULES.filter((module) => module.kind === kind);
}

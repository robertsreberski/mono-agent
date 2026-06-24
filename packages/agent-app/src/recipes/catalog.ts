import type { MonoAgentConfigJson } from "@mono-agent/config";

import { baseConfig, DEFAULT_MODEL, memoryBlock, MODEL_INPUT } from "./base.js";
import type { AgentRecipe, RecipeInputValues } from "./types.js";

function withSections(
  input: RecipeInputValues,
  extra: Partial<MonoAgentConfigJson> & Record<string, unknown>,
): MonoAgentConfigJson {
  return { ...baseConfig(input), ...extra } as MonoAgentConfigJson;
}

/** `minimal-webhook` — the zero-credential smoke agent (matches default init). */
const minimalWebhook: AgentRecipe = {
  id: "minimal-webhook",
  title: "Minimal webhook agent",
  description: "Lowest-friction smoke agent: webhook loopback enabled, no credentials, no memory.",
  tags: ["webhook", "starter", "no-secrets"],
  riskLevel: "low",
  playbook: "webhook-automation-sync-async.md",
  inputs: [MODEL_INPUT],
  config: (input) => withSections(input, { webhook: { enabled: true } }),
  validateExpectations: [
    { sectionId: "runtime", mustBe: "ok" },
    { sectionId: "channel:webhook", mustBe: "ok" },
  ],
};

/** `personal-telegram-bujo` — Telegram personal assistant with BuJo memory. */
const personalTelegramBujo: AgentRecipe = {
  id: "personal-telegram-bujo",
  title: "Personal Telegram assistant (BuJo memory)",
  description: "Telegram bot with bujo-tier memory (capture + recall), local ollama embeddings, and the runtime model as the memory LLM.",
  tags: ["telegram", "memory", "bujo", "personal"],
  riskLevel: "medium",
  playbook: "telegram-personal-assistant-bujo.md",
  inputs: [
    MODEL_INPUT,
    {
      id: "allowedChatIds",
      label: "Allowed chat IDs",
      description: "Comma-separated Telegram chat IDs the bot may answer (leave blank to set later).",
    },
    {
      id: "telegramToken",
      label: "Telegram bot token",
      description: "BotFather token. Externalized to .env.example; never written into JSON.",
      secret: true,
      envVar: "MONO_AGENT_TELEGRAM_TOKEN",
    },
  ],
  config: (input) => withSections(input, {
    memory: {
      ...memoryBlock("bujo"),
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      llm: { provider: "agent-host", model: input.model ?? DEFAULT_MODEL },
      recallTool: { enabled: true },
    },
    telegram: {
      enabled: true,
      ...(input.allowedChatIds === undefined || input.allowedChatIds.length === 0
        ? {}
        : { allowedChatIds: input.allowedChatIds.split(",").map((id) => id.trim()).filter(Boolean) }),
    },
  }),
  envExample: () => "# Telegram bot token from @BotFather\nMONO_AGENT_TELEGRAM_TOKEN=\n",
  validateExpectations: [
    { sectionId: "memory", mustBe: "ok", note: "Start ollama (or configure embeddings) so memory leaves `waiting`." },
    { sectionId: "channel:telegram", mustBe: "ok", note: "Set MONO_AGENT_TELEGRAM_TOKEN in .env." },
  ],
};

/** `personal-telegram-supermemory` — Telegram assistant backed by a local Supermemory instance. */
const personalTelegramSupermemory: AgentRecipe = {
  id: "personal-telegram-supermemory",
  title: "Personal Telegram assistant (Supermemory)",
  description: "Telegram bot backed by an external Supermemory instance (local OSS binary by default): server-side extraction + recall, no bujo chat LLM needed.",
  tags: ["telegram", "memory", "supermemory", "external", "personal"],
  riskLevel: "medium",
  playbook: "telegram-supermemory-memory.md",
  inputs: [
    MODEL_INPUT,
    {
      id: "supermemoryBaseUrl",
      label: "Supermemory base URL",
      description: "REST URL of your supermemory-server (local default http://127.0.0.1:6767) or the hosted cloud.",
      default: "http://127.0.0.1:6767",
    },
    {
      id: "allowedChatIds",
      label: "Allowed chat IDs",
      description: "Comma-separated Telegram chat IDs the bot may answer (leave blank to set later).",
    },
    {
      id: "telegramToken",
      label: "Telegram bot token",
      description: "BotFather token. Externalized to .env.example; never written into JSON.",
      secret: true,
      envVar: "MONO_AGENT_TELEGRAM_TOKEN",
    },
    {
      id: "supermemoryApiKey",
      label: "Supermemory API key",
      description: "Bearer key printed by supermemory-server on first boot. Externalized to .env.example.",
      secret: true,
      envVar: "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY",
    },
  ],
  config: (input) => withSections(input, {
    memory: {
      backend: "supermemory",
      // No `mode`/`path`: those are bujo-only and the loader defaults them for external backends.
      // `capture` posts full turns for Supermemory's server-side extraction.
      writeMode: "capture",
      supermemory: { baseUrl: input.supermemoryBaseUrl ?? "http://127.0.0.1:6767" },
      recallTool: { enabled: true },
    },
    telegram: {
      enabled: true,
      ...(input.allowedChatIds === undefined || input.allowedChatIds.length === 0
        ? {}
        : { allowedChatIds: input.allowedChatIds.split(",").map((id) => id.trim()).filter(Boolean) }),
    },
  }),
  envExample: () =>
    "# Telegram bot token from @BotFather\nMONO_AGENT_TELEGRAM_TOKEN=\n# Supermemory bearer key (printed by supermemory-server on first boot)\nMONO_AGENT_MEMORY_SUPERMEMORY_API_KEY=\n",
  validateExpectations: [
    { sectionId: "memory", mustBe: "ok", note: "Run `supermemory-server` (or point baseUrl at your instance) before sending turns." },
    { sectionId: "channel:telegram", mustBe: "ok", note: "Set MONO_AGENT_TELEGRAM_TOKEN in .env." },
  ],
};

/** `slack-team-bot` — Slack Socket Mode with an allowlist and the send tool. */
const slackTeamBot: AgentRecipe = {
  id: "slack-team-bot",
  title: "Slack team bot",
  description: "Slack Socket Mode bot scoped to an allowlist of channels, with the slack_send_message tool enabled.",
  tags: ["slack", "team", "tools"],
  riskLevel: "medium",
  playbook: "slack-team-bot-mcp-tools.md",
  inputs: [
    MODEL_INPUT,
    {
      id: "allowedChannelIds",
      label: "Allowed channel IDs",
      description: "Comma-separated Slack channel/DM IDs the bot may respond to.",
    },
    {
      id: "botToken",
      label: "Slack bot token",
      description: "xoxb-… token. Externalized to .env.example.",
      secret: true,
      envVar: "MONO_AGENT_SLACK_BOT_TOKEN",
    },
    {
      id: "appToken",
      label: "Slack app token",
      description: "xapp-… connections:write token for Socket Mode.",
      secret: true,
      envVar: "MONO_AGENT_SLACK_APP_TOKEN",
    },
  ],
  config: (input) => withSections(input, {
    tools: { allowedTools: ["slack_send_message"], disallowedTools: [] },
    slack: {
      enabled: true,
      ...(input.allowedChannelIds === undefined || input.allowedChannelIds.length === 0
        ? {}
        : { allowedChannelIds: input.allowedChannelIds.split(",").map((id) => id.trim()).filter(Boolean) }),
    },
  }),
  envExample: () => "# Slack Socket Mode tokens\nMONO_AGENT_SLACK_BOT_TOKEN=\nMONO_AGENT_SLACK_APP_TOKEN=\n",
  validateExpectations: [
    { sectionId: "channel:slack", mustBe: "ok", note: "Set MONO_AGENT_SLACK_BOT_TOKEN and MONO_AGENT_SLACK_APP_TOKEN in .env." },
  ],
};

/** `openai-api-gateway` — expose the agent as an OpenAI-compatible endpoint. */
const openaiApiGateway: AgentRecipe = {
  id: "openai-api-gateway",
  title: "OpenAI-compatible API gateway",
  description: "Expose the configured runtime as an OpenAI-compatible loopback endpoint (e.g. for OpenWebUI).",
  tags: ["openai-api", "gateway", "loopback"],
  riskLevel: "medium",
  playbook: "openai-endpoint-open-webui.md",
  inputs: [
    MODEL_INPUT,
    {
      id: "apiKey",
      label: "Client bearer key",
      description: "Optional bearer clients must present (sk-…). Externalized to .env.example.",
      secret: true,
      envVar: "MONO_AGENT_OPENAI_API_KEY",
    },
  ],
  config: (input) => withSections(input, {
    openaiApi: { enabled: true },
  }),
  envExample: () => "# Optional bearer required from OpenAI-API clients\nMONO_AGENT_OPENAI_API_KEY=\n",
  validateExpectations: [
    { sectionId: "channel:openai-api", mustBe: "ok" },
  ],
};

/** `cron-digest` — a scheduled digest job that notifies a channel. */
const cronDigest: AgentRecipe = {
  id: "cron-digest",
  title: "Cron digest agent",
  description: "A scheduled cron job (authored as cron/digest.md) that can use native notification when a Telegram or Slack destination is configured.",
  tags: ["cron", "proactive", "digest"],
  riskLevel: "low",
  playbook: "cron-digest-proactive-notify.md",
  inputs: [
    MODEL_INPUT,
    {
      id: "cronExpression",
      label: "Cron expression",
      description: "When the digest runs (default 08:00 daily).",
      default: "0 8 * * *",
    },
  ],
  config: (input) => withSections(input, {
    cron: { enabled: true },
  }),
  files: (input) => [
    {
      path: "cron/digest.md",
      contents: [
        "---",
        `expression: "${input.cronExpression ?? "0 8 * * *"}"`,
        "conversationId: cron-digest",
        "notify: true",
        "---",
        "",
        "Produce a concise digest of anything noteworthy since the last run.",
        "Your final answer is the message to notify.",
        "",
      ].join("\n"),
    },
  ],
  validateExpectations: [
    { sectionId: "channel:cron", mustBe: "ok", note: "Author at least one cron/*.md job." },
  ],
};

/** `a2a-provider` — expose an Agent Card / A2A provider endpoint (loopback). */
const a2aProvider: AgentRecipe = {
  id: "a2a-provider",
  title: "A2A provider",
  description: "Expose this agent over A2A (Agent Card + provider endpoint) on loopback, with a bearer-token placeholder.",
  tags: ["a2a", "provider", "loopback"],
  riskLevel: "medium",
  playbook: "a2a-provider-and-consumer.md",
  inputs: [
    MODEL_INPUT,
    {
      id: "bearerToken",
      label: "A2A bearer token",
      description: "Bearer required from A2A consumers when requireBearer is set. Externalized to .env.example.",
      secret: true,
      envVar: "MONO_AGENT_A2A_BEARER_TOKEN",
    },
  ],
  config: (input) => withSections(input, {
    a2a: { provider: { enabled: true } },
  }),
  envExample: () => "# Bearer token A2A consumers must present (when requireBearer is set)\nMONO_AGENT_A2A_BEARER_TOKEN=\n",
  validateExpectations: [
    { sectionId: "channel:a2a", mustBe: "ok" },
  ],
};

/** `local-ollama-private` — fully local agent (ollama provider + local memory). */
const localOllamaPrivate: AgentRecipe = {
  id: "local-ollama-private",
  title: "Local Ollama private agent",
  description: "Runs entirely on a local Ollama provider with local journal memory and embeddings — no remote calls.",
  tags: ["local", "ollama", "private", "memory"],
  riskLevel: "low",
  playbook: "local-only-ollama-agent.md",
  inputs: [
    { ...MODEL_INPUT, default: "pi:ollama:gemma4:31b" },
  ],
  config: (input) => withSections(input, {
    providers: {
      local: [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: true,
        },
      ],
    },
    memory: {
      ...memoryBlock("journal"),
      embeddings: { provider: "ollama", model: "nomic-embed-text", endpoint: "http://localhost:11434" },
      recallTool: { enabled: true },
    },
    webhook: { enabled: true },
  }),
  validateExpectations: [
    { sectionId: "runtime", mustBe: "ok", note: "Start ollama and pull the configured model." },
    { sectionId: "memory", mustBe: "ok" },
  ],
};

/** `phoenix-observed` — local artifacts plus a Phoenix OTLP exporter. */
const phoenixObserved: AgentRecipe = {
  id: "phoenix-observed",
  title: "Phoenix-observed agent",
  description: "Local JSONL artifacts plus a best-effort Phoenix OTLP exporter with includeSensitiveData disabled.",
  tags: ["observability", "phoenix", "tracing"],
  riskLevel: "low",
  playbook: "phoenix-observed-agent.md",
  inputs: [MODEL_INPUT],
  config: (input) => withSections(input, {
    observability: {
      exporters: [{ type: "phoenix", includeSensitiveData: false }],
    },
    webhook: { enabled: true },
  }),
  validateExpectations: [
    { sectionId: "observability", mustBe: "ok", note: "Start Phoenix (or it reports `waiting`)." },
  ],
};

/** `sandboxed-code-agent` — explicit workspace policy + fail-closed sandbox. */
const sandboxedCodeAgent: AgentRecipe = {
  id: "sandboxed-code-agent",
  title: "Sandboxed code agent",
  description: "Native srt sandbox, workspace-only filesystem, localhost-only network, fail-closed when the engine is unavailable.",
  tags: ["sandbox", "code", "safe"],
  riskLevel: "medium",
  playbook: "sandboxed-code-agent.md",
  inputs: [MODEL_INPUT],
  config: (input) => withSections(input, {
    tools: { allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], disallowedTools: [] },
    sandbox: {
      mode: "native",
      network: { mode: "localhost" },
      readableRoots: ["."],
      writableRoots: ["."],
      fallback: "fail-closed",
    },
    webhook: { enabled: true },
  }),
  validateExpectations: [
    { sectionId: "sandbox", mustBe: "ok" },
    { sectionId: "tools", mustBe: "ok" },
  ],
};

const ALL_CHANNELS_SECTIONS = {
  telegram: { enabled: true },
  slack: { enabled: true },
  a2a: { provider: { enabled: true } },
  webhook: { enabled: true },
  openaiApi: { enabled: true },
  cron: { enabled: true },
} as const;

/** `full-safe` — every channel present, loopback/secret-externalized, fail-closed. */
const fullSafe: AgentRecipe = {
  id: "full-safe",
  title: "Full (safe) blueprint",
  description: "Every channel structurally configured but loopback-only: secrets externalized to .env.example, allowlists required, observability with includeSensitiveData=false, sandbox fail-closed.",
  tags: ["full", "safe", "blueprint", "all-channels"],
  riskLevel: "medium",
  inputs: [MODEL_INPUT],
  config: (input) => withSections(input, {
    ...ALL_CHANNELS_SECTIONS,
    memory: {
      ...memoryBlock("journal"),
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      recallTool: { enabled: true },
    },
    sandbox: {
      mode: "native",
      network: { mode: "localhost" },
      readableRoots: ["."],
      writableRoots: ["."],
      fallback: "fail-closed",
    },
    observability: { exporters: [{ type: "phoenix", includeSensitiveData: false }] },
  }),
  envExample: () => [
    "# Fill in only the channels you actually run; loopback channels need no secret.",
    "MONO_AGENT_TELEGRAM_TOKEN=",
    "MONO_AGENT_SLACK_BOT_TOKEN=",
    "MONO_AGENT_SLACK_APP_TOKEN=",
    "MONO_AGENT_A2A_BEARER_TOKEN=",
    "MONO_AGENT_OPENAI_API_KEY=",
    "",
  ].join("\n"),
  validateExpectations: [
    { sectionId: "runtime", mustBe: "ok" },
    { sectionId: "sandbox", mustBe: "ok" },
    { sectionId: "channel:webhook", mustBe: "ok" },
  ],
};

/** `full-local-power` — explicitly high-risk local operator profile. */
const fullLocalPower: AgentRecipe = {
  id: "full-local-power",
  title: "Full (local power) blueprint",
  description: "Explicitly high-risk local operator profile: all channels, broad tool access, unrestricted network, and unsafe host-process fallback. No committed secrets, but intentionally unsafe — local use only.",
  tags: ["full", "power", "blueprint", "high-risk", "local"],
  riskLevel: "high",
  inputs: [MODEL_INPUT],
  config: (input) => withSections(input, {
    ...ALL_CHANNELS_SECTIONS,
    tools: { allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"], disallowedTools: [] },
    memory: {
      ...memoryBlock("bujo"),
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      llm: { provider: "agent-host", model: input.model ?? DEFAULT_MODEL },
      recallTool: { enabled: true },
    },
    sandbox: {
      mode: "native",
      network: { mode: "all" },
      readableRoots: ["."],
      writableRoots: ["."],
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    },
    observability: { exporters: [{ type: "phoenix", includeSensitiveData: false }] },
  }),
  envExample: () => [
    "# Local power profile — fill in channels you run; everything else is loopback.",
    "MONO_AGENT_TELEGRAM_TOKEN=",
    "MONO_AGENT_SLACK_BOT_TOKEN=",
    "MONO_AGENT_SLACK_APP_TOKEN=",
    "MONO_AGENT_A2A_BEARER_TOKEN=",
    "MONO_AGENT_OPENAI_API_KEY=",
    "",
  ].join("\n"),
  validateExpectations: [
    { sectionId: "runtime", mustBe: "ok" },
    { sectionId: "channel:webhook", mustBe: "ok" },
  ],
};

/** Ordered catalog — starter recipes first, then the two full blueprints. */
export const RECIPE_CATALOG: readonly AgentRecipe[] = [
  minimalWebhook,
  personalTelegramBujo,
  personalTelegramSupermemory,
  slackTeamBot,
  openaiApiGateway,
  cronDigest,
  a2aProvider,
  localOllamaPrivate,
  phoenixObserved,
  sandboxedCodeAgent,
  fullSafe,
  fullLocalPower,
];

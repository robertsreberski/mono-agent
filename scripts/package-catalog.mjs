export const PACKAGE_CATEGORIES = [
  "runtime",
  "core",
  "context",
  "execution",
  "observability",
  "evaluation",
  "communication",
  "operator-surface",
  "app",
];

// `publishable: true` packages release in lockstep on the npm-release tag path.
// Within that set, `tier` splits them three ways:
//   - `tier: "plugin"` — optional plugin-tier extras (loaded via `channels.plugins[]`,
//     as request-scoped runtime extensions, or through an explicitly selected
//     plugin backend or companion MCP pairing, living under `extras/`);
//   - `tier: "alias"` — the unscoped `create-mono-agent` npm-init installer whose
//     `create-mono-agent`/`mono-agent` bins delegate to `@mono-agent/app`;
//     carries no responsibility of its own and is exempt from the `@mono-agent/`
//     scope rule in the arch and release checks (the bare `mono-agent` npm name is
//     unavailable — npm blocks it as too similar to an unrelated `monoagent`);
//   - no `tier` — the core app-closure packages.
// All three counts are guarded by scripts/release/__tests__/package-count-drift.test.mjs.
export const packageCatalog = [
  {
    dir: "channel-a2a",
    name: "@mono-agent/channel-a2a",
    path: "extras/channel-a2a",
    category: "communication",
    channelIds: ["a2a"],
    responsibility: "Exposes agent responders over A2A and consumes remote A2A agents through direct discovery.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "app",
    name: "@mono-agent/app",
    category: "app",
    responsibility: "Runs a config-first agent host: loads mono-agent.config.json, owns configured responder/harness/runtime/memory composition, and starts every configured channel and traceability.",
    allowedDependencyCategories: [
      "core",
      "context",
      "runtime",
      "execution",
      "observability",
      "communication",
      "operator-surface",
    ],
    publishable: true,
  },
  {
    dir: "contracts",
    name: "@mono-agent/contracts",
    category: "core",
    responsibility: "Defines shared structural request/response contracts plus adapter-neutral settings JSON, env, safe-bind, and bearer helpers.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "conversation",
    name: "@mono-agent/conversation",
    category: "execution",
    responsibility: "Composes prompt context, selected skills, runtime, memory, history, tool policy, and observability for one request.",
    allowedDependencyCategories: ["core", "context", "runtime", "observability"],
    publishable: true,
  },
  {
    dir: "orchestrator",
    name: "@mono-agent/orchestrator",
    path: "extras/orchestrator",
    category: "execution",
    responsibility: "Exposes named collaborator responders to an orchestrator runtime through a bounded MCP tool.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "turn",
    name: "@mono-agent/turn",
    category: "runtime",
    responsibility: "Owns the Pi model-run loop, native journals/storage and compaction, typed host integration, sandbox/process protection, native tools and MCP.",
    allowedDependencyCategories: ["core", "runtime"],
    publishable: true,
  },
  {
    dir: "config",
    name: "@mono-agent/config",
    category: "core",
    responsibility: "Loads adapter-neutral runtime, context, memory, tool, and artifact settings.",
    allowedDependencyCategories: ["core", "runtime"],
    publishable: true,
  },
  {
    dir: "trigger-cron",
    name: "@mono-agent/trigger-cron",
    category: "communication",
    channelIds: ["cron"],
    responsibility: "Invokes agent responders from cron schedules with configurable skip, queue, or replace overlap policies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "docs-mcp",
    name: "@mono-agent/docs-mcp",
    path: "extras/docs-mcp",
    category: "context",
    responsibility: "Provides offline hybrid search and guided reading over version-matched mono-agent documentation through MCP.",
    allowedDependencyCategories: [],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "memory",
    name: "@mono-agent/memory",
    category: "context",
    responsibility: "Provides local memory subpaths for the SQLite substrate, embedding search, and Bullet-Journal memory engine.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
  {
    dir: "create-mono-agent",
    name: "create-mono-agent",
    category: "app",
    responsibility: "Unscoped npm-init installer (`npm create mono-agent`) shipping `create-mono-agent` and `mono-agent` bins that forward every command to @mono-agent/app's CLI.",
    allowedDependencyCategories: ["app"],
    publishable: true,
    tier: "alias",
  },
  {
    dir: "observability",
    name: "@mono-agent/observability",
    category: "observability",
    responsibility: "Records and reads local JSONL run artifacts, summaries, trace source manifests, and composes optional run exporters.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-openai-api",
    name: "@mono-agent/channel-openai-api",
    category: "communication",
    channelIds: ["openai-api"],
    responsibility: "Exposes agent responders through OpenAI-compatible model discovery and Chat Completions endpoints.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-operator",
    name: "@mono-agent/channel-operator",
    category: "communication",
    channelIds: ["tui"],
    responsibility: "Exposes the structured local operator NDJSON endpoint used by the browser console, ACP bridge, and jobs client.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-slack",
    name: "@mono-agent/channel-slack",
    category: "communication",
    channelIds: ["slack"],
    responsibility: "Adapts Slack Socket Mode events to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "channel-telegram",
    name: "@mono-agent/channel-telegram",
    category: "communication",
    channelIds: ["telegram"],
    responsibility: "Adapts Telegram updates to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "web",
    name: "@mono-agent/web",
    category: "operator-surface",
    responsibility:
      "Serves the always-on browser operator console for persistent multi-agent conversations, streamed turns, and local-device attachments.",
    allowedDependencyCategories: ["core", "observability", "communication"],
    publishable: true,
  },
  {
    dir: "channel-messenger",
    name: "@mono-agent/channel-messenger",
    path: "extras/channel-messenger",
    category: "communication",
    channelIds: ["messenger"],
    responsibility: "Adapts Facebook Messenger webhook events to structural agent requests and delivers final-only replies through the Send API.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "channel-whatsapp",
    name: "@mono-agent/channel-whatsapp",
    path: "extras/channel-whatsapp",
    category: "communication",
    channelIds: ["whatsapp"],
    responsibility: "Adapts WhatsApp messages to structural agent requests and buffered final-only replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "trigger-webhook",
    name: "@mono-agent/trigger-webhook",
    category: "communication",
    channelIds: ["webhook"],
    responsibility: "Invokes agent responders from HTTP webhook requests with sync and async modes.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
];

export function shippedChannelIdsFromCatalog(catalog = packageCatalog) {
  return Object.freeze([
    ...new Set(catalog.flatMap((entry) => entry.channelIds ?? [])),
  ]);
}

export const SHIPPED_CHANNEL_IDS = shippedChannelIdsFromCatalog();

export function packageByName() {
  return new Map(packageCatalog.map((entry) => [entry.name, entry]));
}

export function packageRelativePath(entry) {
  return entry.path ?? `packages/${entry.dir}`;
}

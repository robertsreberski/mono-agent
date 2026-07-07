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
//   - `tier: "plugin"` — optional plugin-tier extras (loaded via `channels.plugins[]`
//     or as request-scoped runtime extensions, living under `extras/`);
//   - `tier: "alias"` — the unscoped `create-mono-agent` npm-init installer whose
//     `create-mono-agent`/`mono-agent` bins delegate to `@mono-agent/agent-app`;
//     carries no responsibility of its own and is exempt from the `@mono-agent/`
//     scope rule in the arch and release checks (the bare `mono-agent` npm name is
//     unavailable — npm blocks it as too similar to an unrelated `monoagent`);
//   - no `tier` — the core app-closure packages.
// All three counts are guarded by scripts/release/__tests__/package-count-drift.test.mjs.
export const packageCatalog = [
  {
    dir: "a2a-adapter",
    name: "@mono-agent/a2a-adapter",
    path: "extras/a2a-adapter",
    category: "communication",
    responsibility: "Exposes agent responders over A2A and consumes remote A2A agents through direct discovery.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "agent-app",
    name: "@mono-agent/agent-app",
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
    dir: "agent-contracts",
    name: "@mono-agent/agent-contracts",
    category: "core",
    responsibility: "Defines shared structural request/response contracts plus adapter-neutral settings JSON, env, safe-bind, and bearer helpers.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "agent-harness",
    name: "@mono-agent/agent-harness",
    category: "execution",
    responsibility: "Composes prompt context, selected skills, runtime, memory, history, tool policy, and observability for one request.",
    allowedDependencyCategories: ["core", "context", "runtime", "observability"],
    publishable: true,
  },
  {
    dir: "agent-orchestrator",
    name: "@mono-agent/agent-orchestrator",
    path: "extras/agent-orchestrator",
    category: "execution",
    responsibility: "Exposes named collaborator responders to an orchestrator runtime through a bounded MCP tool.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "agent-runtime",
    name: "@mono-agent/agent-runtime",
    category: "runtime",
    responsibility: "Provides the multi-backend agent runtime bridges (Claude SDK, Claude Code CLI, Codex app-server, Pi SDK) with provider session support.",
    allowedDependencyCategories: ["runtime"],
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
    dir: "cron-adapter",
    name: "@mono-agent/cron-adapter",
    category: "communication",
    responsibility: "Invokes agent responders from cron schedules with skip-overlap execution.",
    allowedDependencyCategories: ["core"],
    publishable: true,
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
    dir: "memory-supermemory",
    name: "@mono-agent/memory-supermemory",
    category: "context",
    responsibility: "Provides a MemoryStore over an external Supermemory instance (local OSS binary or hosted cloud) via its REST API: server-side extraction, hybrid recall, and best-effort writes.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
  {
    dir: "create-mono-agent",
    name: "create-mono-agent",
    category: "app",
    responsibility: "Unscoped npm-init installer (`npm create mono-agent`) shipping `create-mono-agent` and `mono-agent` bins that forward every command to @mono-agent/agent-app's CLI.",
    allowedDependencyCategories: ["app"],
    publishable: true,
    tier: "alias",
  },
  {
    dir: "observability",
    name: "@mono-agent/observability",
    category: "observability",
    responsibility: "Records and reads local JSONL run artifacts, summaries, trace source manifests, and exposes the OTLP/Phoenix exporter through the ./otel subpath.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "openai-api-adapter",
    name: "@mono-agent/openai-api-adapter",
    category: "communication",
    responsibility: "Exposes agent responders through OpenAI-compatible model discovery and Chat Completions endpoints.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "operator-adapter",
    name: "@mono-agent/operator-adapter",
    category: "communication",
    responsibility: "Exposes local operator endpoints: full-fidelity TUI NDJSON turns and read-only live SSE run-event streams.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "runtime-adapter",
    name: "@mono-agent/runtime-adapter",
    category: "runtime",
    responsibility: "Wraps @mono-agent/agent-runtime behind runtime contracts and owns sandbox policy/process wrapping.",
    allowedDependencyCategories: ["core", "runtime"],
    publishable: true,
  },
  {
    dir: "slack-adapter",
    name: "@mono-agent/slack-adapter",
    category: "communication",
    responsibility: "Adapts Slack Socket Mode events to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "telegram-adapter",
    name: "@mono-agent/telegram-adapter",
    category: "communication",
    responsibility: "Adapts Telegram updates to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "session-web",
    name: "@mono-agent/session-web",
    category: "operator-surface",
    responsibility: "Discovers local agent instances and serves a read-only web PWA that visualises their runs live, aggregating recorded-run history and operator-adapter live sub-run streams.",
    allowedDependencyCategories: ["core", "observability"],
    publishable: true,
  },
  {
    dir: "tui",
    name: "@mono-agent/tui",
    category: "operator-surface",
    responsibility: "pi-tui operator console: live chat with full stream-event insight, recorded-run replay, and read-only config view for running agents.",
    allowedDependencyCategories: ["core", "observability"],
    publishable: true,
  },
  {
    dir: "whatsapp-adapter",
    name: "@mono-agent/whatsapp-adapter",
    path: "extras/whatsapp-adapter",
    category: "communication",
    responsibility: "Adapts WhatsApp messages to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
    tier: "plugin",
  },
  {
    dir: "webhook-adapter",
    name: "@mono-agent/webhook-adapter",
    category: "communication",
    responsibility: "Invokes agent responders from HTTP webhook requests with sync and async modes.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
];

export function packageByName() {
  return new Map(packageCatalog.map((entry) => [entry.name, entry]));
}

export function packageByDir() {
  return new Map(packageCatalog.map((entry) => [entry.dir, entry]));
}

export function packageRelativePath(entry) {
  return entry.path ?? `packages/${entry.dir}`;
}

export function packageByPath() {
  return new Map(packageCatalog.map((entry) => [packageRelativePath(entry), entry]));
}

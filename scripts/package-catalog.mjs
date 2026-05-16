export const PACKAGE_CATEGORIES = [
  "runtime",
  "core",
  "context",
  "execution",
  "observability",
  "communication",
  "operator-surface",
];

export const packageCatalog = [
  {
    dir: "agent-contracts",
    name: "@worklab-ai/agent-contracts",
    category: "core",
    responsibility: "Defines shared structural request, response, stream, responder, and cancellation contracts.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "agent-harness",
    name: "@worklab-ai/agent-harness",
    category: "execution",
    responsibility: "Composes context, runtime, memory, history, tool policy, skills, and observability for one request.",
    allowedDependencyCategories: ["core", "context", "runtime", "observability"],
    publishable: true,
  },
  {
    dir: "config",
    name: "@worklab-ai/config",
    category: "core",
    responsibility: "Loads adapter-neutral runtime, context, memory, tool, and artifact settings.",
    allowedDependencyCategories: ["core", "runtime"],
    publishable: true,
  },
  {
    dir: "context",
    name: "@worklab-ai/context",
    category: "context",
    responsibility: "Builds deterministic prompt context from identity, soul, skills, history, and user messages.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
  {
    dir: "memory-md",
    name: "@worklab-ai/memory-md",
    category: "context",
    responsibility: "Provides optional Markdown memory storage for host-owned summaries.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "observability",
    name: "@worklab-ai/observability",
    category: "observability",
    responsibility: "Records and reads local JSONL run artifacts and summaries.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "operator-console",
    name: "@worklab-ai/operator-console",
    category: "operator-surface",
    responsibility: "Serves the local browser settings and recorded-run operator surface.",
    allowedDependencyCategories: ["core", "observability"],
    publishable: true,
  },
  {
    dir: "runtime-adapter",
    name: "@worklab-ai/runtime-adapter",
    category: "runtime",
    responsibility: "Wraps @worklab-ai/agent-runtime behind Mono Agent runtime contracts.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "settings",
    name: "@worklab-ai/settings",
    category: "core",
    responsibility: "Defines generic field groups, patch validation, redaction, and JSON settings storage.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "skills",
    name: "@worklab-ai/skills",
    category: "context",
    responsibility: "Loads explicitly selected skills and turns them into context blocks.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
  {
    dir: "telegram-adapter",
    name: "@worklab-ai/telegram-adapter",
    category: "communication",
    responsibility: "Adapts Telegram updates to structural agent requests and streamed replies.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "tool-policy",
    name: "@worklab-ai/tool-policy",
    category: "core",
    responsibility: "Normalizes fail-closed tool and MCP policy into runtime options.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "tui",
    name: "@worklab-ai/tui",
    category: "operator-surface",
    responsibility: "Provides an Ink terminal chat and read-only config operator surface.",
    allowedDependencyCategories: ["core"],
    publishable: true,
  },
  {
    dir: "whatsapp-adapter",
    name: "@worklab-ai/whatsapp-adapter",
    category: "communication",
    responsibility: "Adapts WhatsApp messages to structural agent requests and streamed replies.",
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

import type { WebCapabilitySetupSnapshot } from "../types";

/** Synthetic display data only. No agent, configuration or credentials are read. */
export const capabilitySnapshot: WebCapabilitySetupSnapshot = {
  version: 1, observation: "durable-inputs", observedAt: "2026-08-01T10:00:00Z",
  process: { pid: 42, startedAt: "2026-08-01T09:00:00Z" },
  cards: [
    ["memory", "Memory", "ok", "Keep useful information across conversations."],
    ["channel:telegram", "Telegram", "waiting", "Chat with your agent through a bot. Waiting for owner-provided credentials."],
    ["channel:slack", "Slack", "disabled", "Connect a workspace bot when you need team conversations."],
    ["tools", "MCP / tools", "error", "Use owner-prepared tools. The configured MCP file needs attention."],
    ["channel:webhook", "Webhook", "disabled", "Accept local HTTP invocations."],
    ["channel:openai-api", "OpenAI-compatible API", "disabled", "Serve an OpenAI-compatible local client."],
    ["channel:cron", "Scheduled jobs", "disabled", "Run the agent on a schedule."],
    ["sandbox", "Sandbox", "waiting", "Constrain local commands and network access."],
    ["tracing", "Built-in tracing", "ok", "Already enabled. External exporters are not supported."],
  ].map(([id, title, status, purpose]) => ({
    id: id!, title: title!, status: status as "ok" | "waiting" | "disabled" | "error", purpose: purpose!,
    requirements: [id === "tracing" ? "No extra service required." : "Review the owner-terminal prerequisites before enabling."],
    usage: id === "memory" ? "Lite uses local disk; Journal adds embedding compute; BuJo also adds extraction-model tokens." : "Invocations may use model tokens; external service costs are separate.",
    ownedConfigPaths: [id!], evidence: [{ id: id!, status: status as "ok" | "waiting" | "disabled" | "error" }],
    steps: ["Back up mono-agent.config.json and preserve unrelated settings.", "Run mono-agent validate in the agent folder; resolve findings before restarting."],
    ...(id === "memory" ? {
      selectedVariant: "memory:lite",
      variants: (["lite", "journal", "bujo"] as const).map((tier) => ({
        id: `memory:${tier}`, title: tier === "lite" ? "Lite" : tier === "journal" ? "Journal" : "BuJo", status: tier === "lite" ? "ok" as const : "disabled" as const,
        purpose: `Synthetic ${tier} memory guidance.`, requirements: [tier === "lite" ? "SQLite and a writable root." : "A running local embedding model and initialized generation metadata."],
        usage: tier === "lite" ? "Local disk; no embeddings." : "Embedding compute and disk usage.", ownedConfigPaths: ["memory"],
        steps: [`Inspect the ${tier} recipe in the owner terminal.`, "mono-agent validate"],
      })),
    } : {}),
  })),
};

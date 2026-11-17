import { ALLOW_ALL_TOOLS } from "../enums.js";

import type { BuildMonoAgentConfigViewInput, ConfigViewSection } from "./types.js";

import { PLACEHOLDER, toField } from "./fields.js";

export function buildToolsSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const tools = redacted.tools;
  return {
    id: "tools",
    label: "Tools",
    status: "active",
    fields: [
      toField({
        id: "tools.allowedTools",
        label: "Allowed tools",
        value: tools.allowedTools.includes(ALLOW_ALL_TOOLS)
          ? "All tools allowed"
          : tools.allowedTools.length === 0
            ? "none (chat-only)"
            : tools.allowedTools.join(", "),
        jsonPresent: json.tools?.allowedTools !== undefined,
      }),
      toField({
        id: "tools.disallowedTools",
        label: "Disallowed tools",
        value: tools.disallowedTools.length === 0 ? "none" : tools.disallowedTools.join(", "),
        jsonPresent: json.tools?.disallowedTools !== undefined,
      }),
      toField({
        id: "tools.filesystem.readableRoots",
        label: "Additional file-tool read roots",
        value: tools.filesystem?.readableRoots.join(", ") ?? "none",
        jsonPresent: json.tools?.filesystem?.readableRoots !== undefined,
      }),
      toField({
        id: "tools.filesystem.writableRoots",
        label: "Additional file-tool write roots",
        value: tools.filesystem?.writableRoots.join(", ") ?? "none",
        jsonPresent: json.tools?.filesystem?.writableRoots !== undefined,
      }),
      ...(tools.conversationSearch === undefined ? [] : [toField({
        id: "tools.conversationSearch.datedSnippets",
        label: "Dated conversation evidence",
        value: String(tools.conversationSearch.datedSnippets),
        jsonPresent: json.tools?.conversationSearch?.datedSnippets !== undefined,
      })]),
      toField({
        id: "tools.computerUse.backend",
        label: "Computer-use backend",
        value: tools.computerUse?.backend ?? PLACEHOLDER,
        jsonPresent: json.tools?.computerUse?.backend !== undefined,
      }),
      toField({
        id: "tools.computerUse.command",
        label: "Computer-use executable",
        value: tools.computerUse?.command ?? PLACEHOLDER,
        jsonPresent: json.tools?.computerUse?.command !== undefined,
      }),
      toField({
        id: "tools.mcpConfigPath",
        label: "MCP config",
        value: tools.mcpConfigPath ?? PLACEHOLDER,
        jsonPresent: json.tools?.mcpConfigPath !== undefined,
      }),
      toField({
        id: "tools.mcpRequestContextServers",
        label: "Request-context MCP servers",
        value: tools.mcpRequestContextServers?.join(", ") ?? "none",
        jsonPresent: json.tools?.mcpRequestContextServers !== undefined,
      }),
      toField({
        id: "tools.continuationServers",
        label: "Continuation MCP servers",
        value: tools.continuationServers?.join(", ") ?? "none",
        jsonPresent: json.tools?.continuationServers !== undefined,
      }),
      toField({
        id: "tools.mcpCallTimeoutMs",
        label: "MCP call inactivity timeout",
        value: tools.mcpCallTimeoutMs === undefined ? "runtime default (120s)" : `${tools.mcpCallTimeoutMs}ms`,
        jsonPresent: json.tools?.mcpCallTimeoutMs !== undefined,
      }),
      toField({
        id: "tools.mcpCallMaxTotalTimeoutMs",
        label: "MCP call max total timeout",
        value: tools.mcpCallMaxTotalTimeoutMs === undefined
          ? "runtime default (45 min)"
          : `${tools.mcpCallMaxTotalTimeoutMs}ms`,
        jsonPresent: json.tools?.mcpCallMaxTotalTimeoutMs !== undefined,
      }),
      toField({
        id: "tools.web.coordination",
        label: "Web request coordination",
        value: tools.web?.coordination ?? "process",
        jsonPresent: json.tools?.web?.coordination !== undefined,
        jsonValue: json.tools?.web?.coordination,
        defaultValue: "process",
      }),
      toField({
        id: "tools.web.search.backend",
        label: "Web search backend",
        value: typeof tools.web?.search.backend === "string" ? tools.web.search.backend : JSON.stringify(tools.web?.search.backend ?? ["parallel", "ollama"]),
        jsonPresent: json.tools?.web?.search?.backend !== undefined,
        jsonValue: json.tools?.web?.search?.backend,
        defaultValue: ["parallel", "ollama"],
      }),
      toField({
        id: "tools.web.search.maxRequestsPerRun",
        label: "Web search requests per run",
        value: String(tools.web?.search.maxRequestsPerRun ?? 4),
        jsonPresent: json.tools?.web?.search?.maxRequestsPerRun !== undefined,
        jsonValue: json.tools?.web?.search?.maxRequestsPerRun,
        defaultValue: 4,
      }),
      toField({
        id: "tools.web.search.searxng.endpoint",
        label: "SearXNG endpoint",
        value: tools.web?.search.searxng?.endpoint ?? "not configured",
        jsonPresent: json.tools?.web?.search?.searxng?.endpoint !== undefined
          || json.tools?.web?.search?.endpoint !== undefined,
        source: json.tools?.web?.search?.searxng?.endpoint !== undefined
            || json.tools?.web?.search?.endpoint !== undefined
          ? "json"
          : "default",
      }),
      toField({
        id: "tools.web.search.endpoint",
        label: "Legacy SearXNG endpoint alias",
        value: tools.web?.search.searxng?.endpoint ?? "not configured",
        jsonPresent: json.tools?.web?.search?.endpoint !== undefined,
        source: json.tools?.web?.search?.searxng?.endpoint !== undefined
            || json.tools?.web?.search?.endpoint !== undefined
          ? "json"
          : "default",
      }),
      toField({
        id: "tools.web.search.ollama.baseUrl",
        label: "Ollama web search base URL",
        value: tools.web?.search.ollama?.baseUrl ?? "not configured",
        jsonPresent: json.tools?.web?.search?.ollama?.baseUrl !== undefined,
      }),
      toField({
        id: "tools.web.search.ollama.apiKeyEnv",
        label: "Ollama web search API key env",
        value: tools.web?.search.ollama?.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.tools?.web?.search?.ollama?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "tools.web.search.ollama.trustPublicUrl",
        label: "Trust custom public Ollama origin",
        value: tools.web?.search.ollama?.trustPublicUrl === true ? "on" : "off",
        jsonPresent: json.tools?.web?.search?.ollama?.trustPublicUrl !== undefined,
      }),
      toField({
        id: "tools.web.search.codex.model",
        label: "Codex web search model",
        value: tools.web?.search.codex?.model ?? "gpt-5.6-luna",
        jsonPresent: json.tools?.web?.search?.codex?.model !== undefined,
        jsonValue: json.tools?.web?.search?.codex?.model,
        defaultValue: "gpt-5.6-luna",
      }),
      toField({
        id: "tools.web.search.parallel.apiKeyEnv", label: "Parallel search API key env", value: tools.web?.search.parallel?.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.tools?.web?.search?.parallel?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "tools.web.fetch.parallel.apiKeyEnv", label: "Parallel fetch API key env", value: tools.web?.fetch.parallel?.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.tools?.web?.fetch?.parallel?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "tools.web.fetch.provider", label: "Web fetch provider", value: typeof tools.web?.fetch.provider === "string" ? tools.web.fetch.provider : JSON.stringify(tools.web?.fetch.provider ?? "local"),
        jsonPresent: json.tools?.web?.fetch?.provider !== undefined,
      }),
      toField({
        id: "tools.web.fetch.render",
        label: "Web fetch browser render",
        value: tools.web?.fetch.render ?? "never",
        jsonPresent: json.tools?.web?.fetch?.render !== undefined,
        jsonValue: json.tools?.web?.fetch?.render,
        defaultValue: "never",
      }),
      toField({
        id: "tools.web.fetch.browserCommand",
        label: "Web browser command",
        value: tools.web?.fetch.browserCommand ?? "agent-browser",
        jsonPresent: json.tools?.web?.fetch?.browserCommand !== undefined,
        jsonValue: json.tools?.web?.fetch?.browserCommand,
        defaultValue: "agent-browser",
      }),
    ],
  };
}

export function buildSandboxSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const sandbox = redacted.sandbox;
  if (sandbox === undefined) {
    return {
      id: "sandbox",
      label: "Sandbox",
      status: "disabled",
      fields: [{ id: "sandbox.mode", label: "Status", value: "not configured", source: "default" }],
    };
  }
  return {
    id: "sandbox",
    label: "Sandbox",
    status: "active",
    fields: [
      toField({
        id: "sandbox.mode",
        label: "Mode",
        value: sandbox.mode,
        jsonPresent: json.sandbox?.mode !== undefined,
      }),
      toField({
        id: "sandbox.network.mode",
        label: "Network",
        value: sandbox.network.mode,
        jsonPresent: json.sandbox?.network?.mode !== undefined,
      }),
      toField({
        id: "sandbox.network.allowlist",
        label: "Network allowlist",
        value: sandbox.network.allowlist.length === 0 ? "none" : sandbox.network.allowlist.join(", "),
        jsonPresent: json.sandbox?.network?.allowlist !== undefined,
      }),
      toField({
        id: "sandbox.readableRoots",
        label: "Readable roots",
        value: sandbox.readableRoots.join(", "),
        jsonPresent: json.sandbox?.readableRoots !== undefined,
      }),
      toField({
        id: "sandbox.writableRoots",
        label: "Writable roots",
        value: sandbox.writableRoots.join(", "),
        jsonPresent: json.sandbox?.writableRoots !== undefined,
      }),
      toField({
        id: "sandbox.denyWrite",
        label: "Deny-write patterns",
        value: sandbox.denyWrite.join(", "),
        jsonPresent: json.sandbox?.denyWrite !== undefined,
      }),
      toField({
        id: "sandbox.fallback",
        label: "Fallback",
        value: sandbox.fallback,
        jsonPresent: json.sandbox?.fallback !== undefined,
      }),
      toField({
        id: "sandbox.unsafeAllowHostProcess",
        label: "Allow host process",
        value: sandbox.unsafeAllowHostProcess ? "yes" : "no",
        jsonPresent: json.sandbox?.unsafeAllowHostProcess !== undefined,
      }),
    ],
  };
}

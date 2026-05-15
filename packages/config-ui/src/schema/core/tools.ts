import { defineFieldGroup } from "../field-group.js";

export const toolsGroup = defineFieldGroup({
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

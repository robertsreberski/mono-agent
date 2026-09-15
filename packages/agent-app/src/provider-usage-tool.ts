import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROVIDER_USAGE_IDS, type ProviderUsageOperator } from "@mono-agent/agent-contracts";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import * as z from "zod/v4";
import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
const SERVER = "mono-agent-provider-usage";
export const PROVIDER_USAGE_INPUT = z.object({ provider: z.enum(PROVIDER_USAGE_IDS).optional() }).strict();
export function isProviderUsageToolAllowed(policy: Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">): boolean {
  const aliases = ["ProviderUsage", `mcp__${SERVER}__ProviderUsage`, `mcp__${SERVER}__*`, "*"];
  return !aliases.some((alias) => policy.disallowedTools?.includes(alias))
    && (policy.allowedTools === undefined || aliases.some((alias) => policy.allowedTools?.includes(alias)));
}
export function createProviderUsageRuntimeExtension(operator: ProviderUsageOperator, policy: Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">): RuntimeOptionsExtension {
  return async (input) => {
    if (!isProviderUsageToolAllowed(policy) || input.request.abortSignal.aborted) return { runtimeOptions: {}, cleanup: async () => {} };
    let closed = false;
    const bound = await createRequestScopedMcpRuntimeExtension({
      serverName: SERVER, startingMessage: "Provider usage tool is starting",
      createServer: () => {
        const server = new McpServer({ name: SERVER, version: "1.0.0" });
        server.registerTool("ProviderUsage", {
          description: "Read subscription quota usage for Claude, Codex, OpenCode Go and GitHub Copilot only when activated by this agent's configured model references. Uses this agent's Pi credentials first; Copilot may use local editor or GitHub CLI credentials. Optional provider filter. Returns percent used, reset times, known plan and cache/error state; cached for five minutes. Inactive providers and missing usable credentials are omitted. Read-only; never changes routing or purchases quota.",
          inputSchema: PROVIDER_USAGE_INPUT,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        }, async ({ provider }) => {
          if (closed || input.request.abortSignal.aborted) return { isError: true, content: [{ type: "text" as const, text: "The originating turn has ended." }] };
          const snapshot = await operator.snapshot(provider);
          return { content: [{ type: "text" as const, text: JSON.stringify(snapshot) }], structuredContent: { ...snapshot } };
        });
        return server;
      },
    })(input);
    return { ...bound, cleanup: async () => { closed = true; await bound.cleanup?.(); } };
  };
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROVIDER_USAGE_IDS, formatProviderUsageLead, projectProviderUsage, type ProviderUsageOperator, type ProviderUsageSnapshot } from "@mono-agent/agent-contracts";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import * as z from "zod/v4";
import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
const SERVER = "mono-agent-provider-usage";
const round2 = (value: number): number => Math.round(value * 100) / 100;
/** Consumer-side burn projection; the v1 snapshot transport shape stays byte-identical. */
function projectSnapshot(snapshot: ProviderUsageSnapshot): Record<string, unknown> {
  const providers: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  for (const provider of snapshot.providers) {
    const windows: Record<string, unknown>[] = [];
    for (const { kind, projection } of projectProviderUsage(provider)) {
      windows.push({ kind, pace: round2(projection.pace), elapsedFraction: round2(projection.elapsedFraction),
        severity: projection.severity, confidence: projection.confidence,
        ...(projection.exhaustsAt === undefined || projection.leadMs === undefined ? {}
          : { exhaustsAt: projection.exhaustsAt, leadMs: projection.leadMs }),
        ...(projection.projectedUnusedPercent === undefined ? {}
          : { projectedUnusedPercent: round2(projection.projectedUnusedPercent) }) });
      if (projection.exhaustsAt !== undefined && projection.leadMs !== undefined) {
        const window = provider.windows.find((item) => item.kind === kind);
        warnings.push(`${provider.label} ${window?.label ?? kind} is projected to run out ${projection.exhaustsAt}, ${formatProviderUsageLead(projection.leadMs)} before its ${window?.resetsAt} reset.`);
      }
    }
    if (windows.length > 0) providers.push({ providerId: provider.providerId, anchor: provider.fetchedAt, windows });
  }
  return { providers, ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }) };
}
export const PROVIDER_USAGE_INPUT = z.object({ provider: z.enum(PROVIDER_USAGE_IDS).optional(), refresh: z.boolean().optional() }).strict();
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
          description: "Read subscription quota usage for Claude, Codex, OpenCode Go and GitHub Copilot only when activated by this agent's configured model references. Uses this agent's Pi credentials first; Copilot may use local editor or GitHub CLI credentials. Optional provider filter. Returns percent used, reset times, known plan and cache/error state; cached for five minutes unless refresh is true, which awaits the shared fetch without bypassing error backoff. Inactive providers and missing usable credentials are omitted. Each window also carries a constant-rate burn projection anchored at its measurement: pace (1 = on track to consume the window by reset), projected exhaustion when ahead of pace, and a two-tier warning (ahead above 1x, unsustainable at 1.5x and above). Read-only; never changes routing or purchases quota.",
          inputSchema: PROVIDER_USAGE_INPUT,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        }, async ({ provider, refresh }) => {
          if (closed || input.request.abortSignal.aborted) return { isError: true, content: [{ type: "text" as const, text: "The originating turn has ended." }] };
          // Forced reads use the operator's explicit-refresh path (shared fetch,
          // error backoff still applies). Operators without refresh keep the cache.
          const snapshot = refresh === true ? await (operator.refresh?.(provider) ?? operator.snapshot(provider)) : await operator.snapshot(provider);
          const enriched = { ...snapshot, projection: projectSnapshot(snapshot) };
          return { content: [{ type: "text" as const, text: JSON.stringify(enriched) }], structuredContent: { ...enriched } };
        });
        return server;
      },
    })(input);
    return { ...bound, cleanup: async () => { closed = true; await bound.cleanup?.(); } };
  };
}

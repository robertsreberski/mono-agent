import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sanitizeRestartProposalReason, type AgentReplyPart, type AgentReplyRestartProposalPart, type AgentResponder } from "@mono-agent/agent-contracts";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import type { TuiRestartAuthority } from "@mono-agent/operator-adapter";
import * as z from "zod/v4";
import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import { mergeReplyParts, type ReplyPartBudget } from "./reply-part-budget.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

export const PROPOSE_RESTART_SERVER_NAME = "mono-agent-restart-proposal";
export const PROPOSE_RESTART_TOOL_NAME = "ProposeRestart";
const POLICY_NAMES = [PROPOSE_RESTART_TOOL_NAME, `mcp__${PROPOSE_RESTART_SERVER_NAME}__${PROPOSE_RESTART_TOOL_NAME}`,
  `mcp__${PROPOSE_RESTART_SERVER_NAME}__*`] as const;
const INPUT = z.object({ reason: z.string().max(1024).optional() }).strict();

type RestartProposalPolicy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;
export function isProposeRestartToolAllowed(policy: RestartProposalPolicy | undefined): boolean {
  const allowed = policy?.allowedTools ?? [];
  const denied = policy?.disallowedTools ?? [];
  return !denied.includes("*") && !POLICY_NAMES.some((name) => denied.includes(name))
    && (allowed.includes("*") || POLICY_NAMES.some((name) => allowed.includes(name)));
}

function isInteractiveWebTurn(request: { readonly conversationId: string; readonly metadata?: Record<string, unknown> }): boolean {
  if (request.metadata?.source !== "web") return false;
  const web = request.metadata.web;
  if (typeof web !== "object" || web === null || Array.isArray(web)) return false;
  const record = web as Record<string, unknown>;
  return typeof record.threadId === "string" && record.threadId.length > 0
    && typeof record.turnId === "string" && record.turnId.length > 0
    && record.trigger === undefined
    && request.conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "") === `web:${record.threadId}`;
}

export interface RestartProposalService {
  readonly extension: RuntimeOptionsExtension;
  wrapResponder(responder: AgentResponder): AgentResponder;
}

/** Display-only MCP capability; only the web service can actually request a restart. */
export function createRestartProposalService(input: {
  readonly authority: Pick<TuiRestartAuthority, "verify"> | undefined;
  readonly isKeyed: () => boolean;
  readonly budget: ReplyPartBudget;
}): RestartProposalService {
  const proposals = new Map<string, AgentReplyRestartProposalPart>();
  const responseContext = new AsyncLocalStorage<{ readonly runIds: Set<string> }>();
  const scoped = createRequestScopedMcpRuntimeExtension({
    serverName: PROPOSE_RESTART_SERVER_NAME,
    startingMessage: "Restart proposal tool is starting",
    createServer: ({ runId }) => createProposalServer((reason) => {
      if (proposals.has(runId)) return { status: "already_proposed" } as const;
      if (input.budget.claim(runId, "restart_proposal") !== "accepted") return { status: "unavailable" } as const;
      const normalized = sanitizeRestartProposalReason(reason);
      const part: AgentReplyRestartProposalPart = {
        type: "restart_proposal", id: randomUUID(),
        ...(normalized === undefined ? {} : { reason: normalized }),
      };
      proposals.set(runId, part);
      return { status: "proposed" } as const;
    }),
  });
  const extension: RuntimeOptionsExtension = async (requestInput) => {
    if (input.authority === undefined || !input.isKeyed() || !isInteractiveWebTurn(requestInput.request)) {
      return { runtimeOptions: {} };
    }
    try {
      if ((await input.authority.verify()).supported !== true || !input.isKeyed()) return { runtimeOptions: {} };
    } catch {
      return { runtimeOptions: {} };
    }
    responseContext.getStore()?.runIds.add(requestInput.runId);
    return scoped(requestInput);
  };
  return {
    extension,
    wrapResponder(responder) {
      return {
        ...responder,
        ...(responder.importContext === undefined ? {} : { importContext: responder.importContext.bind(responder) }),
        async respond(request, stream) {
          const context = { runIds: new Set<string>() };
          try {
            const result = await responseContext.run(context, async () => responder.respond(request, stream));
            const runId = typeof result.metadata?.runId === "string" ? result.metadata.runId : undefined;
            if (runId === undefined || !context.runIds.has(runId)) return result;
            const part = proposals.get(runId);
            if (part === undefined) return result;
            const parts = mergeReplyParts(result.parts, [part] as AgentReplyPart[]);
            return { ...result, parts };
          } finally {
            for (const id of context.runIds) proposals.delete(id);
          }
        },
      };
    },
  };
}

function createProposalServer(propose: (reason: string | undefined) => { readonly status: "proposed" | "already_proposed" | "unavailable" }): McpServer {
  const server = new McpServer({ name: PROPOSE_RESTART_SERVER_NAME, version: "1.0.0" });
  server.registerTool(PROPOSE_RESTART_TOOL_NAME, {
    title: "Propose an agent restart",
    description: "Show one restart suggestion below this reply in the web console. This tool NEVER restarts the agent: the human must review the interruption warning and confirm separately. Do not claim that a restart occurred.",
    inputSchema: INPUT,
  }, async ({ reason }) => {
    const result = propose(reason);
    return {
      ...(result.status === "unavailable" ? { isError: true } : {}),
      content: [{ type: "text" as const, text: result.status === "proposed"
        ? "Restart proposed to the web-console user. Nothing has been restarted; the user must confirm separately."
        : result.status === "already_proposed"
          ? "A restart was already proposed in this reply. Nothing has been restarted."
          : "A restart proposal could not be added to this reply. Nothing has been restarted." }],
      structuredContent: { status: result.status, restarted: false },
    };
  });
  return server;
}

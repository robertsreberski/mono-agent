import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AgentReplyPart, type AgentReplyOptionsPart, type AgentResponder } from "@mono-agent/agent-contracts";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import * as z from "zod/v4";
import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import { mergeReplyParts, type ReplyPartBudget } from "./reply-part-budget.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

export const SUGGEST_REPLIES_SERVER_NAME = "mono-agent-suggest-replies";
export const SUGGEST_REPLIES_TOOL_NAME = "SuggestReplies";
const POLICY_NAMES = [SUGGEST_REPLIES_TOOL_NAME, `mcp__${SUGGEST_REPLIES_SERVER_NAME}__${SUGGEST_REPLIES_TOOL_NAME}`,
  `mcp__${SUGGEST_REPLIES_SERVER_NAME}__*`] as const;
const LABEL = z.string().refine((label) => !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(label), "Labels must be single-line and contain no control characters.")
  .transform((label) => label.trim()).pipe(z.string().min(1).max(75));
const INPUT = z.object({ options: z.array(LABEL).min(2).max(8)
  .refine((options) => new Set(options).size === options.length, "Labels must be distinct.") }).strict();

type SuggestRepliesPolicy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;
export function isSuggestRepliesToolAllowed(policy: SuggestRepliesPolicy | undefined): boolean {
  const allowed = policy?.allowedTools ?? [];
  const denied = policy?.disallowedTools ?? [];
  return !denied.includes("*") && !POLICY_NAMES.some((name) => denied.includes(name))
    && (allowed.includes("*") || POLICY_NAMES.some((name) => allowed.includes(name)));
}

function isWebReplyTurn(request: { readonly conversationId: string; readonly metadata?: Record<string, unknown> }): boolean {
  if (request.metadata?.source !== "web") return false;
  const web = request.metadata.web;
  if (typeof web !== "object" || web === null || Array.isArray(web)) return false;
  const record = web as Record<string, unknown>;
  const conversationId = request.conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "");
  if (record.trigger === "job") {
    return /^web:.+/u.test(conversationId) && conversationId !== "web:new";
  }
  return typeof record.threadId === "string" && record.threadId.length > 0
    && typeof record.turnId === "string" && record.turnId.length > 0
    && record.trigger === undefined && conversationId === `web:${record.threadId}`;
}

export interface SuggestRepliesService {
  readonly extension: RuntimeOptionsExtension;
  wrapResponder(responder: AgentResponder): AgentResponder;
}

/** Non-blocking, request-scoped suggestions; selection is a later ordinary user turn. */
export function createSuggestRepliesService(input: {
  readonly budget: ReplyPartBudget;
}): SuggestRepliesService {
  const choices = new Map<string, AgentReplyOptionsPart>();
  const responseContext = new AsyncLocalStorage<{ readonly runIds: Set<string> }>();
  const scoped = createRequestScopedMcpRuntimeExtension({
    serverName: SUGGEST_REPLIES_SERVER_NAME,
    startingMessage: "Quick reply tool is starting",
    createServer: ({ runId }) => createSuggestionServer((options) => {
      if (!choices.has(runId) && input.budget.claim(runId, "reply_options") !== "accepted") {
        return { status: "unavailable" } as const;
      }
      const part: AgentReplyOptionsPart = {
        type: "reply_options", id: choices.get(runId)?.id ?? randomUUID(), options: [...options],
      };
      choices.set(runId, part);
      return { status: "suggested" } as const;
    }),
  });
  const extension: RuntimeOptionsExtension = async (requestInput) => {
    if (!isWebReplyTurn(requestInput.request)) return { runtimeOptions: {} };
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
            const part = choices.get(runId);
            if (part === undefined) return result;
            const parts = mergeReplyParts(result.parts, [part] as AgentReplyPart[]);
            return { ...result, parts,
              ...(result.metadata?.turnDisposition === "silent"
                ? { metadata: { ...result.metadata, turnDisposition: "visible" } } : {}) };
          } finally {
            for (const id of context.runIds) {
              if (choices.delete(id)) input.budget.unclaim(id, "reply_options");
            }
          }
        },
      };
    },
  };
}

function createSuggestionServer(suggest: (options: readonly string[]) => { readonly status: "suggested" | "unavailable" }): McpServer {
  const server = new McpServer({ name: SUGGEST_REPLIES_SERVER_NAME, version: "1.0.0" });
  server.registerTool(SUGGEST_REPLIES_TOOL_NAME, {
    title: "Suggest quick replies",
    description: "Attach 2–8 non-blocking quick reply buttons beneath your final answer in the web console. Clicking a button sends its label later as a new user turn in this conversation. Use AskUser when this run must wait for a selection. A later call replaces this reply's earlier choices. Labels must be distinct, single-line, trimmed, and 1–75 characters.",
    inputSchema: INPUT,
  }, async ({ options }) => {
    const result = suggest(options);
    return {
      ...(result.status === "unavailable" ? { isError: true } : {}),
      content: [{ type: "text" as const, text: result.status === "suggested"
        ? "Quick reply choices were attached to this final reply. This run does not wait for a selection."
        : "Quick reply choices could not be added because the reply-part budget is full." }],
      structuredContent: result,
    };
  });
  return server;
}

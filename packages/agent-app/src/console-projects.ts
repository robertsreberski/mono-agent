import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import { createWebConsoleToolClient } from "@mono-agent/web";
import * as z from "zod/v4";
import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

const SERVER = "mono-agent-console-projects";
const id = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/u.test(value), "name must not contain line breaks");
const context = z.string().max(4000);
const tagName = z.string().refine((value) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value), "name must not contain control characters").pipe(name);
const tagColor = z.enum(["default", "blue", "purple", "amber", "rose", "green", "teal", "red"]);
const color = z.enum(["default", "blue", "purple", "amber", "rose"]);
export const CONSOLE_PROJECT_SCHEMAS = {
  ListTags: z.object({}).strict(),
  CreateTag: z.object({ name: tagName, color: tagColor.optional() }).strict(),
  UpdateTag: z.object({ tagId: id, name: tagName.optional(), color: tagColor.optional() }).strict()
    .refine((value) => value.name !== undefined || value.color !== undefined, "Provide name or color"),
  DeleteTag: z.object({ tagId: id }).strict(),
  UpdateConversationTags: z.object({ conversationId: id.optional(), add: z.array(id).max(20).optional(), remove: z.array(id).max(20).optional() }).strict()
    .refine((value) => value.add !== undefined || value.remove !== undefined, "Provide add or remove"),
  ListProjects: z.object({}).strict(),
  GetProject: z.object({ projectId: id }).strict(),
  CreateProject: z.object({ name, context: context.optional(), color: color.optional(), attachCurrentConversation: z.boolean().optional() }).strict(),
  UpdateProject: z.object({ projectId: id, name: name.optional(), context: context.optional(), color: color.optional(), archived: z.boolean().optional() }).strict(),
  DeleteProject: z.object({ projectId: id }).strict(),
  ListConversations: z.object({ tagId: id.optional(), projectId: id.optional(), archived: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(2048).optional() }).strict(),
  SearchConversations: z.object({ query: z.string().trim().min(2).max(512), limit: z.number().int().min(1).max(50).optional() }).strict(),
  CreateConversation: z.object({ title: z.string().trim().min(1).max(80).optional(), projectId: id.optional() }).strict(),
  SetConversationProject: z.object({ conversationId: id.optional(), projectId: id.nullable() }).strict(),
} as const;
type ToolName = keyof typeof CONSOLE_PROJECT_SCHEMAS;
type Policy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;

export function isConsoleProjectToolAllowed(tool: ToolName, policy: Policy): boolean {
  const aliases = [tool, `mcp__${SERVER}__${tool}`, `mcp__${SERVER}__*`, "*"];
  return !aliases.some((item) => policy.disallowedTools?.includes(item)) && aliases.some((item) => policy.allowedTools?.includes(item));
}

const descriptions: Record<ToolName, string> = {
  ListTags: "List this agent's tags with their names, colors, and IDs.",
  CreateTag: "Create a named tag for this agent with an optional palette color.",
  UpdateTag: "Change a tag's name or color for this agent.",
  DeleteTag: "Delete a tag and remove it from conversations without deleting those conversations.",
  UpdateConversationTags: "Idempotently add or remove up to 20 tag IDs per list on a conversation (this conversation by default); changes apply immediately and reach the next turn's context, with removal winning if an ID appears in both lists.",
  ListProjects: "List this agent's projects, including archived projects. Returns up to 20 identities and a truncation flag.",
  GetProject: "Read one project and its shared context for this agent.",
  CreateProject: "Create a project. attachCurrentConversation atomically adds this conversation, effective after its current turn finishes.",
  UpdateProject: "Update a project's name, shared context, color, or archive status. Name/context changes affect subsequent turns. Archiving a pending destination is refused until its turns finish.",
  DeleteProject: "Delete a project and retain its conversations. Refused while active members or pending destinations reference it.",
  ListConversations: "List this agent's conversations, newest first: active by default, archived with archived=true, optionally within a project or carrying a tagId. Returns id, title, projectId, tags, archived and updatedAt; use the returned cursor for the next page.",
  SearchConversations: "Find this agent's conversations by words in their titles or messages (the console's full-text search). Returns ranked conversation ids with a matching snippet; use ListConversations to browse instead.",
  CreateConversation: "Create a conversation for this agent, optionally within a project. Does not start a model turn.",
  SetConversationProject: "Join, move, or leave a project (projectId null). Defaults to this conversation. Active turns retain their existing context; the result reports pending membership. Never wait for your own turn to finish.",
};

export function createConsoleProjectsRuntimeExtension(options: {
  readonly sourceId: string;
  readonly policy: Policy;
  readonly createClient?: typeof createWebConsoleToolClient;
  readonly onUnavailable?: () => void;
}): RuntimeOptionsExtension {
  return async (input) => {
    const none = { runtimeOptions: {}, cleanup: async () => {} };
    const metadata = input.request.metadata;
    const web = metadata?.web as Record<string, unknown> | undefined;
    const capability = web?.consoleProjects as Record<string, unknown> | undefined;
    const names = (Object.keys(CONSOLE_PROJECT_SCHEMAS) as ToolName[]).filter((tool) => isConsoleProjectToolAllowed(tool, options.policy));
    if (names.length === 0 || metadata?.source !== "web" || capability?.schema !== 1 || web?.trigger !== undefined
      || typeof web?.threadId !== "string" || typeof web.turnId !== "string"
      || input.request.conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "") !== `web:${web.threadId}`
      || input.request.abortSignal.aborted) return none;
    // Metadata is an availability hint, never authentication: owner discovery issues the actual turn-bound capability.
    let call: Awaited<ReturnType<typeof createWebConsoleToolClient>>;
    try { call = await (options.createClient ?? createWebConsoleToolClient)({ sourceId: options.sourceId, threadId: web.threadId, turnId: web.turnId }); }
    catch { options.onUnavailable?.(); return none; }
    let closed = false;
    const extension = createRequestScopedMcpRuntimeExtension({
      serverName: SERVER, startingMessage: "Console tools are starting",
      createServer: () => {
        const server = new McpServer({ name: SERVER, version: "1.0.0" });
        for (const tool of names) server.registerTool(tool, { description: descriptions[tool], inputSchema: CONSOLE_PROJECT_SCHEMAS[tool] }, async (args: Record<string, unknown>) => {
          if (closed || input.request.abortSignal.aborted) return { isError: true, content: [{ type: "text" as const, text: "The originating turn is no longer writable." }] };
          try {
            // Each independent invocation gets a new identity. There is deliberately no transport retry.
            const result = await call({ operationId: randomUUID(), tool, args: args as Record<string, unknown> });
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
          } catch (error) {
            const candidate = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
            const code = /^[a-z_]{1,64}$/u.test(candidate) ? candidate : "console_tool_failed";
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: code === "project_busy" ? "Wait for current conversation turns before deleting or archiving this project." : code === "console_tool_delivery_unknown" ? "Delivery is unknown. Do not automatically retry." : "The console refused this operation." }) }] };
          }
        });
        return server;
      },
    });
    const bound = await extension(input);
    return { ...bound, cleanup: async () => { closed = true; await bound.cleanup?.(); } };
  };
}

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import { createWebConsoleToolClient } from "@mono-agent/web";
import * as z from "zod/v4";
import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import { telegramProjectTurnFor } from "./telegram-projects.js";

const SERVER = "mono-agent-console-projects";
const id = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/u.test(value), "name must not contain line breaks");
const context = z.string().max(4000);
const tagName = z.string().refine((value) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value), "name must not contain control characters").pipe(name);
const tagColor = z.enum(["default", "blue", "purple", "amber", "rose", "green", "teal", "red"]);
const color = z.enum(["default", "blue", "purple", "amber", "rose"]);
const wakeMessage = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 1000, "message must be at most 1000 UTF-8 bytes").optional();
const wakeRevision = z.number().int().min(1);
export const CONSOLE_PROJECT_SCHEMAS = {
  MarkConversationRead: z.object({ conversationId: id.optional() }).strict(),
  GetWakeSchedule: z.object({}).strict(),
  // The MCP SDK advertises a top-level union as an empty object. The web parser
  // enforces required and kind-specific fields after this transport schema.
  SetWakeSchedule: z.object({
    kind: z.enum(["once", "weekly"]), expectedRevision: wakeRevision.optional(), timezone: z.string().min(1).max(128),
    localAt: z.string().optional(), days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    times: z.array(z.string()).min(1).max(8).optional(), message: wakeMessage,
  }).strict(),
  ClearWakeSchedule: z.object({ expectedRevision: wakeRevision }).strict(),
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
/**
 * `ListProjects` once `telegram.projects` is enabled: a channel filter and
 * paging. Existing configs keep the empty schema above byte for byte.
 */
const CHANNEL_LIST_PROJECTS = z.object({
  channel: z.enum(["telegram"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(2048).optional(),
}).strict();
/**
 * The project tools a Telegram turn may use. Tag, read-state and wake-up tools
 * stay web-only; the console refuses them for channel turns as well.
 */
const TELEGRAM_PROJECT_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "ListProjects", "GetProject", "CreateProject", "UpdateProject", "DeleteProject",
  "ListConversations", "SearchConversations", "CreateConversation", "SetConversationProject",
]);
type Policy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;

export function isConsoleProjectToolAllowed(tool: ToolName, policy: Policy): boolean {
  const aliases = [tool, `mcp__${SERVER}__${tool}`, `mcp__${SERVER}__*`, "*"];
  return !aliases.some((item) => policy.disallowedTools?.includes(item)) && aliases.some((item) => policy.allowedTools?.includes(item));
}

const descriptions: Record<ToolName, string> = {
  MarkConversationRead: "Mark one of this agent's conversations read at its current revision (this conversation by default). Clears the console unread dot on connected devices without opening it or changing recency; later updates can make it unread again. Returns conversationId and readRevision.",
  GetWakeSchedule: "Read this conversation's wake-up schedule or null: definition (once or weekly), state, nextFireAt (UTC instant for the given IANA timezone), lastOutcome and revision. A fired turn arrives later in this conversation.",
  SetWakeSchedule: "Set this conversation's wake-up schedule: kind once with localAt YYYY-MM-DDTHH:mm at least 5 minutes ahead, or weekly with 1–7 days (0=Sunday) and at most 8 HH:mm times; times are local to timezone (IANA). Optional message is at most 1000 UTF-8 bytes. Omit expectedRevision to create; supply the current revision to replace. A fired turn arrives later in this conversation.",
  ClearWakeSchedule: "Clear this conversation's wake-up schedule. Pass the current revision from GetWakeSchedule as expectedRevision.",
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

/** Descriptions once Telegram topics can be projects; everything else keeps `descriptions`. */
const channelDescriptions: Partial<Record<ToolName, string>> = {
  ListProjects: "List this agent's projects, including archived projects, newest activity first: up to limit (default 20) identities, a truncation flag and a cursor for the next page. A project mirroring a Telegram forum topic carries external {channel, label, state}; state gone means the topic was deleted in Telegram. channel=telegram lists only those. Names are not unique: when several match what the user said, ask which one.",
  ListConversations: "List this agent's conversations, newest first: active by default, archived with archived=true, optionally within a project or carrying a tagId. Returns id, title, projectId, tags, archived and updatedAt; use the returned cursor for the next page. The first unfiltered page may add externalConversations: Telegram topics (historyAvailable false; their history stays in Telegram), usable as conversationId for SetConversationProject.",
  CreateProject: "Create a project. attachCurrentConversation atomically adds this conversation (in Telegram: this forum topic), effective after its current turn finishes.",
  SetConversationProject: "Join, move, or leave a project (projectId null). Defaults to this conversation (in Telegram: this forum topic; a project holds at most one topic). Active turns retain their existing context; the result reports pending membership. Never wait for your own turn to finish.",
};

export function createConsoleProjectsRuntimeExtension(options: {
  readonly sourceId: string;
  readonly policy: Policy;
  readonly createClient?: typeof createWebConsoleToolClient;
  readonly onUnavailable?: () => void;
  /** `telegram.projects` is enabled: channel listing arguments and descriptions. */
  readonly channelProjects?: boolean;
}): RuntimeOptionsExtension {
  const schemaFor = (tool: ToolName) => tool === "ListProjects" && options.channelProjects === true ? CHANNEL_LIST_PROJECTS : CONSOLE_PROJECT_SCHEMAS[tool];
  const describe = (tool: ToolName) => (options.channelProjects === true ? channelDescriptions[tool] : undefined) ?? descriptions[tool];
  return async (input) => {
    const none = { runtimeOptions: {}, cleanup: async () => {} };
    const metadata = input.request.metadata;
    const names = (Object.keys(CONSOLE_PROJECT_SCHEMAS) as ToolName[]).filter((tool) => isConsoleProjectToolAllowed(tool, options.policy));
    // A Telegram turn the channel driver bound to a project-enabled service:
    // its project context applies whatever the tool policy says.
    const telegram = telegramProjectTurnFor(metadata);
    if (telegram !== undefined) {
      const allowed = names.filter((tool) => TELEGRAM_PROJECT_TOOLS.has(tool));
      const tools = telegram.human && allowed.length > 0 && !input.request.abortSignal.aborted;
      const turnKey = /^[A-Za-z0-9._:-]{8,128}$/u.test(input.runId) ? input.runId : randomUUID();
      const turn = await telegram.service.beginTurn({ conversationId: input.request.conversationId, turnKey, tools });
      const decorate = turn.decorateUserMessage === undefined ? {} : { decorateUserMessage: turn.decorateUserMessage };
      if (!tools) return { ...none, ...decorate, cleanup: async () => { await turn.revoke(); } };
      if (turn.call === undefined) options.onUnavailable?.();
      const bound = await serve(allowed, turn.call, input);
      return {
        ...bound,
        ...decorate,
        cleanup: async () => { try { await bound.cleanup(); } finally { await turn.revoke(); } },
      };
    }
    const web = metadata?.web as Record<string, unknown> | undefined;
    const capability = web?.consoleProjects as Record<string, unknown> | undefined;
    if (names.length === 0) return none;
    const eligible = !(metadata?.source !== "web" || capability?.schema !== 1 || web?.trigger !== undefined
      || typeof web?.threadId !== "string" || typeof web.turnId !== "string"
      || input.request.conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "") !== `web:${web.threadId}`
      || input.request.abortSignal.aborted);
    // Metadata is an availability hint, never authentication: owner discovery issues the actual turn-bound capability.
    let call: Awaited<ReturnType<typeof createWebConsoleToolClient>> | undefined;
    if (eligible) try { call = await (options.createClient ?? createWebConsoleToolClient)({ sourceId: options.sourceId, threadId: web!.threadId as string, turnId: web!.turnId as string }); }
    catch { options.onUnavailable?.(); }
    return await serve(names, call, input);
  };

  async function serve(
    names: readonly ToolName[],
    call: ((operation: { operationId: string; tool: ToolName; args: Record<string, unknown> }) => Promise<Record<string, unknown>>) | undefined,
    input: Parameters<RuntimeOptionsExtension>[0],
  ): Promise<{ runtimeOptions: Record<string, unknown>; cleanup: () => Promise<void>; settleCleanup?: () => void | Promise<void> }> {
    let closed = false;
    const extension = createRequestScopedMcpRuntimeExtension({
      serverName: SERVER, startingMessage: "Console tools are starting",
      createServer: () => {
        const server = new McpServer({ name: SERVER, version: "1.0.0" });
        for (const tool of names) server.registerTool(tool, { description: describe(tool), inputSchema: schemaFor(tool) }, async (args: Record<string, unknown>) => {
          if (!call) return { isError: true, content: [{ type: "text" as const, text: "Console capability is unavailable for this turn." }] };
          if (closed || input.request.abortSignal.aborted) return { isError: true, content: [{ type: "text" as const, text: "The originating turn is no longer writable." }] };
          try {
            // Each independent invocation gets a new identity. There is deliberately no transport retry.
            const result = await call({ operationId: randomUUID(), tool, args: args as Record<string, unknown> });
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
          } catch (error) {
            const candidate = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
            const code = /^[a-z_]{1,64}$/u.test(candidate) ? candidate : "console_tool_failed";
            const wakeErrors: Record<string, string> = {
              invalid_wake_schedule: "Invalid wake-up definition. Check the local date/time, weekdays, timezone and limits.",
              wake_lead_time: "One-off wake-ups set by this tool must be at least five minutes from now.",
              wake_revision_conflict: "Schedule changed. Read its current revision before retrying.",
              wake_schedule_exists: "This conversation already has a schedule. Read its revision before replacing it.",
              wake_schedule_not_found: "This conversation has no wake-up schedule.",
              thread_archived: "Unarchive this conversation before scheduling a wake-up.",
              invalid_wake_thread: "Wake-up schedules require an ordinary conversation, not a cron thread.",
              external_conversation_unsupported: "Only a forum topic (or a forum's General conversation) can be a project; this chat cannot.",
              project_has_external_conversation: "That project is already linked to another Telegram topic.",
              console_tool_unavailable: "This tool is only available in the web console.",
            };
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: wakeErrors[code] ?? (code === "project_busy" ? "Wait for current conversation turns before deleting or archiving this project." : code === "console_tool_delivery_unknown" ? "Delivery is unknown. Do not automatically retry." : "The console refused this operation.") }) }] };
          }
        });
        return server;
      },
    });
    const bound = await extension(input);
    return { ...bound, runtimeOptions: { ...bound.runtimeOptions, hostCapabilities: Object.fromEntries(names.map((name) => [name, { available: Boolean(call), ...(!call ? { reason: "console_capability_unavailable" } : {}) }])) }, cleanup: async () => { closed = true; await bound.cleanup?.(); } };
  }
}

import type { WebExternalConversation, WebExternalConversationChannel, WebProject, WebTag, WebThread } from "./contracts.js";
import type { WebStore } from "./store.js";
import { WebConsoleError } from "./errors.js";
import { parseTagColor, parseTagName } from "./tag-color.js";
import { parseProjectColor } from "./project-color.js";
import { nextWakeOccurrence, parseWakeDefinition } from "./wake-schedule.js";

/** A live web-console turn: the only scope that existed before channel projects. */
export interface WebConsoleToolScope {
  readonly kind?: "web";
  readonly sourceId: string;
  readonly threadId: string;
  readonly turnId: string;
  /** Host opt-in at owner-authenticated capability issuance, never a tool argument. */
  readonly datedSnippets?: true;
}
/**
 * A live human turn on another channel (a Telegram message), issued through
 * the owner-private ingress to the discovered process that owns the turn and
 * revoked when that turn settles. It never fabricates a web thread or turn.
 */
export interface ExternalConsoleToolScope {
  readonly kind: "external";
  readonly sourceId: string;
  readonly channel: WebExternalConversationChannel;
  /** Host-owned key of the turn's conversation; absent where it cannot be a project (a DM or non-forum group). */
  readonly key?: string;
  /** The owning process's own turn identity; receipts are bound to it. */
  readonly turnKey: string;
  /** The discovered process generation that asked for this scope. */
  readonly pid: number;
}
export type ConsoleToolScope = WebConsoleToolScope | ExternalConsoleToolScope;
export const CONSOLE_TOOL_NAMES = ["ListProjects", "GetProject", "CreateProject", "UpdateProject", "DeleteProject", "ListConversations", "SearchConversations", "CreateConversation", "SetConversationProject", "ListTags", "CreateTag", "UpdateTag", "DeleteTag", "UpdateConversationTags", "MarkConversationRead", "GetWakeSchedule", "SetWakeSchedule", "ClearWakeSchedule"] as const;
export type ConsoleToolName = typeof CONSOLE_TOOL_NAMES[number];
/** Tools that never change state: no operation receipt is written for them. */
export const CONSOLE_READ_TOOL_NAMES: ReadonlySet<ConsoleToolName> = new Set<ConsoleToolName>(["ListTags", "ListProjects", "GetProject", "ListConversations", "SearchConversations", "GetWakeSchedule"]);
/**
 * The project tools a channel turn may use. Tag, read-state and wake-up tools
 * stay web-only: they act on web threads a channel turn does not own.
 */
export const EXTERNAL_CONSOLE_TOOL_NAMES: ReadonlySet<ConsoleToolName> = new Set<ConsoleToolName>([
  "ListProjects", "GetProject", "CreateProject", "UpdateProject", "DeleteProject",
  "ListConversations", "SearchConversations", "CreateConversation", "SetConversationProject",
]);
/** Rows one listing or search returns unless the caller asks for fewer; the hard cap matches the console's own search. */
const CONSOLE_TOOL_PAGE_DEFAULT = 20;
const CONSOLE_TOOL_PAGE_MAX = 50;
/** The search bar's minimum query, pinned by the store's search tests. */
const SEARCH_MIN_QUERY = 2;
export interface ConsoleToolOperation {
  readonly operationId: string;
  readonly tool: ConsoleToolName;
  readonly args: Record<string, unknown>;
}
export interface ConsoleToolCommit {
  readonly result: Record<string, unknown>;
  readonly projects: readonly string[];
  readonly threads: readonly string[];
  readonly deletedProjects: readonly string[];
  readonly tags: readonly string[];
  readonly deletedTags: readonly string[];
}

const invalid = (message: string): never => { throw new WebConsoleError("invalid_console_tool", message, 400); };
const text = (value: unknown, name: string, max: number, empty = false): string => {
  if (typeof value !== "string" || value.length > max || (!empty && value.trim().length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return invalid(`Invalid ${name}.`);
  if (name === "name" && /[\r\n]/u.test(value)) return invalid("name must not contain line breaks.");
  return value;
};
const pageLimit = (value: unknown): number => {
  if (value === undefined) return CONSOLE_TOOL_PAGE_DEFAULT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > CONSOLE_TOOL_PAGE_MAX) return invalid(`limit must be 1-${String(CONSOLE_TOOL_PAGE_MAX)}.`);
  return value;
};
/** Project identity for listings: opaque ids and safe labels, never channel routing identities. */
const projectSummary = ({ id, name, color, archivedAt, conversationCount, external }: WebProject) =>
  ({ id, name, color, archivedAt, conversationCount, ...(external === undefined ? {} : { external: externalSummary(external) }) });
const externalSummary = ({ id, channel, label, state }: WebExternalConversation) => ({ id, channel, label, state });
/** A channel conversation as a ListConversations row: its history lives on the channel, not here. */
const externalDescriptor = (item: WebExternalConversation, current: boolean) => ({
  id: item.id, channel: item.channel, title: item.label, projectId: item.projectId, state: item.state,
  historyAvailable: false, lastSeenAt: item.lastSeenAt, ...(current ? { current: true } : {}),
});
const encodeProjectCursor = (project: WebProject): string => Buffer.from(JSON.stringify([project.updatedAt, project.id])).toString("base64url");
const decodeProjectCursor = (value: unknown): readonly [string, string] => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text(value, "cursor", 2048), "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") return [parsed[0], parsed[1]];
  } catch { /* reported below */ }
  return invalid("Invalid cursor.");
};
/** What the model needs to pick or move a conversation: identity, placement and recency, never message bodies. */
const conversationSummary = (tags: ReadonlyMap<string, WebTag>, { id, title, projectId, tagIds, pendingProject, archivedAt, updatedAt }: WebThread) =>
  ({ id, title, projectId, tags: tagIds.flatMap((tagId) => { const tag = tags.get(tagId); return tag === undefined ? [] : [{ id: tag.id, name: tag.name }]; }), ...(pendingProject === undefined ? {} : { pendingProject }), archived: archivedAt !== null, updatedAt });

/** Strict source-scoped operations shared by the authenticated callback and its tests. */
export function executeConsoleTool(store: WebStore, scope: ConsoleToolScope, operation: ConsoleToolOperation): ConsoleToolCommit {
  const rich = operation.tool === "SearchConversations" && (operation.args?.dated === true
    || operation.args?.after !== undefined || operation.args?.before !== undefined || operation.args?.role !== undefined);
  try { return executeOperation(store, scope, operation); }
  catch (error) {
    if (!rich) throw error;
    const allowed = new Set(["conversation_search_unavailable", "invalid_conversation_search", "invalid_console_tool", "agent_not_found"]);
    const code = error instanceof WebConsoleError && allowed.has(error.code) ? error.code : "conversation_search_failed";
    throw new WebConsoleError(code, code, error instanceof WebConsoleError && allowed.has(error.code) ? error.status : 500);
  }
}

function executeOperation(store: WebStore, scope: ConsoleToolScope, operation: ConsoleToolOperation): ConsoleToolCommit {
  const args = operation.args;
  const keys: Record<ConsoleToolName, readonly string[]> = {
    ListTags: [], CreateTag: ["name", "color"], UpdateTag: ["tagId", "name", "color"], DeleteTag: ["tagId"],
    UpdateConversationTags: ["conversationId", "add", "remove"],
    MarkConversationRead: ["conversationId"],
    GetWakeSchedule: [], SetWakeSchedule: ["expectedRevision", "kind", "timezone", "localAt", "days", "times", "message", "compactFirst"],
    ClearWakeSchedule: ["expectedRevision"],
    ListProjects: ["channel", "limit", "cursor"], GetProject: ["projectId"], CreateProject: ["name", "context", "color", "attachCurrentConversation"],
    UpdateProject: ["projectId", "name", "context", "color", "archived"], DeleteProject: ["projectId"],
    ListConversations: ["tagId", "projectId", "archived", "limit", "cursor"], SearchConversations: ["query", "limit", "dated", "after", "before", "role"], CreateConversation: ["title", "projectId"], SetConversationProject: ["conversationId", "projectId"],
  };
  if (!CONSOLE_TOOL_NAMES.includes(operation.tool) || !args || Array.isArray(args) || typeof args !== "object"
    || Object.keys(args).some((key) => !keys[operation.tool].includes(key))) return invalid("Unknown tool or argument.");
  if (scope.kind === "external" && !EXTERNAL_CONSOLE_TOOL_NAMES.has(operation.tool)) {
    throw new WebConsoleError("console_tool_unavailable", "This tool is only available in the web console.", 403);
  }
  const tags: string[] = [], deletedTags: string[] = [];
  const projects: string[] = [], threads: string[] = [], deletedProjects: string[] = [];
  const tag = (value: unknown) => {
    const item = store.getTag(text(value, "tagId", 128));
    if (item === undefined || item.sourceId !== scope.sourceId) throw new WebConsoleError("tag_not_found", "Tag not found.", 404);
    return item;
  };
  const project = (value: unknown) => {
    const item = store.getProject(text(value, "projectId", 128));
    if (item === undefined || item.sourceId !== scope.sourceId) throw new WebConsoleError("project_not_found", "Project not found.", 404);
    return item;
  };
  const conversation = (value: unknown) => {
    if (value === undefined && scope.kind === "external") throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    const item = store.getThread(value === undefined ? (scope as WebConsoleToolScope).threadId : text(value, "conversationId", 128));
    if (item === undefined || item.sourceId !== scope.sourceId || item.trigger?.kind === "cron") throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return item;
  };
  /** The current turn's channel conversation, when it can join a project. */
  const currentExternal = (): WebExternalConversation | undefined =>
    scope.kind === "external" && scope.key !== undefined ? store.externalConversationByKey(scope.sourceId, scope.channel, scope.key) : undefined;
  /** A web thread, or a channel conversation by its opaque id; this turn's own conversation by default. */
  const member = (value: unknown): { readonly thread: WebThread } | { readonly external: WebExternalConversation } => {
    if (value === undefined && scope.kind === "external") {
      const current = currentExternal();
      if (current === undefined) throw new WebConsoleError("external_conversation_unsupported", "Only a forum topic or a forum's General conversation can join a project.", 409);
      return { external: current };
    }
    if (value !== undefined) {
      const id = text(value, "conversationId", 128);
      if (store.getThread(id) === undefined) {
        const external = store.getExternalConversation(id);
        if (external === undefined || external.sourceId !== scope.sourceId) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
        return { external };
      }
    }
    return { thread: conversation(value) };
  };
  const bindExternal = (item: WebExternalConversation, projectId: string | null) => {
    if (item.projectId !== null) projects.push(item.projectId);
    const bound = store.setExternalConversationProject(item.id, projectId);
    if (projectId !== null) projects.push(projectId);
    return { conversationId: bound.id, projectId: bound.projectId, disposition: "applied" as const };
  };
  const wakeRevision = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid("expectedRevision must be a positive integer.");
    return value;
  };
  const wakeThread = () => conversation(undefined);
  const membership = (id: string) => {
    const item = store.getThread(id)!;
    return { conversationId: id, projectId: item.projectId, disposition: item.pendingProject === undefined ? "applied" : "pending",
      ...(item.pendingProject === undefined ? {} : { pendingProjectId: item.pendingProject.projectId }) };
  };
  let result: Record<string, unknown>;
  switch (operation.tool) {
    case "ListTags": result = { tags: store.listTags(scope.sourceId) }; break;
    case "CreateTag": {
      const created = store.createTag({ sourceId: scope.sourceId, name: parseTagName(args.name),
        ...(args.color === undefined ? {} : { color: parseTagColor(args.color) }) });
      tags.push(created.id); result = { tag: created, tagId: created.id }; break;
    }
    case "UpdateTag": {
      const item = tag(args.tagId);
      const updated = store.patchTag(item.id, { ...(args.name === undefined ? {} : { name: parseTagName(args.name) }),
        ...(args.color === undefined ? {} : { color: parseTagColor(args.color) }) });
      tags.push(item.id); result = { tag: updated }; break;
    }
    case "DeleteTag": {
      const item = tag(args.tagId);
      threads.push(...store.deleteTag(item.id)); deletedTags.push(item.id);
      result = { tagId: item.id, deleted: true }; break;
    }
    case "UpdateConversationTags": {
      if (args.add === undefined && args.remove === undefined) return invalid("Provide add or remove.");
      const resolve = (value: unknown): string[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 20) return invalid("add and remove must be arrays of at most 20 tag IDs.");
        return value.map((id: unknown) => tag(id).id);
      };
      const add = resolve(args.add), remove = new Set(resolve(args.remove));
      const current = conversation(args.conversationId);
      const next = [...new Set([...current.tagIds, ...add])].filter((id) => !remove.has(id));
      if (next.length !== current.tagIds.length || next.some((id) => !current.tagIds.includes(id))) {
        store.patchThread(current.id, { tagIds: next }); threads.push(current.id);
      }
      result = { conversationId: current.id, tagIds: store.getThread(current.id)!.tagIds, disposition: "applied" }; break;
    }
    case "GetWakeSchedule": result = { schedule: store.wakeSchedule(wakeThread().id) }; break;
    case "SetWakeSchedule": {
      const current = wakeThread();
      const { expectedRevision, ...fields } = args;
      const now = new Date();
      const definition = parseWakeDefinition(fields, now);
      if (definition.kind === "once" && nextWakeOccurrence(definition, now)!.getTime() - now.getTime() < 5 * 60_000) {
        throw new WebConsoleError("wake_lead_time", "localAt: Choose a time at least five minutes from now.", 400);
      }
      const existing = store.wakeSchedule(current.id);
      if ((existing === null) !== (expectedRevision === undefined)) {
        throw new WebConsoleError("wake_revision_conflict", "Schedule changed; get its current revision and retry.", 409);
      }
      const schedule = existing === null ? store.createWakeSchedule(current.id, definition)
        : store.changeWakeSchedule(current.id, wakeRevision(expectedRevision), { definition });
      threads.push(current.id); result = { schedule }; break;
    }
    case "ClearWakeSchedule": {
      const current = wakeThread();
      store.changeWakeSchedule(current.id, wakeRevision(args.expectedRevision), { delete: true });
      threads.push(current.id); result = { cleared: true }; break;
    }
    case "MarkConversationRead": {
      const current = conversation(args.conversationId);
      if (current.readRevision !== current.revision) {
        store.markConversationRead(current.id);
        threads.push(current.id);
      }
      result = { conversationId: current.id, readRevision: current.revision }; break;
    }
    case "ListProjects": {
      if (args.channel !== undefined && args.channel !== "telegram") return invalid("channel must be telegram.");
      const limit = pageLimit(args.limit);
      let list = store.listProjects(scope.sourceId);
      if (args.channel !== undefined) list = list.filter((item) => item.external?.channel === args.channel);
      if (args.cursor !== undefined) {
        const [updatedAt, id] = decodeProjectCursor(args.cursor);
        list = list.filter((item) => item.updatedAt < updatedAt || (item.updatedAt === updatedAt && item.id < id));
      }
      const page = list.slice(0, limit);
      result = { projects: page.map(projectSummary), truncated: list.length > limit,
        ...(list.length > limit ? { cursor: encodeProjectCursor(page.at(-1)!) } : {}) };
      break;
    }
    case "GetProject": result = { project: project(args.projectId) }; break;
    case "CreateProject": {
      if (args.attachCurrentConversation !== undefined && typeof args.attachCurrentConversation !== "boolean") return invalid("attachCurrentConversation must be boolean.");
      if (scope.kind === "external") {
        // Resolve the attach target before creating anything, so a refusal
        // leaves no orphan project behind.
        const current = args.attachCurrentConversation === true ? member(undefined) : undefined;
        const created = store.createProject({ sourceId: scope.sourceId, name: text(args.name, "name", 120).trim(),
          ...(args.context === undefined ? {} : { context: text(args.context, "context", 4000, true) }),
          ...(args.color === undefined ? {} : { color: parseProjectColor(args.color) }) });
        projects.push(created.id);
        result = { projectId: created.id, ...(current !== undefined && "external" in current ? { attachment: bindExternal(current.external, created.id) } : {}) };
        break;
      }
      const created = store.createProject({ sourceId: scope.sourceId, name: text(args.name, "name", 120).trim(),
        ...(args.context === undefined ? {} : { context: text(args.context, "context", 4000, true) }),
        ...(args.color === undefined ? {} : { color: parseProjectColor(args.color) }) });
      projects.push(created.id);
      if (args.attachCurrentConversation === true) {
        const current = conversation(undefined);
        if (current.projectId !== null) projects.push(current.projectId);
        store.patchThread(current.id, { projectId: created.id });
        threads.push(current.id);
      }
      result = { projectId: created.id, ...(args.attachCurrentConversation === true ? { attachment: membership(scope.threadId) } : {}) };
      break;
    }
    case "UpdateProject": {
      const item = project(args.projectId);
      if (args.archived !== undefined && typeof args.archived !== "boolean") return invalid("archived must be boolean.");
      if (Object.keys(args).length === 1) return invalid("Provide a project change.");
      const updated = store.patchProject(item.id, {
        ...(args.name === undefined ? {} : { name: text(args.name, "name", 120).trim() }),
        ...(args.context === undefined ? {} : { context: text(args.context, "context", 4000, true) }),
        ...(args.color === undefined ? {} : { color: parseProjectColor(args.color) }),
        ...(args.archived === undefined ? {} : { archived: args.archived as boolean }),
      });
      projects.push(item.id); result = { project: updated }; break;
    }
    case "DeleteProject": {
      const item = project(args.projectId); threads.push(...store.deleteProject(item.id)); deletedProjects.push(item.id);
      result = { projectId: item.id, deleted: true }; break;
    }
    case "ListConversations": {
      if (args.archived !== undefined && typeof args.archived !== "boolean") return invalid("archived must be boolean.");
      const projectId = args.projectId === undefined ? undefined : project(args.projectId).id;
      const tagId = args.tagId === undefined ? undefined : tag(args.tagId).id;
      const limit = pageLimit(args.limit);
      const page = store.listThreadsPage({ sourceId: scope.sourceId, archived: args.archived === true, scope: "chats", limit,
        ...(tagId === undefined ? {} : { tagId }),
        ...(projectId === undefined ? {} : { projectId }), ...(args.cursor === undefined ? {} : { before: text(args.cursor, "cursor", 2048) }) });
      // One source-scoped lookup serves every summary, regardless of tag count.
      const tagMap = new Map(store.listTags(scope.sourceId).map((tag) => [tag.id, tag]));
      // Channel conversations carry no tags or archive state and have no
      // pages of their own: they ride on the first unfiltered page only, and
      // the key is absent when an agent has none.
      const current = currentExternal();
      const external = args.cursor !== undefined || args.archived === true || tagId !== undefined ? []
        : store.listExternalConversations(scope.sourceId, { ...(projectId === undefined ? {} : { projectId }), limit });
      result = { conversations: page.threads.map((thread) => conversationSummary(tagMap, thread)),
        ...(external.length === 0 ? {} : { externalConversations: external.map((item) => externalDescriptor(item, item.id === current?.id)) }),
        ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }) };
      break;
    }
    case "SearchConversations": {
      // The search bar's own path: FTS5 over message text plus title substring
      // matches, ranked the same way, over this agent's chats (archived included).
      const query = text(args.query, "query", 512).trim();
      if (query.length < SEARCH_MIN_QUERY) return invalid(`query needs at least ${String(SEARCH_MIN_QUERY)} characters.`);
      const rich = args.dated === true || args.after !== undefined || args.before !== undefined || args.role !== undefined;
      if (rich && (scope.kind === "external" || scope.datedSnippets !== true
        || !store.isOwnerConsoleTurn(scope.threadId, scope.turnId))) {
        throw new WebConsoleError("conversation_search_unavailable", "conversation_search_unavailable", 403);
      }
      if (args.dated !== undefined && typeof args.dated !== "boolean") {
        throw new WebConsoleError("invalid_conversation_search", "invalid_conversation_search", 400);
      }
      const date = (value: unknown): string | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
          || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
          || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
          throw new WebConsoleError("invalid_conversation_search", "invalid_conversation_search", 400);
        }
        return value;
      };
      const after = date(args.after), before = date(args.before);
      if ((after !== undefined && before !== undefined && after > before)
        || (args.role !== undefined && args.role !== "user" && args.role !== "assistant")) {
        throw new WebConsoleError("invalid_conversation_search", "invalid_conversation_search", 400);
      }
      const page = store.searchThreads({ sourceId: scope.sourceId, query,
        limit: pageLimit(args.limit ?? (rich ? 10 : undefined)), scope: "chats",
        ...(rich ? { dated: { ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }),
          ...(args.role === undefined ? {} : { role: args.role }) } } : {}),
      });
      const tagMap = new Map(store.listTags(scope.sourceId).map((tag) => [tag.id, tag]));
      result = {
        conversations: page.hits.map((hit) => ({
          ...conversationSummary(tagMap, hit.thread), titleMatch: hit.titleMatch, messageMatches: hit.messageMatches,
          // The console wraps matches in control-character sentinels for highlighting; a model wants plain text.
          ...(hit.snippet === undefined ? {} : { snippet: hit.snippet.replace(/[\u0002\u0003]/gu, "") }),
          ...(rich ? { match: hit.messageMatch === undefined ? { kind: "title", consoleUrl: `/?thread=${encodeURIComponent(hit.thread.id)}` }
            : { kind: "message", ...hit.messageMatch, snippet: hit.snippet ?? "", consoleUrl: `/?thread=${encodeURIComponent(hit.thread.id)}` } } : {}),
        })),
        truncated: page.truncated,
      };
      break;
    }
    case "CreateConversation": {
      const projectId = args.projectId === undefined ? undefined : project(args.projectId).id;
      const created = store.createThread(scope.sourceId, projectId === undefined ? {} : { projectId });
      if (args.title !== undefined) store.patchThread(created.id, { title: text(args.title, "title", 80) });
      threads.push(created.id); if (projectId !== undefined) projects.push(projectId);
      result = { conversationId: created.id, projectId: created.projectId }; break;
    }
    case "SetConversationProject": {
      const target = member(args.conversationId);
      if ("external" in target) {
        result = bindExternal(target.external, args.projectId === null ? null : project(args.projectId).id);
        break;
      }
      const current = target.thread;
      const destination = args.projectId === null ? null : project(args.projectId).id;
      store.patchThread(current.id, { projectId: destination });
      threads.push(current.id);
      if (current.projectId !== null) projects.push(current.projectId);
      if (destination !== null) projects.push(destination);
      result = membership(current.id); break;
    }
  }
  return { result, projects: [...new Set(projects)], threads, deletedProjects, tags, deletedTags };
}

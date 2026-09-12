import type { WebThread } from "./contracts.js";
import type { WebStore } from "./store.js";
import { WebConsoleError } from "./errors.js";
import { parseTagColor } from "./tag-color.js";
import { parseProjectColor } from "./project-color.js";

export interface ConsoleToolScope {
  readonly sourceId: string;
  readonly threadId: string;
  readonly turnId: string;
}
export const CONSOLE_TOOL_NAMES = ["ListProjects", "GetProject", "CreateProject", "UpdateProject", "DeleteProject", "ListConversations", "SearchConversations", "CreateConversation", "SetConversationProject", "ListTags", "CreateTag", "UpdateTag", "DeleteTag", "UpdateConversationTags"] as const;
export type ConsoleToolName = typeof CONSOLE_TOOL_NAMES[number];
/** Tools that never change state: no operation receipt is written for them. */
export const CONSOLE_READ_TOOL_NAMES: ReadonlySet<ConsoleToolName> = new Set<ConsoleToolName>(["ListTags", "ListProjects", "GetProject", "ListConversations", "SearchConversations"]);
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
/** What the model needs to pick or move a conversation: identity, placement and recency, never message bodies. */
const conversationSummary = (store: WebStore, { id, title, projectId, tagIds, pendingProject, archivedAt, updatedAt }: WebThread) =>
  ({ id, title, projectId, tags: tagIds.flatMap((tagId) => { const tag = store.getTag(tagId); return tag === undefined ? [] : [{ id: tag.id, name: tag.name }]; }), ...(pendingProject === undefined ? {} : { pendingProject }), archived: archivedAt !== null, updatedAt });

/** Strict source-scoped operations shared by the authenticated callback and its tests. */
export function executeConsoleTool(store: WebStore, scope: ConsoleToolScope, operation: ConsoleToolOperation): ConsoleToolCommit {
  const args = operation.args;
  const keys: Record<ConsoleToolName, readonly string[]> = {
    ListTags: [], CreateTag: ["name", "color"], UpdateTag: ["tagId", "name", "color"], DeleteTag: ["tagId"],
    UpdateConversationTags: ["conversationId", "add", "remove"],
    ListProjects: [], GetProject: ["projectId"], CreateProject: ["name", "context", "color", "attachCurrentConversation"],
    UpdateProject: ["projectId", "name", "context", "color", "archived"], DeleteProject: ["projectId"],
    ListConversations: ["tagId", "projectId", "archived", "limit", "cursor"], SearchConversations: ["query", "limit"], CreateConversation: ["title", "projectId"], SetConversationProject: ["conversationId", "projectId"],
  };
  if (!CONSOLE_TOOL_NAMES.includes(operation.tool) || !args || Array.isArray(args) || typeof args !== "object"
    || Object.keys(args).some((key) => !keys[operation.tool].includes(key))) return invalid("Unknown tool or argument.");
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
    const item = store.getThread(value === undefined ? scope.threadId : text(value, "conversationId", 128));
    if (item === undefined || item.sourceId !== scope.sourceId || item.trigger?.kind === "cron") throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return item;
  };
  const membership = (id: string) => {
    const item = store.getThread(id)!;
    return { conversationId: id, projectId: item.projectId, disposition: item.pendingProject === undefined ? "applied" : "pending",
      ...(item.pendingProject === undefined ? {} : { pendingProjectId: item.pendingProject.projectId }) };
  };
  let result: Record<string, unknown>;
  switch (operation.tool) {
    case "ListTags": result = { tags: store.listTags(scope.sourceId) }; break;
    case "CreateTag": {
      const created = store.createTag({ sourceId: scope.sourceId, name: text(args.name, "name", 120),
        ...(args.color === undefined ? {} : { color: parseTagColor(args.color) }) });
      tags.push(created.id); result = { tag: created, tagId: created.id }; break;
    }
    case "UpdateTag": {
      const item = tag(args.tagId);
      const updated = store.patchTag(item.id, { ...(args.name === undefined ? {} : { name: text(args.name, "name", 120) }),
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
        if (!Array.isArray(value)) return invalid("add and remove must be arrays.");
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
    case "ListProjects": {
      const list = store.listProjects(scope.sourceId);
      result = { projects: list.slice(0, 20).map(({ id, name, color, archivedAt, conversationCount }) => ({ id, name, color, archivedAt, conversationCount })), truncated: list.length > 20 };
      break;
    }
    case "GetProject": result = { project: project(args.projectId) }; break;
    case "CreateProject": {
      if (args.attachCurrentConversation !== undefined && typeof args.attachCurrentConversation !== "boolean") return invalid("attachCurrentConversation must be boolean.");
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
      const page = store.listThreadsPage({ sourceId: scope.sourceId, archived: args.archived === true, scope: "chats", limit: pageLimit(args.limit),
        ...(tagId === undefined ? {} : { tagId }),
        ...(projectId === undefined ? {} : { projectId }), ...(args.cursor === undefined ? {} : { before: text(args.cursor, "cursor", 2048) }) });
      result = { conversations: page.threads.map((thread) => conversationSummary(store, thread)), ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }) };
      break;
    }
    case "SearchConversations": {
      // The search bar's own path: FTS5 over message text plus title substring
      // matches, ranked the same way, over this agent's chats (archived included).
      const query = text(args.query, "query", 512).trim();
      if (query.length < SEARCH_MIN_QUERY) return invalid(`query needs at least ${String(SEARCH_MIN_QUERY)} characters.`);
      const page = store.searchThreads({ sourceId: scope.sourceId, query, limit: pageLimit(args.limit), scope: "chats" });
      result = {
        conversations: page.hits.map((hit) => ({
          ...conversationSummary(store, hit.thread), titleMatch: hit.titleMatch, messageMatches: hit.messageMatches,
          // The console wraps matches in control-character sentinels for highlighting; a model wants plain text.
          ...(hit.snippet === undefined ? {} : { snippet: hit.snippet.replace(/[\u0002\u0003]/gu, "") }),
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
      const current = conversation(args.conversationId);
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

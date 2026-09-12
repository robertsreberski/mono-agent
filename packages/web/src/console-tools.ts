import type { WebStore } from "./store.js";
import { WebConsoleError } from "./errors.js";
import { parseProjectColor } from "./project-color.js";

export interface ConsoleToolScope {
  readonly sourceId: string;
  readonly threadId: string;
  readonly turnId: string;
}
export const CONSOLE_TOOL_NAMES = ["ListProjects", "GetProject", "CreateProject", "UpdateProject", "DeleteProject", "ListConversations", "CreateConversation", "SetConversationProject"] as const;
export type ConsoleToolName = typeof CONSOLE_TOOL_NAMES[number];
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
}

const invalid = (message: string): never => { throw new WebConsoleError("invalid_console_tool", message, 400); };
const text = (value: unknown, name: string, max: number, empty = false): string => {
  if (typeof value !== "string" || value.length > max || (!empty && value.trim().length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return invalid(`Invalid ${name}.`);
  if (name === "name" && /[\r\n]/u.test(value)) return invalid("name must not contain line breaks.");
  return value;
};

/** Strict source-scoped operations shared by the authenticated callback and its tests. */
export function executeConsoleTool(store: WebStore, scope: ConsoleToolScope, operation: ConsoleToolOperation): ConsoleToolCommit {
  const args = operation.args;
  const keys: Record<ConsoleToolName, readonly string[]> = {
    ListProjects: [], GetProject: ["projectId"], CreateProject: ["name", "context", "color", "attachCurrentConversation"],
    UpdateProject: ["projectId", "name", "context", "color", "archived"], DeleteProject: ["projectId"],
    ListConversations: ["projectId", "cursor"], CreateConversation: ["title", "projectId"], SetConversationProject: ["conversationId", "projectId"],
  };
  if (!CONSOLE_TOOL_NAMES.includes(operation.tool) || !args || Array.isArray(args) || typeof args !== "object"
    || Object.keys(args).some((key) => !keys[operation.tool].includes(key))) return invalid("Unknown tool or argument.");
  const projects: string[] = [], threads: string[] = [], deletedProjects: string[] = [];
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
      const projectId = args.projectId === undefined ? undefined : project(args.projectId).id;
      const page = store.listThreadsPage({ sourceId: scope.sourceId, archived: false, scope: "chats", limit: 20,
        ...(projectId === undefined ? {} : { projectId }), ...(args.cursor === undefined ? {} : { before: text(args.cursor, "cursor", 2048) }) });
      result = { conversations: page.threads.map(({ id, title, projectId, pendingProject }) => ({ id, title, projectId, pendingProject })), ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }) };
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
  return { result, projects: [...new Set(projects)], threads, deletedProjects };
}

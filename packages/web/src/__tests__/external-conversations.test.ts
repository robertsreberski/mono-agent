import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WebAgentSummary } from "../contracts.js";
import type { ConsoleToolName, ExternalConsoleToolScope } from "../console-tools.js";
import { parseExternalObservation, sanitizeExternalLabel, type ExternalConversationObservation } from "../external-conversations.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

function agent(sourceId = "agent-one"): WebAgentSummary {
  return {
    sourceId, label: sourceId, status: "online", health: "running", supportsAttachments: true,
    models: ["provider/default"], defaultModel: "provider/default", efforts: [], modelOptions: {},
    runSettings: { config: { model: "provider/default" }, override: null, effective: { model: "provider/default", modelSource: "config", effortSource: "config" } },
    updatedAt: "2026-09-28T09:00:00.000Z",
  };
}

async function openStore(): Promise<{ store: WebStore; clock: { now: number } }> {
  const base = await temporaryRoot();
  cleanup.push(base);
  const clock = { now: Date.parse("2026-09-28T10:00:00.000Z") };
  const store = await WebStore.open({ stateDir: join(base, "state"), clock: () => new Date(clock.now += 1) });
  store.replaceAgents([agent(), agent("agent-two")]);
  return { store, clock };
}

const FLIGHTS = "telegram:42:-1001:77";
const GENERAL = "telegram:42:-1001:main";
const seen = (at: string, fields: Partial<ExternalConversationObservation> = {}): ExternalConversationObservation => ({
  key: FLIGHTS, kind: "topic", chatLabel: "Trips", topicLabel: "Flights", seenAt: at, ...fields,
});

function external(scope: Partial<ExternalConsoleToolScope> = {}): ExternalConsoleToolScope {
  return { kind: "external", sourceId: "agent-one", channel: "telegram", key: FLIGHTS, turnKey: "telegram-turn-0001", pid: 123, ...scope };
}

let operations = 0;
function run(store: WebStore, scope: ExternalConsoleToolScope, tool: ConsoleToolName, args: Record<string, unknown> = {}) {
  operations += 1;
  return store.consoleToolOperation(scope, { operationId: `external-operation-${String(operations).padStart(6, "0")}`, tool, args });
}

describe("channel conversations mirrored into projects", () => {
  it("creates one project per observed topic and General, never duplicated by later sightings", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [
      seen("2026-09-28T09:00:00.000Z"),
      { key: GENERAL, kind: "main", chatLabel: "Trips", seenAt: "2026-09-28T09:00:01.000Z" },
    ]);
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:05:00.000Z")]);
    const projects = store.listProjects("agent-one");
    expect(projects.map((project) => project.name).sort()).toEqual(["Trips › Flights", "Trips › General"]);
    const flights = projects.find((project) => project.name === "Trips › Flights")!;
    expect(flights).toMatchObject({ context: "", conversationCount: 0, external: { channel: "telegram", label: "Trips › Flights", state: "open", projectId: flights.id } });
    // Routing identities never reach a project or listing.
    expect(JSON.stringify(projects)).not.toContain("-1001");
    expect(store.listProjects("agent-two")).toEqual([]);
  });

  it("renames auto-named projects only, and keeps a chosen name authoritative", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:00:00.000Z", { topicLabel: undefined })]);
    const [unnamed] = store.listProjects("agent-one");
    expect(unnamed!.name).toBe("Trips › unnamed topic");
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:01:00.000Z")]);
    expect(store.getProject(unnamed!.id)!.name).toBe("Trips › Flights");
    store.patchProject(unnamed!.id, { name: "Holiday flights" });
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:02:00.000Z", { topicLabel: "Flights 2027" })]);
    expect(store.getProject(unnamed!.id)).toMatchObject({ name: "Holiday flights", external: { label: "Trips › Flights 2027" } });
  });

  it("tracks closed and reopened by newest evidence, and clears gone only on later activity", async () => {
    const { store, clock } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:00:00.000Z", { state: "closed" })]);
    const conversation = () => store.externalConversationByKey("agent-one", "telegram", FLIGHTS)!;
    expect(conversation().state).toBe("closed");
    // An older replayed "open" never overrides a newer close.
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T08:00:00.000Z", { state: "open" })]);
    expect(conversation().state).toBe("closed");
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:10:00.000Z", { state: "open" })]);
    expect(conversation().state).toBe("open");
    clock.now = Date.parse("2026-09-28T11:00:00.000Z");
    const projectId = conversation().projectId!;
    store.patchProject(projectId, { context: "Prefer aisle seats." });
    expect(store.markExternalConversationGone("agent-one", "telegram", FLIGHTS)).toEqual({ projectId });
    expect(conversation().state).toBe("gone");
    // A replay of an earlier sighting is not evidence the topic came back.
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T10:30:00.000Z")]);
    expect(conversation().state).toBe("gone");
    // The project and its context survive; a send refuses honestly.
    expect(store.getProject(projectId)).toMatchObject({ context: "Prefer aisle seats.", external: { state: "gone" } });
    expect(() => store.resolveExternalProjectDestination("agent-one", "telegram", projectId))
      .toThrowError(expect.objectContaining({ code: "external_conversation_gone" }));
  });

  it("detaches with a tombstone on project deletion and re-links only on request", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:00:00.000Z")]);
    const first = store.externalConversationByKey("agent-one", "telegram", FLIGHTS)!;
    const chat = store.createThread("agent-one", { projectId: first.projectId! });
    store.deleteProject(first.projectId!);
    expect(store.getThread(chat.id)!.projectId).toBeNull();
    expect(store.externalConversationByKey("agent-one", "telegram", FLIGHTS)).toMatchObject({ id: first.id, projectId: null });
    // Observation keeps working without recreating the project.
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:30:00.000Z")]);
    expect(store.listProjects("agent-one")).toEqual([]);
    expect(store.externalTurnContext("agent-one", "telegram", FLIGHTS)).toEqual({ conversation: expect.objectContaining({ projectId: null }) });
    // "Make this a project" from the topic re-links it.
    const created = run(store, external(), "CreateProject", { name: "Flights again", context: "Window seats.", attachCurrentConversation: true });
    expect(created.result).toMatchObject({ attachment: { conversationId: first.id, disposition: "applied" } });
    expect(store.externalTurnContext("agent-one", "telegram", FLIGHTS).project)
      .toEqual({ id: created.result.projectId, name: "Flights again", context: "Window seats." });
    // A chosen name is never replaced by the Telegram label afterwards.
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:40:00.000Z", { topicLabel: "Renamed" })]);
    expect(store.getProject(String(created.result.projectId))!.name).toBe("Flights again");
  });

  it("treats a later topic with the same name as a different project and reports ambiguity to name lookups", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [
      seen("2026-09-28T09:00:00.000Z"),
      seen("2026-09-28T09:00:01.000Z", { key: "telegram:42:-1001:99" }),
    ]);
    const listed = run(store, external(), "ListProjects", { channel: "telegram" }).result as { projects: Array<{ name: string; external: { id: string } }> };
    expect(listed.projects.map((project) => project.name)).toEqual(["Trips › Flights", "Trips › Flights"]);
    expect(new Set(listed.projects.map((project) => project.external.id)).size).toBe(2);
  });

  it("scopes project tools on channel turns, excluding web-only tools", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:00:00.000Z")]);
    for (const tool of ["ListTags", "CreateTag", "UpdateConversationTags", "MarkConversationRead", "GetWakeSchedule", "SetWakeSchedule", "ClearWakeSchedule"] as const) {
      expect(() => run(store, external(), tool, {})).toThrowError(expect.objectContaining({ code: "console_tool_unavailable" }));
    }
    const current = store.externalConversationByKey("agent-one", "telegram", FLIGHTS)!;
    const updated = run(store, external(), "UpdateProject", { projectId: current.projectId, context: "Book refundable fares." });
    expect(updated.projects).toEqual([current.projectId]);
    expect(store.externalTurnContext("agent-one", "telegram", FLIGHTS).project?.context).toBe("Book refundable fares.");
    // Another agent's project stays invisible.
    const foreign = store.createProject({ sourceId: "agent-two", name: "Private" });
    expect(() => run(store, external(), "GetProject", { projectId: foreign.id })).toThrowError(expect.objectContaining({ code: "project_not_found" }));
    expect(() => run(store, external({ sourceId: "agent-two" }), "SetConversationProject", { conversationId: current.id, projectId: null }))
      .toThrowError(expect.objectContaining({ code: "thread_not_found" }));
    // A DM turn has no project-capable conversation of its own.
    expect(() => run(store, external({ key: undefined }), "SetConversationProject", { projectId: current.projectId }))
      .toThrowError(expect.objectContaining({ code: "external_conversation_unsupported" }));
    expect(() => run(store, external({ key: undefined }), "CreateProject", { name: "Nope", attachCurrentConversation: true }))
      .toThrowError(expect.objectContaining({ code: "external_conversation_unsupported" }));
    expect(store.listProjects("agent-one")).toHaveLength(1);
  });

  it("lists the channel conversation as an honest descriptor without changing web summaries", async () => {
    const { store } = await openStore();
    const web = store.createThread("agent-one");
    const before = run(store, external({ key: undefined }), "ListConversations", {}).result;
    expect(before).toEqual({ conversations: [expect.objectContaining({ id: web.id })] });
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:00:00.000Z")]);
    const current = store.externalConversationByKey("agent-one", "telegram", FLIGHTS)!;
    const listed = run(store, external(), "ListConversations", { projectId: current.projectId }).result;
    expect(listed).toEqual({
      conversations: [],
      externalConversations: [{ id: current.id, channel: "telegram", title: "Trips › Flights", projectId: current.projectId,
        state: "open", historyAvailable: false, lastSeenAt: expect.any(String), current: true }],
    });
    // Filtered pages that cannot hold a channel conversation stay as before.
    expect(run(store, external(), "ListConversations", { archived: true }).result).toEqual({ conversations: [] });
  });

  it("allows one channel conversation per project beside any number of web chats", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [
      seen("2026-09-28T09:00:00.000Z"),
      seen("2026-09-28T09:00:01.000Z", { key: "telegram:42:-1001:99", topicLabel: "Hotels" }),
    ]);
    const flights = store.externalConversationByKey("agent-one", "telegram", FLIGHTS)!;
    const hotels = store.externalConversationByKey("agent-one", "telegram", "telegram:42:-1001:99")!;
    expect(() => run(store, external(), "SetConversationProject", { conversationId: hotels.id, projectId: flights.projectId }))
      .toThrowError(expect.objectContaining({ code: "project_has_external_conversation" }));
    const moved = run(store, external(), "SetConversationProject", { projectId: null });
    expect(moved.result).toEqual({ conversationId: flights.id, projectId: null, disposition: "applied" });
    expect(run(store, external(), "SetConversationProject", { conversationId: hotels.id, projectId: flights.projectId }).result)
      .toMatchObject({ conversationId: hotels.id, projectId: flights.projectId });
    const chat = store.createThread("agent-one", { projectId: flights.projectId! });
    expect(store.getThread(chat.id)!.projectId).toBe(flights.projectId);
  });

  it("replays a receipt for a repeated operation and refuses a reused identity", async () => {
    const { store } = await openStore();
    const operation = { operationId: "external-receipt-operation-1", tool: "CreateProject" as const, args: { name: "Once" } };
    const first = store.consoleToolOperation(external(), operation);
    expect(store.consoleToolOperation(external(), operation)).toEqual({ ...first, projects: [] });
    expect(store.listProjects("agent-one")).toHaveLength(1);
    expect(() => store.consoleToolOperation(external(), { ...operation, args: { name: "Twice" } }))
      .toThrowError(expect.objectContaining({ code: "operation_conflict" }));
  });

  it("resolves a project to its topic key for the owning process only, refusing unbound and closed projects", async () => {
    const { store } = await openStore();
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:00:00.000Z")]);
    const flights = store.externalConversationByKey("agent-one", "telegram", FLIGHTS)!;
    expect(store.resolveExternalProjectDestination("agent-one", "telegram", flights.projectId!)).toEqual({ key: FLIGHTS, label: "Trips › Flights" });
    expect(() => store.resolveExternalProjectDestination("agent-two", "telegram", flights.projectId!))
      .toThrowError(expect.objectContaining({ code: "project_not_found" }));
    const plain = store.createProject({ sourceId: "agent-one", name: "Web only" });
    expect(() => store.resolveExternalProjectDestination("agent-one", "telegram", plain.id))
      .toThrowError(expect.objectContaining({ code: "project_not_linked" }));
    store.observeExternalConversations("agent-one", "telegram", [seen("2026-09-28T09:05:00.000Z", { state: "closed" })]);
    expect(() => store.resolveExternalProjectDestination("agent-one", "telegram", flights.projectId!))
      .toThrowError(expect.objectContaining({ code: "external_conversation_closed" }));
  });
});

describe("observation parsing", () => {
  it("accepts only consistent, bounded observations and sanitizes labels", () => {
    expect(parseExternalObservation({ key: GENERAL, kind: "main", chatLabel: " Trips‮\n", seenAt: "2026-09-28T09:00:00Z" }))
      .toEqual({ key: GENERAL, kind: "main", chatLabel: "Trips", seenAt: "2026-09-28T09:00:00.000Z" });
    for (const bad of [
      { key: FLIGHTS, kind: "main", seenAt: "2026-09-28T09:00:00Z" },
      { key: "telegram:42:@chat:77", kind: "topic", seenAt: "2026-09-28T09:00:00Z" },
      { key: FLIGHTS, kind: "topic", seenAt: "yesterday" },
      { key: FLIGHTS, kind: "topic", seenAt: "2026-09-28T09:00:00Z", state: "gone" },
      { key: FLIGHTS, kind: "topic", seenAt: "2026-09-28T09:00:00Z", messageThreadId: 77 },
    ]) expect(() => parseExternalObservation(bad)).toThrowError(expect.objectContaining({ code: "invalid_external_conversation" }));
    expect(sanitizeExternalLabel("a".repeat(100), 10)).toBe("a".repeat(10));
  });
});

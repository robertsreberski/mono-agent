import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleToolName, ConsoleToolScope } from "../console-tools.js";
import { createWebConsoleToolClient } from "../notification-client.js";
import { startWebNotificationIngress } from "../notification-ingress.js";
import { WebService, type CreateWebServiceOptions } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const password = "fictional-console-password";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function fixture(attributed = true) {
  const root = await temporaryRoot("web-console-access-");
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const first = fakeDiscoveredAgent();
  const options: CreateWebServiceOptions = { stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [first, { ...first, source: { ...first.source, sourceId: "agent-two", label: "Agent Two" } }],
    fetchImpl: operatorFetch({ turns: () => new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller; } }) }) };
  const service = await WebService.create(options);
  const store = service.store;
  const admin = await store.auth.bootstrap("Morgan", password);
  const a = await store.auth.createUser({ username: "Avery", password, role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password, role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership();
  const create = (principal: typeof a, sourceId = "agent-one") => store.access.run(principal, () => service.createThread(sourceId));
  const own = create(a), hidden = create(b), origin = create(b), wrongAgent = create(admin, "agent-two");
  store.access.run(b, () => service.patchThread(origin.id, { shared: true }));
  const start = () => service.startTurn(origin.id, { text: "Fictional active request" });
  await (attributed ? store.access.run(a, start) : start());
  const turnId = store.activeTurn(origin.id)!.id;
  const scope = { sourceId: "agent-one", threadId: origin.id, turnId };
  // Isolate the enforcement pieces without changing the production startup
  // guard: no enabled WebService.create or browser server is started here.
  Object.assign(options, { multiUser: true });
  await vi.waitFor(() => expect(stream).toBeDefined());
  cleanup.push(async () => { stream?.enqueue(new TextEncoder().encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    stream?.close(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const call = (tool: ConsoleToolName, args: Record<string, unknown> = {}, operationId?: string, bound: ConsoleToolScope = scope) =>
    service.consoleToolOperation(bound, { tool, args, operationId: operationId ?? `fictional-operation-${++sequence}` });
  return { service, store, options, a, b, admin, own, hidden, origin, wrongAgent, scope, call, create };
}

describe("persisted actor console capability enforcement", () => {
  it("scopes list/search/get and participant mutations to the initiating actor, not the shared thread owner", async () => {
    const f = await fixture();
    expect(() => f.service.assertConsoleToolTurn(f.scope)).not.toThrow();
    const list = f.call("ListConversations") as { conversations: Array<{ id: string }> };
    expect(list.conversations.map(({ id }) => id).sort()).toEqual([f.own.id, f.origin.id].sort());
    f.store.patchThread(f.hidden.id, { title: "Fictional secret match" });
    expect(JSON.stringify(f.call("SearchConversations", { query: "secret match" }))).not.toContain(f.hidden.id);
    for (const id of [f.hidden.id, f.wrongAgent.id]) {
      expect(() => f.call("MarkConversationRead", { conversationId: id })).toThrow("not found");
      expect(() => f.call("UpdateConversationTags", { conversationId: id, add: [] })).toThrow("not found");
    }
    const created = f.call("CreateConversation", { title: "Tool-created private" }) as { conversationId: string };
    expect(f.store.access.run(f.a, () => f.store.getThread(created.conversationId))).toMatchObject({ ownerUserId: f.a.id, shared: false });
    expect(f.store.access.run(f.b, () => f.store.getThread(created.conversationId))).toBeUndefined();
    expect(f.store.access.run(f.admin, () => f.store.getThread(created.conversationId))).toBeUndefined();
    expect(f.call("ListTags")).toEqual({ tags: [] });
    expect(f.call("GetWakeSchedule")).toEqual({ schedule: null });
    const tag = f.call("CreateTag", { name: "Participant tag" }) as { tagId: string };
    expect(f.call("UpdateConversationTags", { conversationId: f.origin.id, add: [tag.tagId] })).toMatchObject({ tagIds: [tag.tagId] });
    const wake = f.call("SetWakeSchedule", { kind: "weekly", timezone: "UTC", days: [1], times: ["12:00"], message: "Fictional wake" }) as { schedule: { revision: number } };
    expect(f.call("ClearWakeSchedule", { expectedRevision: wake.schedule.revision })).toEqual({ cleared: true });
  });

  it("rechecks issuance and replay through the actual owner-private HTTP ingress and client", async () => {
    const f = await fixture();
    const ingress = await startWebNotificationIngress(f.service);
    try {
      const options = { stateDir: f.store.paths.root };
      const call = await createWebConsoleToolClient(f.scope, options);
      const operation = { tool: "CreateProject" as const, args: { name: "HTTP shared definition" }, operationId: "fictional-operation-http-replay" };
      const first = await call(operation);
      expect(await call(operation)).toEqual(first);
      expect(await call({ tool: "ListConversations", args: {}, operationId: "fictional-operation-http-list" }))
        .toMatchObject({ conversations: expect.arrayContaining([{ id: f.own.id, title: expect.any(String), projectId: null, tags: [], archived: false, updatedAt: expect.any(String) }]) });
      f.store.auth.patchUser(f.a.id, { grants: [] });
      await expect(call(operation)).rejects.toMatchObject({ code: "console_tool_revoked" });
      await expect(createWebConsoleToolClient(f.scope, options)).rejects.toMatchObject({ code: "console_tool_revoked" });
    } finally { await ingress.stop(); }
  });

  it.each(["disable", "role", "grant"] as const)("revokes issuance/use/replay after %s changes", async (change) => {
    const f = await fixture();
    const operationId = "fictional-operation-revocation";
    f.call("CreateProject", { name: "Shared definition" }, operationId);
    f.store.auth.patchUser(f.a.id, change === "disable" ? { disabled: true } : change === "role" ? { role: "admin" } : { grants: [] });
    expect(() => f.service.assertConsoleToolTurn(f.scope)).toThrow("no longer writable");
    expect(() => f.call("CreateProject", { name: "Shared definition" }, operationId)).toThrow("no longer writable");
  });

  it("rejects unattributed turns and rejects a forged actor scope even for an administrator", async () => {
    const unbound = await fixture(false);
    expect(() => unbound.service.assertConsoleToolTurn(unbound.scope)).toThrow("no longer writable");
    const f = await fixture();
    expect(() => f.store.access.run(f.admin, () => f.store.consoleToolOperation(f.scope,
      { tool: "ListConversations", args: {}, operationId: "fictional-operation-forged" }))).toThrow("no longer writable");
  });

  it("revalidates cached target access and reprojects cached project counts after unsharing", async () => {
    const f = await fixture();
    const project = f.store.createProject({ sourceId: "agent-one", name: "Shared project" });
    for (const thread of [f.own, f.hidden]) f.store.patchThread(thread.id, { projectId: project.id });
    f.store.access.run(f.b, () => f.service.patchThread(f.hidden.id, { shared: true }));
    const operationId = "fictional-operation-project-replay";
    expect(f.call("UpdateProject", { projectId: project.id, name: "Updated" }, operationId)).toMatchObject({ project: { conversationCount: 2 } });
    const readId = "fictional-operation-target-replay";
    f.call("MarkConversationRead", { conversationId: f.hidden.id }, readId);
    f.store.access.run(f.b, () => f.service.patchThread(f.hidden.id, { shared: false }));
    expect(f.call("UpdateProject", { projectId: project.id, name: "Updated" }, operationId)).toMatchObject({ project: { conversationCount: 1 } });
    expect(() => f.call("MarkConversationRead", { conversationId: f.hidden.id }, readId)).toThrow("not found");
    expect(f.store.getThread(f.hidden.id)?.projectId).toBe(project.id);
  });

  it("detaches private definition members without enumerating them in mutation receipts", async () => {
    const f = await fixture();
    const project = f.store.createProject({ sourceId: "agent-one", name: "Detachable definition" });
    const tag = f.store.createTag({ sourceId: "agent-one", name: "Detachable tag" });
    for (const thread of [f.own, f.hidden]) f.store.patchThread(thread.id, { projectId: project.id, tagIds: [tag.id] });
    expect(f.call("DeleteTag", { tagId: tag.id })).toEqual({ tagId: tag.id, deleted: true });
    expect(f.call("DeleteProject", { projectId: project.id })).toEqual({ projectId: project.id, deleted: true });
    expect(f.store.getThread(f.hidden.id)).toMatchObject({ projectId: null, tagIds: [] });
  });

  it("keeps unmapped external capabilities on shared definitions/external channels only", async () => {
    const f = await fixture();
    const external = { kind: "external" as const, sourceId: "agent-one", channel: "telegram" as const, pid: 123, turnKey: "fictional-channel-turn" };
    const invoke = (tool: ConsoleToolName, args: Record<string, unknown> = {}) => f.call(tool, args, undefined, external);
    const project = f.store.createProject({ sourceId: "agent-one", name: "Shared definition" });
    f.store.patchThread(f.hidden.id, { projectId: project.id, title: "Fictional secret match" });
    expect(invoke("ListConversations")).toEqual({ conversations: [] });
    expect(invoke("SearchConversations", { query: "secret match" })).toEqual({ conversations: [], truncated: false });
    expect(invoke("GetProject", { projectId: project.id })).toMatchObject({ project: { conversationCount: 0 } });
    expect(() => invoke("SetConversationProject", { conversationId: f.hidden.id, projectId: project.id })).toThrow("not found");
    expect(() => invoke("CreateConversation", { title: "No web principal" })).toThrow("authenticated web actor");
    expect(invoke("CreateProject", { name: "External shared definition" })).toHaveProperty("projectId");
    expect(invoke("DeleteProject", { projectId: project.id })).toEqual({ projectId: project.id, deleted: true });
    expect(f.store.getThread(f.hidden.id)?.projectId).toBeNull();
    f.store.access.external("agent-one", () => {
      expect(f.store.getThread(f.origin.id)).toBeUndefined(); // even shared web threads
      expect(f.store.getAgent("agent-two")).toBeUndefined();
    });
  });
});

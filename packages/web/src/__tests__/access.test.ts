import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { webAgentAllowed, webThreadVisible } from "../access.js";
import type { WebUser } from "../auth.js";
import type { WebAgentSummary, WebThread } from "../contracts.js";
import { WEB_ACTIVE_THREAD_LIMIT } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
const PASSWORD = "fictional-access-password";
const agent = (sourceId: string): WebAgentSummary => ({
  sourceId, label: sourceId, status: "online", health: "running", supportsAttachments: false,
  models: [], defaultModel: "provider/model", efforts: [], updatedAt: "2026-01-01T00:00:00.000Z",
  runSettings: { config: { model: "provider/model" }, override: null,
    effective: { model: "provider/model", modelSource: "config", effortSource: "config" } },
});
async function fixture() {
  const root = await temporaryRoot("web-access-");
  const store = await WebStore.open({ stateDir: join(root, "state") });
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.replaceAgents([agent("one"), agent("two")]);
  const admin = await store.auth.bootstrap("Morgan", PASSWORD);
  const a = await store.auth.createUser({ username: "Avery", role: "user", password: PASSWORD, grants: ["one"] });
  const b = await store.auth.createUser({ username: "Riley", role: "user", password: PASSWORD, grants: ["one", "two"] });
  store.auth.initializeOwnership();
  const database = (store as unknown as { database: DatabaseSync }).database;
  const create = (user: WebUser, sourceId = "one") => store.access.run(user, () => store.createThread(sourceId));
  const share = (thread: WebThread) => database.prepare("UPDATE threads SET shared = 1 WHERE id = ?").run(thread.id);
  return { store, admin, a, b, database, create, share };
}

describe("principal-aware web selection", () => {
  it("does not let admin authority bypass creator privacy", async () => {
    const { admin, a, b } = await fixture();
    const privateThread = { sourceId: "one", ownerUserId: a.id, shared: false };
    expect(webAgentAllowed(admin, "two")).toBe(true);
    expect(webThreadVisible(admin, privateThread)).toBe(false);
    expect(webThreadVisible(a, privateThread)).toBe(true);
    expect(webThreadVisible(b, privateThread)).toBe(false);
    expect(webThreadVisible(b, { ...privateThread, shared: true })).toBe(true);
    expect(webThreadVisible(a, { ...privateThread, sourceId: "two", shared: true })).toBe(false);
    expect(webThreadVisible({ ...a, disabled: true }, privateThread)).toBe(false);
  });

  it("assigns new human conversations to their creator and projects private/shared state only in scope", async () => {
    const { store, admin, a, b, create, share } = await fixture();
    const thread = create(a);
    expect(thread).toMatchObject({ ownerUserId: a.id, creatorDisplayName: "avery", shared: false });
    for (const principal of [admin, b]) expect(store.access.run(principal, () => store.getThread(thread.id))).toBeUndefined();
    expect(store.access.run(a, () => store.getThread(thread.id))?.id).toBe(thread.id);
    share(thread);
    expect(store.access.run(b, () => store.getThread(thread.id))?.shared).toBe(true);
    const legacyProjection = store.getThread(thread.id)!;
    expect(legacyProjection).not.toHaveProperty("ownerUserId");
    expect(legacyProjection).not.toHaveProperty("shared");
  });

  it("filters aliases, messages, current selection and requested agents without enumeration", async () => {
    const { store, a, b, database, create } = await fixture();
    const privateThread = create(b);
    database.prepare("INSERT INTO thread_redirects(old_thread_id, new_thread_id, created_at) VALUES (?, ?, ?)")
      .run("old-private", privateThread.id, "2026-01-01T00:00:00.000Z");
    const turn = store.beginTurn({ threadId: privateThread.id, text: "Hidden prose", attachmentIds: [] });
    store.completeTurn(turn.turnId, "Hidden answer");
    store.selectThread(privateThread.id);
    store.access.run(a, () => {
      expect(store.getThread("old-private")).toBeUndefined();
      expect(store.currentThreadId()).toBeUndefined();
      expect(store.getMessage(turn.userMessageId)).toBeUndefined();
      expect(() => store.listMessagesPage(privateThread.id)).toThrow("Conversation not found");
      expect(store.getAgent("two")).toBeUndefined();
      expect(store.listAgents().map((item) => item.sourceId)).toEqual(["one"]);
      expect(() => store.listThreadsPage({ sourceId: "two", archived: false })).toThrow("Agent not found");
    });
  });

  it("filters before pagination and FTS snippets/caps, not after private rows consume the page", async () => {
    const { store, a, b, database, create } = await fixture();
    const visible = create(a);
    store.patchThread(visible.id, { title: "Needle visible" });
    const visibleTurn = store.beginTurn({ threadId: visible.id, text: "needletoken visible prose", attachmentIds: [] });
    store.completeTurn(visibleTurn.turnId, "needle answer");
    for (let index = 0; index < 12; index++) {
      const hidden = create(b);
      store.patchThread(hidden.id, { title: `Needle hidden ${index}` });
      const turn = store.beginTurn({ threadId: hidden.id, text: "needletoken private prose", attachmentIds: [] });
      store.completeTurn(turn.turnId, "private answer");
      database.prepare("UPDATE threads SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(hidden.id);
    }
    store.access.run(a, () => {
      const page = store.listThreadsPage({ sourceId: "one", archived: false, limit: 1 });
      expect(page.threads.map((thread) => thread.id)).toEqual([visible.id]);
      expect(page.nextCursor).toBeUndefined();
      const titles = store.searchThreads({ sourceId: "one", query: "Needle", limit: 1 });
      expect(titles.hits.map((hit) => hit.thread.id)).toEqual([visible.id]);
      expect(titles.truncated).toBe(false);
      const prose = store.searchThreads({ sourceId: "one", query: "needletoken", limit: 1 });
      expect(prose.hits.map((hit) => hit.thread.id)).toEqual([visible.id]);
      expect(prose.hits[0]?.snippet).toContain("visible prose");
      expect(JSON.stringify(prose)).not.toContain("private prose");
      expect(prose.truncated).toBe(false);
    });
  });

  it("counts visible active work before the card cap and omits denied-agent count keys", async () => {
    const { store, a, b, create } = await fixture();
    const visibleIds = new Set<string>();
    for (let index = 0; index < WEB_ACTIVE_THREAD_LIMIT + 2; index++) {
      const visible = create(a);
      visibleIds.add(visible.id);
      store.beginTurn({ threadId: visible.id, text: "visible", attachmentIds: [] });
      const hidden = create(b);
      store.beginTurn({ threadId: hidden.id, text: "hidden", attachmentIds: [] });
    }
    const wrongAgent = create(b, "two");
    store.beginTurn({ threadId: wrongAgent.id, text: "wrong agent", attachmentIds: [] });
    store.access.run(a, () => {
      const active = store.listActiveThreads();
      expect(active.total).toBe(visibleIds.size);
      expect(active.threads).toHaveLength(WEB_ACTIVE_THREAD_LIMIT);
      expect(active.threads.every((thread) => visibleIds.has(thread.id))).toBe(true);
      expect(active.runningCounts).toEqual({ one: visibleIds.size });
      expect(active.truncated).toBe(true);
    });
  });

  it("shares project/tag definitions but projects only visible membership, running state and cost", async () => {
    const { store, a, b, create, share, database } = await fixture();
    const project = store.createProject({ sourceId: "one", name: "Shared definition" });
    const tag = store.createTag({ sourceId: "one", name: "Shared tag" });
    const visible = create(a), hidden = create(b);
    for (const thread of [visible, hidden]) store.patchThread(thread.id, { projectId: project.id, tagIds: [tag.id] });
    const turn = store.beginTurn({ threadId: hidden.id, text: "hidden work", attachmentIds: [] });
    store.access.run(a, () => {
      expect(store.getProject(project.id)).toMatchObject({ conversationCount: 1, runningCount: 0 });
      expect(store.getProject(project.id)).not.toHaveProperty("monthUsd");
      expect(store.listTags("one")).toHaveLength(1);
      expect(store.listThreadsPage({ sourceId: "one", archived: false, projectId: project.id }).threads.map((thread) => thread.id)).toEqual([visible.id]);
    });
    share(hidden);
    expect(store.access.run(a, () => store.getProject(project.id))).toMatchObject({ conversationCount: 2, runningCount: 1 });
    database.prepare("UPDATE threads SET shared = 0 WHERE id = ?").run(hidden.id);
    store.applyStreamFrames(turn.turnId, [{ kind: "event", event: { type: "usage_update", cumulativeUsd: 42 } }]);
    store.completeTurn(turn.turnId, "hidden priced output");
    expect(store.getProject(project.id)?.monthUsd).toBe(42);
    expect(store.access.run(a, () => store.getProject(project.id))).not.toHaveProperty("monthUsd");
    const otherProject = store.createProject({ sourceId: "two", name: "Denied definition" });
    const otherTag = store.createTag({ sourceId: "two", name: "Denied tag" });
    store.access.run(a, () => {
      expect(store.getProject(otherProject.id)).toBeUndefined();
      expect(store.getTag(otherTag.id)).toBeUndefined();
    });
  });

  it("permits creator-only sharing while idle, exposes all history, and reserves deletion to the creator", async () => {
    const { store, a, b, admin, create } = await fixture();
    const thread = create(a);
    const turn = store.beginTurn({ threadId: thread.id, text: "Private original history", attachmentIds: [] });
    expect(() => store.access.run(a, () => store.setThreadShared(thread.id, true))).toThrow("idle");
    store.completeTurn(turn.turnId, "Private original answer");
    store.reserveLiveInput(thread.id, "Queued follow-up");
    expect(() => store.access.run(a, () => store.setThreadShared(thread.id, true))).toThrow("idle");
    store.cancelLiveInputs(thread.id);
    store.access.run(a, () => store.setThreadShared(thread.id, true));
    expect(store.access.run(b, () => store.listMessagesPage(thread.id)).messages.map((message) => message.id)).toContain(turn.userMessageId);
    for (const principal of [b, admin]) {
      expect(() => store.access.run(principal, () => store.setThreadShared(thread.id, false))).toThrow("creator");
      await expect(store.access.run(principal, () => store.deleteArchivedThread(thread.id))).rejects.toMatchObject({ status: 403 });
    }
    store.access.run(b, () => store.patchThread(thread.id, { title: "Participant edit", archived: true }));
    store.access.run(a, () => store.setThreadShared(thread.id, false));
    expect(store.access.run(b, () => store.getThread(thread.id))).toBeUndefined();
    expect(store.access.run(admin, () => store.getThread(thread.id))).toBeUndefined();
    await store.access.run(a, () => store.deleteArchivedThread(thread.id));
    expect(store.getThread(thread.id)).toBeUndefined();
  });

  it("detaches shared definitions from private members without returning their identifiers", async () => {
    const { store, a, b, create } = await fixture();
    const own = create(a), hidden = create(b);
    const tag = store.createTag({ sourceId: "one", name: "Shared tag" });
    const project = store.createProject({ sourceId: "one", name: "Shared project" });
    for (const thread of [own, hidden]) store.patchThread(thread.id, { projectId: project.id, tagIds: [tag.id] });
    expect(store.access.run(a, () => store.deleteTag(tag.id))).toEqual([own.id]);
    expect(store.access.run(a, () => store.deleteProject(project.id))).toEqual([own.id]);
    expect(store.getThread(hidden.id)).toMatchObject({ projectId: null, tagIds: [] });
  });

  it("keeps staging uploads uploader-only and follows the thread predicate after attachment", async () => {
    const { store, a, b, admin, create } = await fixture();
    store.replaceAgents([{ ...agent("one"), supportsAttachments: true }, agent("two")]);
    const thread = create(a);
    const upload = store.access.run(a, () => store.createUpload({ name: "fictional.txt", contentType: "text/plain", kind: "document", declaredSize: 1 }));
    store.access.run(a, () => store.markUploadComplete(upload.id, 1));
    for (const principal of [b, admin]) {
      expect(store.access.run(principal, () => store.getStoredAttachment(upload.id))).toBeUndefined();
      await expect(store.access.run(principal, () => store.removeStagedAttachment(upload.id))).rejects.toMatchObject({ status: 404 });
    }
    const turn = store.access.run(a, () => store.beginTurn({ threadId: thread.id, text: "File", attachmentIds: [upload.id] }));
    store.completeTurn(turn.turnId, "Received");
    expect(store.access.run(b, () => store.getStoredAttachment(upload.id))).toBeUndefined();
    store.access.run(a, () => store.setThreadShared(thread.id, true));
    expect(store.access.run(b, () => store.getStoredAttachment(upload.id))?.id).toBe(upload.id);
    expect(store.access.run(admin, () => store.getStoredAttachment(upload.id))?.id).toBe(upload.id);
    store.access.run(a, () => store.setThreadShared(thread.id, false));
    expect(store.access.run(b, () => store.getStoredAttachment(upload.id))).toBeUndefined();
  });

  it("does not bleed principals across overlapping asynchronous operations", async () => {
    const { store, a, b, create } = await fixture();
    const first = create(a), second = create(b);
    const [left, right] = await Promise.all([a, b].map((user) => store.access.run(user, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return store.listThreadsPage({ sourceId: "one", archived: false }).threads.map((thread) => thread.id);
    })));
    expect(left).toEqual([first.id]);
    expect(right).toEqual([second.id]);
    expect(store.access.current()).toBeUndefined();
  });
});

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import express from "express";
import { installWebAuthentication } from "../auth-http.js";
import type { WebPrincipal } from "../auth.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebEvent } from "../contracts.js";
import { subscribeWebRecipient } from "../event-recipient.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const password = "fictional-event-password";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const clean of cleanup.splice(0)) await clean(); });

async function fixture() {
  const root = await temporaryRoot("web-event-access-");
  let now = Date.now();
  const first = fakeDiscoveredAgent();
  const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [first, { ...first, source: { ...first.source, sourceId: "agent-two", label: "Agent Two" } }], fetchImpl: operatorFetch() });
  const store = service.store;
  const admin = await store.auth.bootstrap("Morgan", password);
  const a = await store.auth.createUser({ username: "Avery", password, role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password, role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership();
  const own = store.access.run(a, () => service.createThread("agent-one"));
  const other = store.access.run(b, () => service.createThread("agent-one"));
  const wrong = store.access.run(admin, () => service.createThread("agent-two"));
  const watching: Array<() => void> = [];
  cleanup.push(async () => { for (const close of watching) close(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  const observe = async (user: typeof a) => {
    const { principal } = await store.auth.login(user.username, password, user.id);
    const events: WebEvent[] = [];
    let closed = 0;
    const recipient = subscribeWebRecipient(service, principal, (event) => { events.push(event); }, () => { closed += 1; });
    watching.push(recipient.close);
    return { events, recipient, principal, closed: () => closed };
  };
  return { service, store, admin, a, b, own, other, wrong, observe, advance: (ms: number) => { now += ms; } };
}

const named = (events: WebEvent[], id: string) => events.filter((event) => event.threadId === id);

describe("recipient-specific event projection", () => {
  it("filters private and denied-agent events including against admins, and sends minimal ready", async () => {
    const f = await fixture();
    const a = await f.observe(f.a), b = await f.observe(f.b), admin = await f.observe(f.admin);
    for (const viewer of [a, b, admin]) viewer.recipient.send({ ...f.service.readyEvent(), payload: { privateTitle: "Fictional secret", version: 1 } });
    expect(a.events[0]?.payload).toEqual({ version: 1 });
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { title: "Fictional private title" }));
    f.store.access.run(f.b, () => f.service.patchThread(f.other.id, { title: "Other fictional private title" }));
    f.service.patchThread(f.wrong.id, { title: "Denied agent title" });
    expect(named(a.events, f.own.id)).toHaveLength(2);
    expect(named(a.events, f.other.id)).toHaveLength(0);
    expect(named(a.events, f.wrong.id)).toHaveLength(0);
    expect(named(admin.events, f.own.id)).toHaveLength(0);
    expect(named(admin.events, f.other.id)).toHaveLength(0);
    expect(JSON.stringify(b.events)).not.toContain("Fictional private title");
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { title: "Another visible update" }));
    expect(a.events.map((event) => Number(event.id.split("-").at(-1)))).toEqual([1, 2, 3, 4, 5]);
  });

  it("sends fresh shared summaries, then content-free tombstones only to prior viewers", async () => {
    const f = await fixture();
    const a = await f.observe(f.a), b = await f.observe(f.b), admin = await f.observe(f.admin);
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { shared: true }));
    expect(named(b.events, f.own.id)[0]?.payload).toMatchObject({ thread: { shared: true, ownerUserId: f.a.id } });
    b.events.length = 0; admin.events.length = 0;
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { shared: false }));
    for (const event of [...b.events, ...admin.events]) expect(event.payload).toEqual({ threadId: f.own.id, removed: true });
    expect(named(a.events, f.own.id).at(-1)?.payload).toMatchObject({ thread: { shared: false } });
    const isolated = f.store.access.run(f.a, () => f.service.createThread("agent-one"));
    f.store.access.run(f.a, () => f.service.patchThread(isolated.id, { archived: true }));
    b.events.length = 0; admin.events.length = 0;
    await f.store.access.run(f.a, () => f.service.deleteThread(isolated.id));
    expect(b.events).toEqual([]); expect(admin.events).toEqual([]);
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { shared: true }));
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { archived: true }));
    b.events.length = 0;
    await f.store.access.run(f.a, () => f.service.deleteThread(f.own.id));
    expect(b.events).toHaveLength(2);
    for (const event of b.events) expect(event.payload).toEqual({ threadId: f.own.id, removed: true });
  });

  it("recomputes project aggregates for each viewer and restricts definition removal to its source", async () => {
    const f = await fixture();
    const project = f.service.createProject({ sourceId: "agent-one", name: "Shared definition" });
    for (const thread of [f.own, f.other]) f.store.patchThread(thread.id, { projectId: project.id });
    const a = await f.observe(f.a), admin = await f.observe(f.admin);
    f.service.patchProject(project.id, { context: "Shared context" });
    expect(a.events[0]?.payload).toMatchObject({ project: { conversationCount: 1 } });
    expect(admin.events[0]?.payload).toMatchObject({ project: { conversationCount: 0 } });
    f.service.deleteProject(project.id);
    expect(a.events.at(-1)?.payload).toEqual({ projectId: project.id, removed: true });
    const denied = f.service.createTag({ sourceId: "agent-two", name: "Denied definition" });
    a.events.length = 0;
    f.service.deleteTag(denied.id);
    expect(a.events).toEqual([]);
  });

  it("keeps uploads uploader-only and does not replay producer-session delta credentials", async () => {
    const f = await fixture();
    const a = await f.observe(f.a), b = await f.observe(f.b), admin = await f.observe(f.admin);
    const upload = f.store.access.run(f.a, () => f.service.createUpload({ name: "fictional.txt", contentType: "text/plain", sizeBytes: 1 }));
    expect(a.events[0]?.payload).toMatchObject({ attachment: { id: upload.id } });
    expect(b.events).toEqual([]); expect(admin.events).toEqual([]);
    await f.store.access.run(f.a, () => f.service.removeUpload(upload.id));
    expect(a.events.at(-1)?.payload).toEqual({ attachmentId: upload.id, removed: true });
    expect(b.events).toEqual([]);
    f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { shared: true }));
    const turn = f.store.access.run(f.a, () => f.store.beginTurn({ threadId: f.own.id, text: "Fictional text", attachmentIds: [] }));
    const delta = { ...f.service.readyEvent(), type: "message.delta" as const, threadId: f.own.id,
      payload: { messageId: turn.assistantMessageId, seq: 2, ops: [{ op: "set", index: 0, part: { contentUrl: "fictional-producer-session-credential" } }] } };
    b.events.length = 0;
    b.recipient.send(delta);
    expect(b.events[0]).toMatchObject({ type: "message.changed", payload: { messageId: turn.assistantMessageId, deltaDeclined: true } });
    expect(JSON.stringify(b.events)).not.toContain("producer-session-credential");
    f.store.completeTurn(turn.turnId, "Done");
  });

  it.each(["logout", "disable", "role", "grant", "password"] as const)("closes immediately on %s and never emits another private frame", async (change) => {
    const f = await fixture();
    const a = await f.observe(f.a);
    if (change === "logout") f.store.auth.revokeSession(a.principal.sessionHash);
    else if (change === "password") await f.store.auth.resetPassword(f.a.id, "fictional-new-password");
    else f.store.auth.patchUser(f.a.id, change === "disable" ? { disabled: true } : change === "role" ? { role: "admin" } : { grants: [] });
    expect(a.closed()).toBe(1);
    expect(a.recipient.send(f.service.readyEvent())).toBe(false);
    expect(a.events).toEqual([]);
  });

  it("projects before HTTP serialization and ends the live response on authenticated logout", async () => {
    const f = await fixture();
    const app = express();
    installWebAuthentication(app, f.store, { enabled: true });
    app.get("/api/v1/events", (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", res.locals.webMultiUser ? "private, no-store" : "no-cache");
      res.flushHeaders();
      const recipient = subscribeWebRecipient(f.service, f.store.access.requirePrincipal() as WebPrincipal,
        (event) => res.write(`data: ${JSON.stringify(event)}\n\n`), () => res.end());
      res.once("close", recipient.close);
      recipient.send(f.service.readyEvent());
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No test listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const { token } = await f.store.auth.login(f.b.username, password, "fictional-http");
    const cookie = `mono_web_session=${token}`;
    try {
      const response = await fetch(`${origin}/api/v1/events`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const reader = response.body!.getReader();
      const ready = new TextDecoder().decode((await reader.read()).value);
      expect(ready).toContain('"type":"ready"');
      f.store.access.run(f.a, () => f.service.patchThread(f.own.id, { title: "Fictional private title" }));
      f.store.access.run(f.b, () => f.service.patchThread(f.other.id, { title: "Visible update" }));
      const update = new TextDecoder().decode((await reader.read()).value);
      expect(update).toContain("Visible update");
      expect(update).not.toContain("Fictional private title");
      const logout = await fetch(`${origin}/api/v1/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin } });
      expect(logout.status).toBe(204);
      let done = false;
      while (!done) done = (await reader.read()).done;
      expect(done).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes an otherwise idle stream when its session expires", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const a = await f.observe(f.a);
    f.advance(8 * 24 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.closed()).toBe(1);
    expect(a.events).toEqual([]);
  });
});

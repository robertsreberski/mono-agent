import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WebService, type CreateWebServiceOptions } from "../service.js";
import { WebStore } from "../store.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const password = "fictional-actor-password";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function fixture(input: { modern?: boolean; held?: boolean; enabled?: boolean } = {}) {
  const root = await temporaryRoot("web-actor-dispatch-");
  const bodies: Array<Record<string, unknown>> = [];
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  let steers = 0;
  const options: CreateWebServiceOptions = { stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: operatorFetch({ supportsWebActor: input.modern !== false,
      supportsLiveInput: true, supportsLiveInputTargeting: true,
      onTurn: (body) => { bodies.push(body); },
      onLiveInput: () => { steers += 1; return { status: "applied" }; },
      turns: () => input.held ? new ReadableStream<Uint8Array>({ start: (controller) => { streams.push(controller); } })
        : `${JSON.stringify({ kind: "finish", finalText: "Done" })}\n` }) };
  const service = await WebService.create(options);
  const store = service.store;
  const admin = await store.auth.bootstrap("Morgan", password);
  const a = await store.auth.createUser({ username: "Avery", password, role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password, role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership();
  Object.assign(options, { multiUser: input.enabled !== false }); // isolated guarded-service components, not enabled startup
  const create = (principal = a) => store.access.run(principal, () => service.createThread("agent-one"));
  const finish = () => {
    const stream = streams.shift();
    stream?.enqueue(new TextEncoder().encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`)); stream?.close();
  };
  cleanup.push(async () => { while (streams.length) finish(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, store, options, a, b, admin, bodies, streams, create, finish, steers: () => steers };
}

describe("authenticated human operator dispatch", () => {
  it.each(["user", "admin"] as const)("sends the server-derived %s actor and exposes only scoped human sender snapshots", async (role) => {
    const f = await fixture();
    const user = role === "admin" ? f.admin : f.a;
    const thread = f.create(user);
    await f.store.access.run(user, () => f.service.startTurn(thread.id, { text: "Fictional request" }));
    await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
    expect(f.bodies[0]?.webActor).toEqual({ schema: 1, role, sender: { id: user.id, displayName: user.displayName, handle: user.username } });
    const message = f.store.access.run(user, () => f.store.listMessagesPage(thread.id)).messages.find((entry) => entry.role === "user");
    expect(message?.sender).toEqual({ id: user.id, displayName: user.displayName, handle: user.username });
    expect(f.store.listMessagesPage(thread.id).messages.find((entry) => entry.role === "user")).not.toHaveProperty("sender");
  });

  it("rejects older agents before accepting human input and projects their threads read-only", async () => {
    const f = await fixture({ modern: false });
    const thread = f.create();
    expect(thread).toMatchObject({ canSend: false, canUpload: false });
    await expect(f.store.access.run(f.a, () => f.service.startTurn(thread.id, { text: "No legacy-owner fallback" }))).rejects.toMatchObject({ code: "web_actor_unsupported" });
    expect(() => f.store.access.run(f.a, () => f.service.submit(thread.id, { submissionId: "fictional-submission-old-agent", text: "No fallback" })))
      .toThrow("read-only");
    expect(f.bodies).toEqual([]);
    expect(f.store.listMessagesPage(thread.id).messages).toEqual([]);
  });

  it("queues shared follow-ups and dispatches the queued participant's immutable actor snapshot", async () => {
    const f = await fixture({ held: true });
    const thread = f.create();
    f.store.access.run(f.a, () => f.service.patchThread(thread.id, { shared: true }));
    await f.store.access.run(f.a, () => f.service.startTurn(thread.id, { text: "First" }));
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const receipt = f.store.access.run(f.b, () => f.service.submitLiveInput(thread.id, "Fictional follow-up"));
    expect(receipt.disposition).toBe("queued"); expect(f.steers()).toBe(0);
    f.store.auth.patchUser(f.b.id, { displayName: "Updated fictional name" });
    f.finish();
    await vi.waitFor(() => expect(f.bodies).toHaveLength(2));
    expect(f.bodies[1]?.webActor).toEqual({ schema: 1, role: "user", sender: { id: f.b.id, displayName: f.b.displayName, handle: f.b.username } });
    f.finish();
  });

  it.each(["disable", "grant", "role"] as const)("visibly cancels a queued request after %s loss without dispatch or role upgrade", async (change) => {
    const f = await fixture({ held: true });
    const thread = f.create();
    f.store.access.run(f.a, () => f.service.patchThread(thread.id, { shared: true }));
    await f.store.access.run(f.a, () => f.service.startTurn(thread.id, { text: "First" }));
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const queued = f.store.access.run(f.b, () => f.service.submitLiveInput(thread.id, "Will not dispatch"));
    f.store.auth.patchUser(f.b.id, change === "disable" ? { disabled: true } : change === "grant" ? { grants: [] } : { role: "admin" });
    f.finish();
    await vi.waitFor(() => expect(f.store.getMessage(queued.message.id)?.liveInputStatus).toBe("cancelled"));
    expect(f.bodies).toHaveLength(1);
  });

  it("retains queued actor identity through storage recovery and promotion", async () => {
    const f = await fixture({ held: true });
    const thread = f.create();
    f.store.access.run(f.a, () => f.service.patchThread(thread.id, { shared: true }));
    await f.store.access.run(f.a, () => f.service.startTurn(thread.id, { text: "First" }));
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.store.access.run(f.b, () => f.service.submitLiveInput(thread.id, "After restart"));
    const stateDir = f.store.paths.root;
    const stopping = f.service.stop(); f.finish(); await stopping;
    const reopened = await WebStore.open({ stateDir });
    try {
      expect(reopened.nextQueuedLiveInput(thread.id)?.webActor?.sender.id).toBe(f.b.id);
      const promoted = reopened.promoteNextQueuedLiveInput(thread.id)!;
      expect(reopened.turnWebActor(promoted.turnId)).toEqual({ schema: 1, role: "user", sender: { id: f.b.id, displayName: f.b.displayName, handle: f.b.username } });
      reopened.completeTurn(promoted.turnId, "Recovered");
    } finally { reopened.close(); }
  });

  it("keeps private live steering for the same actor and role", async () => {
    const f = await fixture({ held: true });
    const thread = f.create();
    await f.store.access.run(f.a, () => f.service.startTurn(thread.id, { text: "First" }));
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    expect(f.store.access.run(f.a, () => f.service.submitLiveInput(thread.id, "Private follow-up")).disposition).toBe("pending");
    await vi.waitFor(() => expect(f.steers()).toBe(1));
    f.finish();
  });

  it("binds submission replay to actor even when the original conversation is shared", async () => {
    const f = await fixture({ held: true });
    const thread = f.create();
    f.store.access.run(f.a, () => f.service.patchThread(thread.id, { shared: true }));
    const input = { submissionId: "fictional-submission-identity", text: "Fictional request" };
    const first = f.store.access.run(f.a, () => f.service.submit(thread.id, input));
    expect(f.store.access.run(f.a, () => f.service.submit(thread.id, input))).toEqual(first);
    expect(() => f.store.access.run(f.b, () => f.service.submit(thread.id, input))).toThrow("not found");
    expect(() => f.store.access.run(f.b, () => f.service.submission(thread.id, input.submissionId))).toThrow("not found");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.finish();
  });

  it("sends no webActor and permits legacy agents when the mode is off", async () => {
    const f = await fixture({ modern: false, enabled: false });
    const thread = f.service.createThread("agent-one");
    await f.service.startTurn(thread.id, { text: "Legacy request" });
    await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
    expect(f.bodies[0]).not.toHaveProperty("webActor");
  });
});

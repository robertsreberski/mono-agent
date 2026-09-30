import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebService, type CreateWebServiceOptions } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(modern = true) {
  const root = await temporaryRoot("web-wake-access-");
  let now = Date.parse("2027-01-02T09:59:00Z");
  const bodies: Array<Record<string, unknown>> = [];
  const options: CreateWebServiceOptions = { stateDir: join(root, "state"), clock: () => new Date(now), discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()], fetchImpl: operatorFetch({ supportsWebActor: true, supportsWebAutomation: modern, onTurn: (body) => { bodies.push(body); } }) };
  const service = await WebService.create(options);
  const store = service.store;
  const admin = await store.auth.bootstrap("Morgan", "fictional-wake-password");
  const owner = await store.auth.createUser({ username: "Avery", password: "fictional-wake-password", role: "user", grants: ["agent-one"] });
  const editor = await store.auth.createUser({ username: "Riley", password: "fictional-wake-password", role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership(); Object.assign(options, { multiUser: true });
  const thread = store.access.run(owner, () => service.createThread("agent-one"));
  store.access.run(owner, () => service.patchThread(thread.id, { shared: true }));
  const schedule = (user = editor) => store.access.run(user, () => service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00", message: "Fictional wake" }));
  const fire = () => { now += 60_000; (service as unknown as { dispatchWakes(): void }).dispatchWakes(); };
  cleanups.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, store, admin, owner, editor, thread, bodies, schedule, fire };
}

describe("wake editor authority and automation provenance", () => {
  it.each(["admin", "user"] as const)("dispatches %s editor as a scoped non-human execution without a human message", async (role) => {
    const f = await fixture(); const editor = role === "admin" ? f.admin : f.editor;
    f.schedule(editor); expect(f.store.wakeEditor(f.thread.id)).toBe(editor.id);
    f.fire(); await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
    expect(f.bodies[0]?.webAutomation).toEqual({ schema: 1 });
    expect(f.bodies[0]?.webActor).toEqual({ schema: 1, role, sender: { id: editor.id, displayName: editor.displayName, handle: editor.username } });
    await vi.waitFor(() => expect(f.store.getThread(f.thread.id)?.runState.status).toBe("complete"));
    const messages = f.store.access.run(editor, () => f.store.listMessagesPage(f.thread.id)).messages;
    expect(messages).toHaveLength(1); expect(messages[0]?.role).toBe("assistant"); expect(messages[0]).not.toHaveProperty("sender");
    expect(f.store.turnWebActor(messages[0]!.turnId!)?.sender.id).toBe(editor.id);
    expect(f.store.getThread(f.thread.id)?.ownerUserId).toBeUndefined(); // unscoped legacy DTO omits ownership
    expect(f.store.access.run(f.owner, () => f.store.getThread(f.thread.id))?.ownerUserId).toBe(f.owner.id);
  });

  it.each(["disabled", "grants", "unshared"] as const)("suspends a schedule after editor access is %s", async (change) => {
    const f = await fixture(); f.schedule();
    if (change === "unshared") f.store.access.run(f.owner, () => f.service.patchThread(f.thread.id, { shared: false }));
    else f.store.auth.patchUser(f.editor.id, change === "disabled" ? { disabled: true } : { grants: [] });
    f.fire(); expect(f.store.wakeSchedule(f.thread.id)).toMatchObject({ state: "paused", lastOutcome: "skipped", nextFireAt: null });
    expect(f.bodies).toEqual([]);
  });

  it("suspends on old agents instead of sending an implicit legacy owner turn", async () => {
    const f = await fixture(false); f.schedule(); f.fire();
    expect(f.store.wakeSchedule(f.thread.id)?.state).toBe("paused"); expect(f.bodies).toEqual([]);
  });

  it("records the resuming participant as editor and rechecks after asynchronous claim", async () => {
    const f = await fixture(); const schedule = f.schedule();
    f.store.access.run(f.owner, () => f.service.changeWakeSchedule(f.thread.id, schedule.revision, { state: "paused" }));
    const paused = f.store.wakeSchedule(f.thread.id)!;
    f.store.access.run(f.owner, () => f.service.changeWakeSchedule(f.thread.id, paused.revision, { state: "active" }));
    expect(f.store.wakeEditor(f.thread.id)).toBe(f.owner.id);
    f.fire(); f.store.auth.patchUser(f.owner.id, { disabled: true });
    await vi.waitFor(() => expect(f.store.getThread(f.thread.id)?.runState.status).toBe("failed"));
    expect(f.store.wakeSchedule(f.thread.id)?.state).toBe("paused"); expect(f.bodies).toEqual([]);
  });
});

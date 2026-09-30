import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebService, type CreateWebServiceOptions } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
const snapshot = { interactionId: "fictional-private-interaction", questions: [{ id: "q", header: "Fictional private heading", question: "Fictional private question", options: [], multiSelect: false }],
  answers: [], activeQuestionIndex: 0, status: "pending", createdAt: "2027-01-02T10:00:00Z", expiresAt: null };
async function fixture() {
  const root = await temporaryRoot("web-ask-access-");
  const asks = new Map<string, Record<string, unknown> | null>();
  let exactCalls = 0; let submissions = 0; let beforePending: (() => void) | undefined;
  const base = operatorFetch({ supportsAskUser: true, supportsAskById: true, exactAsks: { [snapshot.interactionId]: snapshot }, onAskSubmit: () => { submissions += 1; } });
  const options: CreateWebServiceOptions = { stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/interactions/")) exactCalls += 1;
      const match = /\/v1\/conversations\/([^/]+)\/ask$/u.exec(url);
      if (match !== null && init?.method !== "POST") {
        beforePending?.(); return Response.json({ ask: asks.get(decodeURIComponent(match[1]!)) ?? null });
      }
      return base(input, init);
    } };
  const service = await WebService.create(options); const store = service.store;
  await store.auth.bootstrap("Morgan", "fictional-ask-password");
  const a = await store.auth.createUser({ username: "Avery", password: "fictional-ask-password", role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password: "fictional-ask-password", role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership(); Object.assign(options, { multiUser: true });
  const privateThread = store.access.run(a, () => service.createThread("agent-one"));
  const other = store.access.run(b, () => service.createThread("agent-one"));
  asks.set(`web:${privateThread.id}`, snapshot);
  cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, store, a, b, privateThread, other, asks, exactCalls: () => exactCalls, submissions: () => submissions,
    beforePending: (callback: () => void) => { beforePending = callback; } };
}

describe("AskUser thread association and async access", () => {
  it("does not fetch or answer another private conversation's known interaction id using a visible thread", async () => {
    const f = await fixture();
    await expect(f.store.access.run(f.b, () => f.service.ask(f.other.id, snapshot.interactionId))).rejects.toMatchObject({ code: "interaction_not_found", status: 404 });
    await expect(f.store.access.run(f.b, () => f.service.submitAsk(f.other.id, snapshot.interactionId, []))).rejects.toMatchObject({ code: "interaction_not_found" });
    expect(f.exactCalls()).toBe(0); expect(f.submissions()).toBe(0);
    expect(await f.store.access.run(f.a, () => f.service.pendingAsk(f.privateThread.id))).toEqual(snapshot);
    expect(await f.store.access.run(f.a, () => f.service.ask(f.privateThread.id, snapshot.interactionId))).toEqual(snapshot);
    f.asks.set(`web:${f.privateThread.id}`, null); // terminal snapshots remain bound to their original conversation
    expect(await f.store.access.run(f.a, () => f.service.ask(f.privateThread.id, snapshot.interactionId))).toEqual(snapshot);
    await expect(f.store.access.run(f.b, () => f.service.ask(f.other.id, snapshot.interactionId))).rejects.toMatchObject({ code: "interaction_not_found" });
  });

  it("rechecks grant/account state before publishing an asynchronous pending snapshot", async () => {
    const f = await fixture();
    f.beforePending(() => f.store.auth.patchUser(f.a.id, { grants: [] }));
    await expect(f.store.access.run(f.a, () => f.service.pendingAsk(f.privateThread.id))).rejects.toMatchObject({ code: "authentication_required" });
    expect(f.store.askBelongsToThread("agent-one", f.privateThread.id, snapshot.interactionId)).toBe(false);
  });
});

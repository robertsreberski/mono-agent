import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_MAX_CONCURRENT_UPLOADS, WEB_MAX_STAGED_UPLOADS } from "../contracts.js";
import { WebConsoleError } from "../errors.js";
import { WebService, type CreateWebServiceOptions } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
async function fixture() {
  const root = await temporaryRoot("web-review-edges-");
  let onCompact: (() => void) | undefined;
  const options: CreateWebServiceOptions = { stateDir: join(root, "state"), discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: operatorFetch({ supportsWebActor: true, supportsManualCompaction: true, onCompact: () => { onCompact?.(); return { status: "succeeded", trigger: "manual", operationId: "fictional-compaction", tokensBefore: 1000, tokensAfter: 200 }; } }) };
  const service = await WebService.create(options); const store = service.store;
  await store.auth.bootstrap("Morgan", "fictional-review-password");
  const a = await store.auth.createUser({ username: "Avery", password: "fictional-review-password", role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password: "fictional-review-password", role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership(); Object.assign(options, { multiUser: true });
  cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, store, a, b, onCompact: (callback: () => void) => { onCompact = callback; } };
}
describe("review privacy and durable outcome edges", () => {
  it("isolates count, bytes and active reservations between upload principals", async () => {
    const f = await fixture(); const reservations: Array<{ release(): void }> = [];
    try {
      const uploads = f.store.access.run(f.a, () => Array.from({ length: WEB_MAX_STAGED_UPLOADS }, () => f.service.createUpload({ name: "fictional.txt", contentType: "text/plain", sizeBytes: 1 })));
      expect(() => f.store.access.run(f.a, () => f.service.createUpload({ name: "extra.txt", contentType: "text/plain" }))).toThrow("quota");
      for (const upload of uploads.slice(0, WEB_MAX_CONCURRENT_UPLOADS)) reservations.push(f.store.access.run(f.a, () => f.service.reserveUpload(upload.id)));
      const other = f.store.access.run(f.b, () => f.service.createUpload({ name: "other.txt", contentType: "text/plain", sizeBytes: 1 }));
      reservations.push(f.store.access.run(f.b, () => f.service.reserveUpload(other.id)));
      expect(f.store.access.run(f.b, () => f.store.stagedUploadUsage())).toEqual({ count: 1, bytes: 1 });
    } finally { for (const reservation of reservations) reservation.release(); }
  });
  it("does not identify hidden active membership in a project change error", async () => {
    const f = await fixture();
    const project = f.store.access.run(f.a, () => f.store.createProject({ sourceId: "agent-one", name: "Fictional shared project" }));
    const thread = f.store.access.run(f.a, () => f.service.createThread("agent-one", { projectId: project.id }));
    const turn = f.store.access.run(f.a, () => f.store.beginTurn({ threadId: thread.id, text: "Fictional private work", attachmentIds: [] }));
    try { expect(() => f.store.access.run(f.b, () => f.store.deleteProject(project.id))).toThrow("cannot be changed right now"); }
    finally { f.store.completeTurn(turn.turnId, "Done"); }
  });

  it.each([false, true])("persists compaction outcome when requester is revoked (failure=%s)", async (failure) => {
    const f = await fixture(); const thread = f.store.access.run(f.a, () => f.service.createThread("agent-one"));
    f.store.access.run(f.a, () => f.service.patchThread(thread.id, { shared: true }));
    f.onCompact(() => { f.store.auth.patchUser(f.a.id, { disabled: true }); if (failure) throw new WebConsoleError("compaction_failed", "Fictional failure", 502); });
    await expect(f.store.access.run(f.a, () => f.service.compactThread(thread.id))).rejects.toMatchObject({ code: "authentication_required" });
    const markers = f.store.access.run(f.b, () => f.store.listMessagesPage(thread.id)).messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "conversation-marker" && part.kind === "compaction");
    expect(markers).toHaveLength(1); expect(markers[0]).toMatchObject({ status: failure ? "failed" : "succeeded" });
  });
});

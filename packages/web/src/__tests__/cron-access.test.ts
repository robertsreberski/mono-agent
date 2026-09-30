import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const password = "fictional-cron-password";
const run = { projection: "summary", runId: "private-run", jobId: "digest", sequence: 1, trigger: "scheduled",
  status: "failed", scheduledAt: "2026-01-01T00:00:00.000Z", orderedAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0, text: "Fictional private digest", error: "Fictional private failure", artifactRunId: "private-artifact" };
const job = { jobId: "digest", conversationId: "private-cron-channel", configured: true, declaredEnabled: true,
  effectiveEnabled: true, expression: "0 9 * * *", timezone: "UTC", health: "unhealthy", lastRun: run, activeRunId: "private-active" };
const overview = { generatedAt: "2026-01-01T00:00:00.000Z", actionsEnabled: true, jobs: [job], degradedReason: "Fictional private diagnostic" };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function fixture() {
  const root = await temporaryRoot("web-cron-access-");
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let imports = 0;
  let mutate: "completed" | "confirmation_required" = "completed";
  const transport = operatorFetch({ cronOverview: overview, cronRuns: { runs: [run] },
    cronRun: { ...run, projection: "detail", events: [], eventsIncluded: 0 }, supportsContextImport: true,
    onContextImport: async (conversationId) => { imports += 1; await gate; return { imported: true, status: "appended", conversationId }; },
    onCronMutation: (url) => mutate === "confirmation_required"
      ? { kind: "confirmation_required", confirmation: { token: "fictional-confirmation", expiresAt: "2090-01-01T00:00:00.000Z", message: "Fictional private diagnostic" } }
      : { kind: "completed", replayed: false, value: url.endsWith("/run") ? { run } : { job } },
  });
  const service = await WebService.create({ stateDir: join(root, "state"), discoverImpl: async () => [fakeDiscoveredAgent()],
    discoveryIntervalMs: 0, purgeIntervalMs: 0, fetchImpl: async (...args) => { await gate; return transport(...args); } });
  const store = service.store;
  const admin = await store.auth.bootstrap("Morgan", password);
  const a = await store.auth.createUser({ username: "Avery", password, role: "user", grants: ["agent-one"] });
  const b = await store.auth.createUser({ username: "Riley", password, role: "user", grants: ["agent-one"] });
  store.auth.initializeOwnership();
  const channel = store.access.internal(() => store.cronThread("agent-one", "digest"))!;
  cleanup.push(async () => { release?.(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, store, admin, a, b, channel, imports: () => imports, confirm: () => { mutate = "confirmation_required"; },
    pause: () => { gate = new Promise<void>((resolve) => { release = resolve; }); }, resume: () => { release?.(); gate = undefined; } };
}

describe("principal-scoped cron definitions and results", () => {
  it("keeps shared definitions but omits all private channel/output fields, online and offline", async () => {
    const f = await fixture();
    const privateOverview = await f.store.access.run(f.a, () => f.service.cronOverview("agent-one"));
    expect(privateOverview.jobs).toEqual([{ jobId: "digest", configured: true, declaredEnabled: true, effectiveEnabled: true,
      expression: "0 9 * * *", timezone: "UTC", health: "unhealthy", resultsPrivate: true }]);
    expect(privateOverview).not.toHaveProperty("degradedReason");
    for (const word of ["private-run", "private-cron-channel", "private-active", "private-artifact", "private digest", "private failure"]) {
      expect(JSON.stringify(privateOverview)).not.toContain(word);
    }
    await expect(f.store.access.run(f.a, () => f.service.cronRuns("agent-one", "digest", { limit: 1 }))).rejects.toMatchObject({ status: 404 });
    await expect(f.store.access.run(f.a, () => f.service.cronRun("agent-one", "digest", run.runId))).rejects.toMatchObject({ status: 404 });
    expect(() => f.store.access.run(f.a, () => f.store.storedCronRuns("agent-one", "digest"))).toThrow("not found");
    expect(() => f.store.access.run(f.a, () => f.store.captureCronReplySnapshot("agent-one", "digest", run.runId, "summary"))).toThrow("not found");
    f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: true }));
    expect((await f.store.access.run(f.a, () => f.service.cronOverview("agent-one"))).jobs[0]).toMatchObject({ threadId: f.channel.id, lastRun: { text: run.text } });
    await expect(f.store.access.run(f.a, () => f.service.cronRuns("agent-one", "digest", { limit: 1 }))).resolves.toMatchObject({ runs: [{ runId: run.runId }] });
    f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: false }));
    // Offline uses the same projection, not an unfiltered persisted fallback.
    (f.service as unknown as { connections: Map<string, unknown> }).connections.clear();
    expect((await f.store.access.run(f.a, () => f.service.cronOverview("agent-one"))).jobs[0]).not.toHaveProperty("threadId");
    expect((await f.service.cronOverview("agent-one")).jobs[0]).toHaveProperty("threadId", f.channel.id);
    expect(f.store.getThread(f.channel.id)?.ownerUserId).toBeUndefined(); // legacy DTO shape
    expect(f.store.access.run(f.admin, () => f.store.getThread(f.channel.id))?.ownerUserId).toBe(f.admin.id);
  });

  it("returns control acknowledgements and generic confirmation text without private run snapshots", async () => {
    const f = await fixture();
    for (const action of [() => f.service.cronRunNow("agent-one", "digest", { idempotencyKey: "fictional-control-one" }),
      () => f.service.cronSetEffectiveEnabled("agent-one", "digest", false, { idempotencyKey: "fictional-control-two" })]) {
      expect(await f.store.access.run<Promise<unknown>>(f.a, action)).toEqual({ kind: "completed", replayed: false, value: { acknowledged: true, jobId: "digest" } });
    }
    expect(f.store.access.run(f.admin, () => f.store.getThread(f.channel.id))?.ownerUserId).toBe(f.admin.id);
    f.confirm();
    expect(await f.store.access.run(f.a, () => f.service.cronRunNow("agent-one", "digest", { idempotencyKey: "fictional-control-three" })))
      .toMatchObject({ kind: "confirmation_required", confirmation: { message: "Confirm this cron control action." } });
  });

  it.each(["cronOverview", "cronConfigView"] as const)("rechecks sessions after asynchronous %s before publishing or reconciling", async (method) => {
    const f = await fixture();
    const { principal } = await f.store.auth.login(f.a.username, password, "fictional-remote");
    f.pause();
    const pending = f.store.access.run<Promise<unknown>>(principal, () => f.service[method]("agent-one"));
    f.store.auth.revokeSession(principal.sessionHash);
    f.resume();
    await expect(pending).rejects.toMatchObject({ status: 401 });
  });

  it("settles a canonical import before refusing a requester who lost channel visibility", async () => {
    const f = await fixture();
    f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: true }));
    await f.store.access.run(f.a, () => f.service.cronRuns("agent-one", "digest", { limit: 1 }));
    f.pause();
    const input = { operationId: "fictional-reply-operation-revoked", snapshotKind: "summary" as const };
    const pending = f.store.access.run(f.a, () => f.service.createCronReplyThread("agent-one", "digest", run.runId, input));
    f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: false }));
    f.resume();
    await expect(pending).rejects.toMatchObject({ status: 404 });
    expect(f.store.cronReplyOperation(input.operationId)?.kind).toBe("completed");
    expect(f.store.listThreadsPage({ sourceId: "agent-one", archived: false, limit: 50 }).threads).toHaveLength(2);
  });

  it("expires stale actor-owned pending reservations instead of locking the run indefinitely", async () => {
    const f = await fixture(); f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: true }));
    await f.store.access.run(f.a, () => f.service.cronRuns("agent-one", "digest", { limit: 1 }));
    const candidate = f.store.access.run(f.a, () => f.store.captureCronReplySnapshot("agent-one", "digest", run.runId, "summary"));
    f.store.access.run(f.a, () => f.store.reserveCronReplyOperation("fictional-stale-reply", candidate));
    const db = new DatabaseSync(f.store.paths.database);
    try { db.prepare("UPDATE cron_reply_operations SET created_at = ? WHERE operation_id = ?").run("2000-01-01T00:00:00.000Z", "fictional-stale-reply"); }
    finally { db.close(); }
    expect(f.store.access.run(f.b, () => f.store.reserveCronReplyOperation("fictional-fresh-reply", candidate)).kind).toBe("reserved");
    expect(f.store.cronReplyOperation("fictional-stale-reply")?.kind).toBe("failed");
  });

  it("makes Reply private to its requester, binds pending/completed receipts to actor, and rechecks source visibility", async () => {
    const f = await fixture();
    f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: true }));
    await f.store.access.run(f.a, () => f.service.cronRuns("agent-one", "digest", { limit: 1 }));
    const input = { operationId: "fictional-reply-operation-one", snapshotKind: "summary" as const };
    f.pause();
    const first = f.store.access.run(f.a, () => f.service.createCronReplyThread("agent-one", "digest", run.runId, input));
    await expect(f.store.access.run(f.b, () => f.service.createCronReplyThread("agent-one", "digest", run.runId, input))).rejects.toMatchObject({ status: 404 });
    await expect(f.store.access.run(f.b, () => f.service.createCronReplyThread("agent-one", "digest", run.runId,
      { ...input, operationId: "fictional-different-actor-reply" }))).rejects.toMatchObject({ code: "cron_reply_busy", status: 409 });
    expect(f.imports()).toBe(0);
    f.resume();
    const receipt = await first;
    expect(receipt.thread).toMatchObject({ ownerUserId: f.a.id, shared: false });
    expect(f.store.access.run(f.b, () => f.store.getThread(receipt.thread.id))).toBeUndefined();
    expect(f.store.access.run(f.admin, () => f.store.getThread(receipt.thread.id))).toBeUndefined();
    await expect(f.store.access.run(f.b, () => f.service.createCronReplyThread("agent-one", "digest", run.runId, input))).rejects.toMatchObject({ status: 404 });
    const beforeReplay = f.imports();
    await expect(f.store.access.run(f.a, () => f.service.createCronReplyThread("agent-one", "digest", run.runId, input))).resolves.toMatchObject({ duplicate: true });
    expect(f.imports()).toBe(beforeReplay);
    f.store.access.run(f.admin, () => f.service.patchThread(f.channel.id, { shared: false }));
    await expect(f.store.access.run(f.a, () => f.service.createCronReplyThread("agent-one", "digest", run.runId, input))).rejects.toMatchObject({ status: 404 });
  });
});

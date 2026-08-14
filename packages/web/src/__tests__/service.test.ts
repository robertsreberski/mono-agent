import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_ATTACHMENT_MAX_BYTES } from "@mono-agent/agent-contracts";

import { WebService, WeightedTurnBudget } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function createService(options: Partial<Parameters<typeof WebService.create>[0]> = {}): Promise<WebService> {
  const base = await temporaryRoot();
  cleanup.push(base);
  return WebService.create({
    stateDir: join(base, "state"),
    discoveryIntervalMs: 0,
    purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent()],
    fetchImpl: operatorFetch(),
    ...options,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for service state.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function operatorCronOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-08-14T10:00:00.000Z",
    actionsEnabled: true,
    jobs: [{
      jobId: "digest",
      expression: "*/5 * * * *",
      timezone: "Europe/Amsterdam",
      conversationId: "cron:digest",
      configured: true,
      declaredEnabled: true,
      effectiveEnabled: true,
      health: "unknown",
    }],
    ...overrides,
  };
}

describe("WebService", () => {
  it("feature-detects cron without a wire bump and keeps cached old-agent state read-only and unknown", async () => {
    let modern = true;
    const modernFetch = operatorFetch({ cronOverview: operatorCronOverview() });
    const legacyFetch = operatorFetch();
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      (modern ? modernFetch : legacyFetch)(input, init)) as typeof fetch;
    const service = await createService({ fetchImpl });
    expect((await service.bootstrap()).agents[0]).toMatchObject({
      cron: { read: true, actions: false },
    });
    expect(await service.cronOverview("agent-one")).toMatchObject({
      actionsEnabled: true,
      jobs: [{ expression: "*/5 * * * *", health: "unknown" }],
    });
    expect((await service.cronOverview("agent-one")).jobs[0]).not.toHaveProperty("nextRunAt");

    modern = false;
    await service.refreshAgents();
    expect((await service.bootstrap()).agents[0]).not.toHaveProperty("cron");
    const degraded = await service.cronOverview("agent-one");
    expect(degraded.actionsEnabled).toBe(false);
    expect(degraded.jobs[0]).not.toHaveProperty("nextRunAt");
    await expect(service.cronRunNow("agent-one", "digest", { idempotencyKey: "old-agent" }))
      .rejects.toMatchObject({ code: "cron_unavailable" });
    await service.stop();
  });

  it("reports healthy cron channels as read-only for turns and live input", async () => {
    const service = await createService({
      fetchImpl: operatorFetch({ cronOverview: operatorCronOverview() }),
    });
    const overview = await service.cronOverview("agent-one");
    const threadId = overview.jobs[0]!.threadId;
    const expected = {
      code: "cron_channel_read_only",
      message: "Cron channels are read-only. Scheduled runs and history are managed by the agent.",
    };

    await expect(service.startTurn(threadId, { text: "not allowed" })).rejects.toMatchObject(expected);
    expect(() => service.submitLiveInput(threadId, "also not allowed")).toThrowError(
      expect.objectContaining(expected),
    );
    await service.stop();
  });

  it("proxies agent confirmation and idempotency authoritatively on the source-qualified cron route", async () => {
    const mutations: Array<{ url: string; body: Record<string, unknown> }> = [];
    const run = {
      projection: "summary",
      runId: "cron:digest:2026-08-14T10:00:00.000Z:m1",
      jobId: "digest",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      orderedAt: "2026-08-14T10:00:00.000Z",
      sequence: 1,
      trigger: "manual",
      status: "admitted",
      eventCount: 0,
    };
    const service = await createService({
      fetchImpl: operatorFetch({
        cronOverview: operatorCronOverview(),
        onCronMutation(url, body) {
          mutations.push({ url, body });
          return body.confirmationToken === undefined
            ? {
                kind: "confirmation_required",
                confirmation: {
                  token: "agent-confirmation",
                  expiresAt: "2026-08-14T10:05:00.000Z",
                  message: "Run now? A scheduled firing may be recorded as skipped_overlap.",
                },
              }
            : { kind: "completed", replayed: false, value: { run } };
        },
      }),
    });
    const first = await service.cronRunNow("agent-one", "digest", { idempotencyKey: "manual-one" });
    expect(first).toMatchObject({ kind: "confirmation_required", confirmation: { token: "agent-confirmation" } });
    const second = await service.cronRunNow("agent-one", "digest", {
      idempotencyKey: "manual-one",
      confirmationToken: "agent-confirmation",
    });
    expect(second).toMatchObject({ kind: "completed", value: { run } });
    expect(mutations.map(({ body }) => body)).toEqual([
      { idempotencyKey: "manual-one" },
      { idempotencyKey: "manual-one", confirmationToken: "agent-confirmation" },
    ]);
    expect(mutations.every(({ url }) => url.includes("/v1/cron/jobs/digest/run"))).toBe(true);
    await expect(service.cronRunNow("missing-source", "digest", { idempotencyKey: "wrong-source" }))
      .rejects.toMatchObject({ code: "agent_not_found" });
    await service.stop();
  });

  it("returns canonical messages with each keyset-paginated cron run page", async () => {
    const run = {
      projection: "summary",
      runId: "cron:digest:2026-08-14T09:55:00.000Z",
      jobId: "digest",
      scheduledAt: "2026-08-14T09:55:00.000Z",
      orderedAt: "2026-08-14T09:55:00.000Z",
      sequence: 4,
      trigger: "scheduled",
      status: "succeeded",
      startedAt: "2026-08-14T09:55:01.000Z",
      completedAt: "2026-08-14T09:55:02.000Z",
      text: "Digest complete",
      eventCount: 0,
    };
    const service = await createService({
      fetchImpl: operatorFetch({
        cronOverview: operatorCronOverview(),
        cronRuns: { runs: [run], nextCursor: "older-runs" },
      }),
    });

    const page = await service.cronRuns("agent-one", "digest", { limit: 100 });

    expect(page).toMatchObject({
      runs: [run],
      nextCursor: "older-runs",
      messages: [{
        role: "assistant",
        status: "complete",
        parts: expect.arrayContaining([
          { type: "text", text: "Digest complete" },
          expect.objectContaining({ type: "telemetry", event: "cron_run" }),
        ]),
      }],
    });
    await service.stop();
  });

  it("does not duplicate overview reads while paging and loads bounded selected-run activity on demand", async () => {
    const run = {
      projection: "summary",
      runId: "cron:digest:2026-08-14T09:55:00.000Z",
      jobId: "digest",
      scheduledAt: "2026-08-14T09:55:00.000Z",
      orderedAt: "2026-08-14T09:55:00.000Z",
      sequence: 4,
      trigger: "scheduled",
      status: "succeeded",
      text: "Compact result",
      eventCount: 30,
      fieldsTruncated: ["text"],
    };
    let overviewReads = 0;
    let pageReads = 0;
    let detailReads = 0;
    const delegated = operatorFetch({
      cronOverview: operatorCronOverview(),
      cronRuns: { runs: [run] },
      cronRun: {
        ...run,
        projection: "detail",
        text: "Selected full result",
        events: [{ type: "runtime_warning", message: "Bounded activity" }],
        eventsIncluded: 1,
        eventsTruncated: true,
      },
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/cron")) overviewReads += 1;
      else if (/\/v1\/cron\/jobs\/[^/]+\/runs\/[^/?]+(?:\?|$)/u.test(url)) detailReads += 1;
      else if (url.includes("/v1/cron/jobs/") && url.includes("/runs")) pageReads += 1;
      return await delegated(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const overviewReadsAfterStartup = overviewReads;

    await service.cronRuns("agent-one", "digest", { limit: 100 });
    expect(overviewReads).toBe(overviewReadsAfterStartup);
    expect(pageReads).toBe(1);
    const message = await service.cronRun("agent-one", "digest", run.runId);
    expect(detailReads).toBe(1);
    expect(message.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "telemetry", event: "runtime_warning" }),
      expect.objectContaining({
        type: "telemetry",
        event: "cron_run",
        data: expect.objectContaining({ eventsTruncated: true, loadedEventCount: 1 }),
      }),
      { type: "text", text: "Selected full result" },
    ]));
    await service.stop();
  });

  it("keeps repeated discovery recovery polls read-only and emits one convergence event for one change", async () => {
    let currentOverview = operatorCronOverview();
    let infoReads = 0;
    let overviewReads = 0;
    let clockMs = Date.parse("2026-08-14T10:00:00.000Z");
    const delegated = operatorFetch({ cronOverview: currentOverview });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) infoReads += 1;
      if (url.endsWith("/v1/cron")) {
        overviewReads += 1;
        return Response.json(currentOverview);
      }
      return await delegated(input, init);
    }) as typeof fetch;
    const service = await createService({
      fetchImpl,
      clock: () => new Date(clockMs += 1_000),
    });
    const threadId = (await service.cronOverview("agent-one")).jobs[0]!.threadId;
    const database = new DatabaseSync(service.store.paths.database, { readOnly: true });
    const snapshot = () => ({
      thread: database.prepare("SELECT revision, updated_at FROM threads WHERE id = ?").get(threadId),
      revisions: database.prepare("SELECT COUNT(*) AS count FROM revisions WHERE entity_kind = 'thread' AND entity_id = ?")
        .get(threadId),
      turns: database.prepare("SELECT COUNT(*) AS count FROM turns WHERE thread_id = ?").get(threadId),
      messages: database.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(threadId),
      mappings: database.prepare("SELECT COUNT(*) AS count FROM cron_run_messages WHERE thread_id = ?").get(threadId),
    });
    const beforeIdle = snapshot();
    const events: string[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event.type); });
    const startingInfoReads = infoReads;
    const startingOverviewReads = overviewReads;
    for (let tick = 0; tick < 40; tick += 1) await service.refreshAgents();
    expect(infoReads - startingInfoReads).toBe(40);
    expect(overviewReads - startingOverviewReads).toBe(40);
    expect(snapshot()).toEqual(beforeIdle);
    expect(events).toEqual([]);

    currentOverview = operatorCronOverview({
      jobs: [{
        ...(operatorCronOverview().jobs as Record<string, unknown>[])[0],
        health: "warning",
      }],
    });
    await service.refreshAgents();
    expect(events).toEqual(["cron.changed", "threads.changed"]);
    events.length = 0;
    await service.refreshAgents();
    expect(events).toEqual([]);
    expect((await service.cronOverview("agent-one")).jobs[0]).toMatchObject({ health: "warning" });
    unsubscribe();
    database.close();
    await service.stop();
  });

  it("reads terminal AskUser state by interaction id after another destination consumes the pending ask", async () => {
    const answered = {
      interactionId: "ask-old",
      message: "Choose",
      questions: [],
      answers: [],
      activeQuestionIndex: 0,
      status: "answered",
      createdAt: "2026-08-14T10:00:00.000Z",
      expiresAt: "2026-08-14T10:05:00.000Z",
    };
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsAskUser: true,
        supportsAskById: true,
        pendingAsk: { ...answered, interactionId: "ask-new", status: "pending" },
        exactAsks: { "ask-old": answered },
      }),
    });
    const thread = service.createThread("agent-one");
    await expect(service.ask(thread.id, "ask-old")).resolves.toMatchObject({
      interactionId: "ask-old",
      status: "answered",
    });
    await expect(service.pendingAsk(thread.id)).resolves.toMatchObject({ interactionId: "ask-new" });
    await expect(service.ask(thread.id, "evicted")).resolves.toBeUndefined();
    await service.stop();
  });

  it("preserves operator context-window metadata through discovery, storage, and bootstrap", async () => {
    const service = await createService();

    expect((await service.bootstrap()).agents[0]?.modelOptions?.["provider/default"]?.contextWindow)
      .toBe(128_000);

    await service.stop();
  });

  it("records notification history before publishing a marked idempotent thread", async () => {
    let failHistory = true;
    const recorded: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsHistoryAppend: true,
        async onVerbatim(conversationId, body) {
          recorded.push({ conversationId, body });
          if (failHistory) throw new Error("history unavailable");
        },
      }),
    });
    const input = {
      sourceId: "agent-one",
      triggerKind: "webhook" as const,
      deliveryKey: "webhook:digest:req-1:success",
      text: "Webhook digest",
    };

    await expect(service.deliverNotification(input)).rejects.toBeDefined();
    expect((await service.bootstrap()).threads).toEqual([]);

    failHistory = false;
    const delivered = await service.deliverNotification(input);
    expect(delivered).toMatchObject({
      duplicate: false,
      thread: { title: "Webhook notification", trigger: { kind: "webhook" } },
    });
    expect(delivered.thread).toBeDefined();
    const deliveredThread = delivered.thread!;
    expect(recorded.at(-1)).toEqual({
      conversationId: `web:${deliveredThread.id}`,
      body: { text: "Webhook digest", idempotencyKey: input.deliveryKey },
    });
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: true,
      thread: { id: deliveredThread.id },
    });
    expect(recorded).toHaveLength(2);
    await expect(service.deliverNotification({ ...input, text: "Changed digest" }))
      .rejects.toMatchObject({ code: "notification_idempotency_conflict" });
    await service.stop();
  });

  it("records structured cron delivery history in the source-qualified console namespace", async () => {
    const recorded: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsHistoryAppend: true,
        cronOverview: {
          generatedAt: "2026-08-14T10:00:00.000Z",
          actionsEnabled: false,
          jobs: [{
            jobId: "daily:brief",
            expression: "*/5 * * * *",
            timezone: "UTC",
            conversationId: "cron:daily:brief",
            configured: true,
            declaredEnabled: true,
            effectiveEnabled: true,
            health: "unknown",
          }],
        },
        onVerbatim(conversationId, body) { recorded.push({ conversationId, body }); },
      }),
    });
    const runId = "cron:daily%3Abrief:2026-08-14T10:05:00.000Z";
    const delivered = await service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: `${runId}:success`,
      jobId: "daily:brief",
      runId,
      text: "Cron digest",
    });

    expect(delivered.thread?.trigger).toMatchObject({ kind: "cron", jobId: "daily:brief" });
    expect(recorded).toEqual([{
      conversationId: expect.stringMatching(/^web-cron:[0-9a-f]{32}$/u),
      body: { text: "Cron digest", idempotencyKey: `${runId}:success` },
    }]);
    expect(recorded[0]!.conversationId).not.toBe(`web:${delivered.thread!.id}`);
    await service.stop();
  });

  it("announces suppressible terminal and AskUser push events without exposing Ask options", async () => {
    const pendingAsk = {
      interactionId: "ask-1",
      message: "private framing",
      questions: [{
        id: "q1",
        header: "Deploy",
        question: "Ship the release?",
        options: [
          { id: "yes", label: "Yes", description: "Ship now." },
          { id: "no", label: "No", description: "Wait." },
        ],
        multiSelect: false,
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const send = vi.fn(async () => ({ statusCode: 201, headers: {} }));
    const service = await createService({
      pushDnsResolver: async () => [{ address: "203.0.114.10", family: 4 }],
      pushSendImpl: send,
      pushDispatchIntervalMs: 10,
      fetchImpl: operatorFetch({
        supportsAskUser: true,
        pendingAsk,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
              kind: "event",
              event: { type: "tool_call_started", id: "ask-tool", name: "mcp__mono-agent-interaction__AskUser" },
            })}\n`));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ kind: "finish", finalText: "Finished" })}\n`));
              controller.close();
            }, 350);
          },
        }),
      }),
    });
    const publicKey = (await service.bootstrap()).push.applicationServerKey;
    const key = Buffer.alloc(65);
    key[0] = 4;
    const subscription = await service.registerWebPushSubscription({
      endpoint: "https://push.example.test/send/opaque",
      p256dh: key.toString("base64url"),
      auth: Buffer.alloc(16, 5).toString("base64url"),
      siteOrigin: "https://console.example.test",
    });
    expect(publicKey).toHaveLength(87);
    const pendingEvents: Array<{ eventId: string; threadId: string; ackToken: string }> = [];
    service.subscribe((event) => {
      if (event.type === "push.pending") {
        pendingEvents.push(event.payload as { eventId: string; threadId: string; ackToken: string });
      }
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "ask" });
    await waitFor(() => pendingEvents.length >= 1);
    const askEvent = service.store.webPushEventByLogicalKey("ask:ask-1");
    expect(askEvent).toMatchObject({
      kind: "input.required",
      title: "Agent One needs input",
      body: "Deploy: Ship the release?",
    });
    expect(JSON.stringify(askEvent)).not.toContain("private framing");
    expect(JSON.stringify(askEvent)).not.toContain("Ship now");
    // A forged token is intentionally a no-op; the direct store call proves
    // the delivery remained suppressible.
    service.acknowledgeWebPushEvent(pendingEvents[0]!.eventId, subscription.id, "x".repeat(32));
    expect(service.store.acknowledgeWebPushEvent(pendingEvents[0]!.eventId, subscription.id)).toBe(true);
    await service.submitAsk(thread.id, "ask-1", [{ questionId: "q1", selectedOptionIds: ["yes"] }]);
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    await waitFor(() => pendingEvents.length >= 2);
    const terminal = pendingEvents.at(-1)!;
    service.acknowledgeWebPushEvent(terminal.eventId, subscription.id, terminal.ackToken);
    expect(service.store.acknowledgeWebPushEvent(terminal.eventId, subscription.id)).toBe(false);
    await service.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("skips expired pending AskUser snapshots instead of failing the read", async () => {
    const instant = new Date("2026-08-13T08:00:00.000Z");
    const pendingAsk = {
      interactionId: "ask-expired",
      message: "private framing",
      questions: [{
        id: "q1",
        header: "Review",
        question: "Approve the change?",
        options: [],
        multiSelect: false,
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: "2026-08-13T07:00:00.000Z",
      expiresAt: "2026-08-13T07:59:59.000Z",
    };
    const service = await createService({
      clock: () => instant,
      fetchImpl: operatorFetch({ supportsAskUser: true, pendingAsk }),
      pushDnsResolver: async () => [{ address: "203.0.114.10", family: 4 }],
    });
    const key = Buffer.alloc(65);
    key[0] = 4;
    await service.registerWebPushSubscription({
      endpoint: "https://push.example.test/send/expired-ask",
      p256dh: key.toString("base64url"),
      auth: Buffer.alloc(16, 4).toString("base64url"),
      siteOrigin: "https://console.example.test",
    });
    const thread = service.createThread("agent-one");

    await expect(service.pendingAsk(thread.id)).resolves.toMatchObject({ interactionId: "ask-expired" });
    expect(service.store.webPushEventByLogicalKey("ask:ask-expired")).toBeUndefined();
    await service.stop();
  });

  it("aborts and awaits an AskUser watcher before closing the store", async () => {
    let markAskStarted: (() => void) | undefined;
    const askStarted = new Promise<void>((resolvePromise) => { markAskStarted = resolvePromise; });
    let askAborted = false;
    const snapshot = {
      interactionId: "ask-shutdown",
      message: "private framing",
      questions: [{
        id: "q1",
        header: "Deploy",
        question: "Ship now?",
        options: [],
        multiSelect: false,
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const baseFetch = operatorFetch({
      supportsAskUser: true,
      turns: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
            kind: "event",
            event: { type: "tool_call_started", id: "ask-tool", name: "AskUser" },
          })}\n`));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
            controller.close();
          }, 25);
        },
      }),
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/conversations/") && url.endsWith("/ask") && init?.method !== "POST") {
        markAskStarted?.();
        return await new Promise<Response>((resolvePromise) => {
          const finish = () => {
            askAborted = true;
            resolvePromise(Response.json({ ask: snapshot }));
          };
          if (init?.signal?.aborted === true) finish();
          else init?.signal?.addEventListener("abort", finish, { once: true });
        });
      }
      return await baseFetch(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const enqueue = vi.spyOn(service.store, "enqueueWebPushEvent");
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "ask" });
    await askStarted;

    await service.stop();

    expect(askAborted).toBe(true);
    expect(enqueue.mock.calls.some(([input]) => input.logicalKey === "ask:ask-shutdown")).toBe(false);
  });

  it("retries an AskUser delivery when its agent is temporarily offline", async () => {
    let instant = new Date("2026-08-13T08:00:00.000Z");
    let online = true;
    const pendingAsk = {
      interactionId: "ask-offline",
      message: "private framing",
      questions: [{
        id: "q1",
        header: "Review",
        question: "Approve the change?",
        options: [],
        multiSelect: false,
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: instant.toISOString(),
      expiresAt: new Date(instant.getTime() + 10 * 60_000).toISOString(),
    };
    const send = vi.fn(async () => ({ statusCode: 201, headers: {} }));
    const service = await createService({
      clock: () => instant,
      discoverImpl: async () => {
        const discovered = fakeDiscoveredAgent();
        if (online) return [discovered];
        const { baseUrl: _baseUrl, ...offline } = discovered;
        return [offline];
      },
      fetchImpl: operatorFetch({ supportsAskUser: true, pendingAsk }),
      pushDnsResolver: async () => [{ address: "203.0.114.10", family: 4 }],
      pushSendImpl: send,
      pushDispatchIntervalMs: 5,
      pushRandom: () => 0.5,
    });
    const identity = (await service.bootstrap()).push;
    const key = Buffer.alloc(65);
    key[0] = 4;
    const subscription = await service.registerWebPushSubscription({
      endpoint: "https://push.example.test/send/offline",
      p256dh: key.toString("base64url"),
      auth: Buffer.alloc(16, 6).toString("base64url"),
      siteOrigin: "https://console.example.test",
    });
    expect(subscription.keyFingerprint).toBe(identity.keyFingerprint);
    const thread = service.createThread("agent-one");
    await service.pendingAsk(thread.id);
    const event = service.store.webPushEventByLogicalKey("ask:ask-offline");
    expect(event).toBeDefined();

    online = false;
    await service.refreshAgents();
    instant = new Date("2026-08-13T08:00:03.000Z");
    await waitFor(() => {
      const database = new DatabaseSync(service.store.paths.database, { readOnly: true });
      try {
        const row = database.prepare(`
          SELECT status, attempts, last_error_code FROM push_deliveries
          WHERE event_id = ? AND subscription_id = ?
        `).get(event!.id, subscription.id) as {
          status: string;
          attempts: number;
          last_error_code: string | null;
        } | undefined;
        return row?.status === "pending" && row.attempts === 1
          && row.last_error_code === "interaction_state_unknown";
      } finally {
        database.close();
      }
    });
    expect(send).not.toHaveBeenCalled();
    await service.stop();
  });

  it("publishes persisted pin changes through bootstrap and agent invalidation events", async () => {
    const service = await createService();
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "agents.changed") events.push(event.payload);
    });

    expect(service.patchAgent("agent-one", { pinned: true })).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect((await service.bootstrap()).agents[0]).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect(events).toEqual([
      { agents: [expect.objectContaining({ sourceId: "agent-one", pinned: true })] },
    ]);
    await service.refreshAgents();
    expect((await service.bootstrap()).agents[0]).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect(() => service.patchAgent("missing", { pinned: true })).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    unsubscribe();
    await service.stop();
  });

  it("keeps a losing second service from mutating live turns", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const first = await WebService.create({
      stateDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [],
    });
    first.store.replaceAgents([{
      sourceId: "agent-one", label: "Agent", status: "online", supportsAttachments: true,
      updatedAt: new Date().toISOString(),
    }]);
    const thread = first.store.createThread("agent-one");
    first.store.beginTurn({ threadId: thread.id, text: "still running", attachmentIds: [] });

    const startedAt = Date.now();
    await expect(WebService.create({ stateDir, discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [] }))
      .rejects.toMatchObject({ code: "web_service_running" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(first.store.getThread(thread.id)?.runState.status).toBe("running");
    await first.stop();
  });

  it("releases the service lease when Web Push startup configuration is invalid", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const common = {
      stateDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [],
    };

    await expect(WebService.create({
      ...common,
      env: { MONO_AGENT_WEB_PUSH_SUBJECT: "http://localhost/contact" },
    })).rejects.toMatchObject({ code: "invalid_web_push_subject" });

    const recovered = await WebService.create(common);
    await recovered.stop();
  });

  it("coalesces a long stream, preserves interleaved part order/names, and reconciles finish metadata", async () => {
    const lines = [
      JSON.stringify({ kind: "append", delta: "a" }),
      JSON.stringify({ kind: "event", event: { type: "assistant_thought", text: "why" } }),
      JSON.stringify({ kind: "event", event: { type: "tool_call_started", id: "t", name: "Search", arguments: { q: 1 } } }),
      JSON.stringify({ kind: "event", event: { type: "tool_call_progress", id: "t", partialResult: "half" } }),
      JSON.stringify({ kind: "event", event: { type: "tool_call_completed", id: "t", content: "done" } }),
      ...Array.from({ length: 1_000 }, () => JSON.stringify({ kind: "append", delta: "x" })),
      JSON.stringify({ kind: "append", delta: "b" }),
      JSON.stringify({ kind: "finish", finalText: `a${"x".repeat(1_000)}b`, metadata: { runtime: { model: "actual/model", effort: "high" } } }),
      "",
    ];
    const service = await createService({ fetchImpl: operatorFetch({ turns: () => lines.join("\n") }) });
    const thread = service.createThread("agent-one");
    let messageInvalidations = 0;
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "message.changed") {
        messageInvalidations += 1;
        expect(event.payload).not.toHaveProperty("message");
      }
    });
    await service.startTurn(thread.id, { text: "prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");

    const detail = service.thread(thread.id);
    expect(messageInvalidations).toBeLessThanOrEqual(2);
    expect(detail.thread.runState).toMatchObject({ model: "actual/model", effort: "high" });
    expect(detail.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "a" },
      { type: "reasoning", text: "why" },
      { type: "tool-call", toolCallId: "t", toolName: "Search", args: { q: 1 }, result: "done", status: "complete" },
      { type: "text", text: `${"x".repeat(1_000)}b` },
    ]);
    unsubscribe();
    await service.stop();
  });

  it("preserves streamed text when the finish frame carries an empty finalText", async () => {
    const service = await createService({
      fetchImpl: operatorFetch({ turns: () => [
        JSON.stringify({ kind: "append", delta: "keep me" }),
        JSON.stringify({ kind: "finish", finalText: "" }),
        "",
      ].join("\n") }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.thread(thread.id).messages.at(-1)?.parts).toEqual([{ type: "text", text: "keep me" }]);
    await service.stop();
  });

  it("delivers a live follow-up into the active operator run and publishes applied state", async () => {
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const delivered: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "status", text: "working" })}\n`));
          },
        }),
        onLiveInput(conversationId, body) {
          delivered.push({ conversationId, body });
          return { status: "applied", runId: "run-live" };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial task" });

    const receipt = service.submitLiveInput(thread.id, "Also check the edge case");
    expect(receipt).toMatchObject({ disposition: "pending", message: { liveInputStatus: "pending" } });
    await waitFor(() => service.thread(thread.id).messages.some(
      (message) => message.id === receipt.message.id && message.liveInputStatus === "applied",
    ));
    expect(delivered).toEqual([{
      conversationId: `web:${thread.id}`,
      body: {
        id: expect.any(String),
        text: "Also check the edge case",
        receivedAt: expect.any(String),
      },
    }]);

    stream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    stream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    await service.stop();
  });

  it("queues a follow-up as the next turn when the active operator lacks live input", async () => {
    const encoder = new TextEncoder();
    let firstStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const turnBodies: Record<string, unknown>[] = [];
    let turnCount = 0;
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: false,
        onTurn(body) { turnBodies.push(body); },
        turns: () => {
          turnCount += 1;
          if (turnCount === 1) {
            return new ReadableStream<Uint8Array>({
              start(controller) { firstStream = controller; },
            });
          }
          return `${JSON.stringify({ kind: "finish", finalText: "Follow-up done" })}\n`;
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial task" });
    const receipt = service.submitLiveInput(thread.id, "Run this immediately after");
    expect(receipt).toMatchObject({ disposition: "queued", message: { liveInputStatus: "queued" } });

    await waitFor(() => firstStream !== undefined);
    firstStream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Initial done" })}\n`));
    firstStream?.close();
    await waitFor(() => turnBodies.length === 2);
    await waitFor(() => service.thread(thread.id).messages.filter((message) => message.role === "assistant").length === 2
      && service.store.getThread(thread.id)?.runState.status === "complete");
    expect(turnBodies.map((body) => body.text)).toEqual(["Initial task", "Run this immediately after"]);
    expect(service.thread(thread.id).messages.find((message) => message.id === receipt.message.id))
      .toMatchObject({ role: "user", parts: [{ type: "text", text: "Run this immediately after" }] });
    await service.stop();
  });

  it("sends a formatted blockquote upstream while preserving the authored message and quote", async () => {
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({ onTurn(body) { turnBodies.push(body); } }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Source prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const sourceMessage = service.thread(thread.id).messages.at(-1)!;

    await service.startTurn(thread.id, {
      text: "Please expand.",
      quote: { text: "First line\nSecond line", messageId: sourceMessage.id },
    });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");

    expect(turnBodies.at(-1)?.text).toBe(
      "Quoted context:\n> First line\n> Second line\n\nPlease expand.",
    );
    expect(service.thread(thread.id).messages.at(-2)).toMatchObject({
      quote: { text: "First line\nSecond line", messageId: sourceMessage.id },
      parts: [{ type: "text", text: "Please expand." }],
    });
    await expect(service.startTurn(thread.id, {
      text: "x".repeat(199_990),
      quote: { text: "First line", messageId: sourceMessage.id },
    })).rejects.toMatchObject({ code: "turn_text_too_large", status: 413 });
    expect(turnBodies).toHaveLength(2);
    await service.stop();
  });

  it("persists an internal stream-storage failure as failed rather than cancelled", async () => {
    const service = await createService();
    const thread = service.createThread("agent-one");
    vi.spyOn(service.store, "applyStreamFrames").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    await service.startTurn(thread.id, { text: "prompt" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status !== "running");
    expect(service.store.getThread(thread.id)?.runState).toMatchObject({
      status: "failed",
      error: { message: "disk unavailable" },
    });
    expect(service.thread(thread.id).messages.at(-1)?.status).toBe("failed");
    await service.stop();
  });

  it("supports attachment-only turns without duplicating decoded text on the wire", async () => {
    let turnBody: Record<string, unknown> | undefined;
    const service = await createService({ fetchImpl: operatorFetch({ onTurn(body) { turnBody = body; } }) });
    const thread = service.createThread("agent-one");
    const attachment = service.createUpload({ name: "notes.txt", contentType: "text/plain", sizeBytes: 5 });
    const stored = service.storedAttachment(attachment.id);
    await writeFile(service.store.attachmentPath(stored), "hello", { mode: 0o600 });
    service.completeUpload(attachment.id, 5);

    await service.startTurn(thread.id, { text: "", attachmentIds: [attachment.id] });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(turnBody).toMatchObject({ client: "web", text: "" });
    expect(turnBody?.attachments).toEqual([{
      kind: "document", mimeType: "text/plain", data: "aGVsbG8=", name: "notes.txt", sizeBytes: 5,
    }]);
    expect(service.thread(thread.id).messages[0]?.attachments[0]?.contentUrl).toBe(`/api/v1/uploads/${attachment.id}/content`);
    await service.stop();
  });

  it("cancels an active upstream turn and persists the cancelled state", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return operatorFetch()(input, init);
      if (url.endsWith("/cancel")) return Response.json({ cancelled: true }, { status: 202 });
      if (url.endsWith("/v1/turns")) {
        if (init?.signal?.aborted === true) throw init.signal.reason;
        return new Promise<Response>((_resolvePromise, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "wait" });
    await service.cancelTurn(thread.id);
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "cancelled");
    expect(service.thread(thread.id).messages.at(-1)?.status).toBe("cancelled");
    await service.stop();
  });

  it("keeps thread selection read-only and validates advertised model/effort semantics", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "cloud",
        models: ["cloud", "toggle", "graded", "none"],
        modelOptions: {
          cloud: { reasoning: true },
          toggle: { reasoning: true, reasoningMode: "toggle" },
          graded: { reasoning: true, reasoningMode: "effort", effortLevels: ["low", "high"] },
          none: { reasoning: false, reasoningMode: "none" },
        },
        capabilities: { attachments: true },
      });
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const one = service.createThread("agent-one");
    const two = service.createThread("agent-one");
    service.thread(one.id);
    expect((await service.bootstrap()).currentThreadId).toBe(two.id);

    const cloud = service.createThread("agent-one");
    await expect(service.startTurn(cloud.id, { text: "cloud", model: "cloud", effort: "ultra" })).resolves.toBeDefined();
    const toggle = service.createThread("agent-one");
    await expect(service.startTurn(toggle.id, { text: "toggle", model: "toggle", effort: "minimal" })).rejects.toMatchObject({ code: "invalid_effort" });
    await expect(service.startTurn(toggle.id, { text: "toggle", model: "toggle", effort: "high" })).resolves.toBeDefined();
    const graded = service.createThread("agent-one");
    await expect(service.startTurn(graded.id, { text: "graded", model: "graded", effort: "high" })).resolves.toBeDefined();
    const none = service.createThread("agent-one");
    await expect(service.startTurn(none.id, { text: "none", model: "none", effort: "high" })).rejects.toMatchObject({ code: "invalid_effort" });
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("accounts for all active worst-case upload reservations in the staged quota", async () => {
    const service = await createService();
    const reservations = Array.from({ length: 4 }, (_, index) => {
      const attachment = service.createUpload({ name: `unknown-${index}.txt`, contentType: "text/plain" });
      return service.reserveUpload(attachment.id);
    });
    for (let index = 0; index < 8; index += 1) {
      expect(service.createUpload({ name: `full-${index}.txt`, contentType: "text/plain", sizeBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES })).toBeDefined();
    }
    expect(() => service.createUpload({ name: "over.txt", contentType: "text/plain", sizeBytes: DEFAULT_AGENT_ATTACHMENT_MAX_BYTES }))
      .toThrowError(/quota/u);
    for (const reservation of reservations) reservation.release();
    await service.stop();
  });

  it("waits for an in-flight discovery refresh before closing SQLite", async () => {
    let calls = 0;
    let releaseRefresh: (() => void) | undefined;
    const service = await createService({
      discoverImpl: async () => {
        calls += 1;
        if (calls === 1) return [fakeDiscoveredAgent()];
        await new Promise<void>((resolvePromise) => { releaseRefresh = resolvePromise; });
        return [];
      },
    });
    const refresh = service.refreshAgents();
    await waitFor(() => releaseRefresh !== undefined);
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(stopped).toBe(false);
    releaseRefresh?.();
    await Promise.all([refresh, stopping]);
  });

  it("surfaces reachable stale agents as degraded and missing endpoints as offline", async () => {
    const stale = fakeDiscoveredAgent({
      source: { ...fakeDiscoveredAgent().source, sourceId: "stale", label: "Stale", health: "stale" },
    });
    const offline = {
      source: { ...fakeDiscoveredAgent().source, sourceId: "offline", label: "Offline" },
    };
    const service = await createService({ discoverImpl: async () => [stale, offline] });
    expect((await service.bootstrap()).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "stale", status: "degraded" }),
      expect.objectContaining({ sourceId: "offline", status: "offline" }),
    ]));
    await service.stop();
  });

  it("uses the canonical TUI effort ladder for older agents while keeping model selection exact", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({ schema: 1, model: "legacy/model", effort: "medium" });
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const compatible = service.createThread("agent-one");
    expect(service.store.getAgent("agent-one")?.efforts).toContain("xhigh");
    await expect(service.startTurn(compatible.id, { text: "legacy", model: "legacy/model", effort: "xhigh" })).resolves.toBeDefined();
    const invalid = service.createThread("agent-one");
    await expect(service.startTurn(invalid.id, { text: "legacy", model: "other/model" })).rejects.toMatchObject({ code: "invalid_model" });
    await expect(service.startTurn(invalid.id, { text: "legacy", effort: "impossible" })).rejects.toMatchObject({ code: "invalid_effort" });
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });
});

describe("WeightedTurnBudget", () => {
  it("queues weighted attachment turns while allowing text turns through", async () => {
    const budget = new WeightedTurnBudget(10, 1);
    const releaseFirst = await budget.acquire(10, new AbortController().signal);
    let secondGranted = false;
    const second = budget.acquire(1, new AbortController().signal).then((release) => {
      secondGranted = true;
      return release;
    });
    await expect(budget.acquire(1, new AbortController().signal)).rejects.toMatchObject({ code: "attachment_turn_queue_full" });
    await expect(budget.acquire(0, new AbortController().signal)).resolves.toBeTypeOf("function");
    expect(secondGranted).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondGranted).toBe(true);
    releaseSecond();
  });
});

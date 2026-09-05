import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  isChannelUserCancelReason,
  type AgentReplyPart,
} from "@mono-agent/agent-contracts";

import { agentGeneration, WebService, WeightedTurnBudget } from "../service.js";
import { fakeDiscoveredAgent, fakeMonitor, fakeProcessJob, operatorFetch, temporaryRoot } from "./helpers.js";

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

describe("agentGeneration", () => {
  it("does not collide two different processes onto one generation", () => {
    // The tuple was joined with a delimiter that can occur inside its own
    // fields, so two DIFFERENT `(baseUrl, pid, startedAt)` tuples flattened to
    // one string and hashed to one token. Two live processes sharing a
    // generation is exactly the state the token exists to make impossible: the
    // console would go on serving one process's `/v1/models` pages to the
    // other. Neither tuple below is one a first-party agent produces --- that
    // is why this is robustness and not a fleet regression --- but a digest
    // whose only defence is what its inputs happen to look like is not a
    // digest of three fields, it is a digest of one string.
    const left = fakeDiscoveredAgent({
      baseUrl: "http://127.0.0.1:45123/gui|1",
      source: { ...fakeDiscoveredAgent().source, pid: 2, startedAt: "2026-07-17T08:00:00.000Z" },
    });
    const right = fakeDiscoveredAgent({
      baseUrl: "http://127.0.0.1:45123/gui",
      source: { ...fakeDiscoveredAgent().source, pid: 1, startedAt: "2|2026-07-17T08:00:00.000Z" },
    });
    // Both flatten to the identical `|`-joined string, and did hash alike.
    expect([left.baseUrl, left.source.pid, left.source.startedAt].join("|"))
      .toBe([right.baseUrl, right.source.pid, right.source.startedAt].join("|"));
    expect(agentGeneration(left)).not.toBe(agentGeneration(right));
  });

  it("does not collide two fields that differ only where UTF-8 cannot say so", () => {
    // The length prefix fixed the delimiter, but the DIGEST still read the
    // joined string as UTF-8, and UTF-8 has no encoding for an unpaired
    // surrogate: a lone high surrogate and a lone low surrogate both become the
    // replacement character, so two distinct one-character fields hashed alike.
    // Same failure as the delimiter, one layer down -- the digest defended by
    // what its inputs happen to look like rather than by what it reads. No
    // first-party ISO timestamp can trigger it; a digest that is only correct
    // for well-formed input is not a digest of the input.
    const base = fakeDiscoveredAgent().source;
    const high = fakeDiscoveredAgent({ source: { ...base, startedAt: "\uD800" } });
    const low = fakeDiscoveredAgent({ source: { ...base, startedAt: "\uDC00" } });
    // Both are one UTF-16 code unit, so the length prefix cannot separate them,
    // and both UTF-8-encode to the very same three bytes.
    expect(high.source.startedAt.length).toBe(low.source.startedAt.length);
    expect([...Buffer.from(high.source.startedAt, "utf8")])
      .toEqual([...Buffer.from(low.source.startedAt, "utf8")]);
    expect(agentGeneration(high)).not.toBe(agentGeneration(low));
  });

  it("is stable for one process and different once it is replaced", () => {
    const base = fakeDiscoveredAgent();
    expect(agentGeneration(base)).toBe(agentGeneration(fakeDiscoveredAgent()));
    expect(agentGeneration(base)).toHaveLength(16);
    // And it never carries the endpoint or pid it is built from.
    expect(agentGeneration(base)).not.toContain("45123");
    expect(agentGeneration(base)).not.toContain("123");
    const restarted = fakeDiscoveredAgent({
      source: { ...base.source, pid: 124, startedAt: "2026-07-17T08:30:00.000Z" },
    });
    expect(agentGeneration(restarted)).not.toBe(agentGeneration(base));

    // The heartbeat must NOT move it. `updatedAt` changes on every discovery
    // poll, so folding it in would retire the browser's per-agent caches every
    // five seconds and make the token mean nothing. A previous round mutated
    // exactly this and all 170 backend tests stayed green.
    const beating = fakeDiscoveredAgent({
      source: { ...base.source, updatedAt: "2026-07-17T09:00:05.000Z" },
    });
    expect(agentGeneration(beating)).toBe(agentGeneration(base));
  });
});

describe("WebService", () => {
  it("delegates conversation search to the store and emits nothing for it", async () => {
    const service = await createService({});
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "reindex the tailscale exporter" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");

    const events: string[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event.type); });
    const page = service.searchThreads({ sourceId: "agent-one", query: "tailscale" });
    unsubscribe();

    expect(page.hits).toMatchObject([{ thread: { id: thread.id } }]);
    // A read changes nothing, so no other console tab needs waking.
    expect(events).toEqual([]);
  });

  it("applies evolving semantic titles from completed tool calls and retains the calls in Activity", async () => {
    const turnBodies: Record<string, unknown>[] = [];
    let turn = 0;
    const titles = ["Web console naming", "Runtime title policy"];
    const service = await createService({
      fetchImpl: operatorFetch({
        onTurn(body) { turnBodies.push(body); },
        turns: () => {
          const title = titles[turn++]!;
          return [
            JSON.stringify({
              kind: "event",
              event: { type: "tool_call_started", id: `title-${String(turn)}`, name: "SetConversationTitle", arguments: { title } },
            }),
            JSON.stringify({
              kind: "event",
              event: {
                type: "tool_call_completed",
                id: `title-${String(turn)}`,
                name: "SetConversationTitle",
                arguments: { title },
                content: `Conversation title proposed: ${title}`,
                structuredContent: { schema: 1, title },
              },
            }),
            JSON.stringify({ kind: "finish", finalText: "Done" }),
            "",
          ].join("\n");
        },
      }),
    });
    const thread = service.createThread("agent-one");
    const events: string[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event.type); });

    await service.startTurn(thread.id, { text: "Help me name web conversations" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.store.getThread(thread.id)?.title).toBe("Web console naming");

    await service.startTurn(thread.id, { text: "Now focus on runtime policy" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.store.getThread(thread.id)?.title).toBe("Runtime title policy");
    expect(turnBodies).toHaveLength(2);
    for (const body of turnBodies) {
      expect(body).toMatchObject({
        metadata: {
          web: { conversationTitle: { schema: 1, writable: true } },
        },
      });
    }
    expect(events.filter((event) => event === "thread.changed").length).toBeGreaterThanOrEqual(2);
    expect(service.thread(thread.id).messages.at(-1)?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool-call",
        toolName: "SetConversationTitle",
        status: "complete",
        structuredResult: { schema: 1, title: "Runtime title policy" },
      }),
    ]));
    unsubscribe();
    await service.stop();
  });

  it("lets a manual rename win during a run and suppresses title capability on later turns", async () => {
    const encoder = new TextEncoder();
    let firstStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const turnBodies: Record<string, unknown>[] = [];
    let turn = 0;
    const service = await createService({
      fetchImpl: operatorFetch({
        onTurn(body) { turnBodies.push(body); },
        turns: () => {
          turn += 1;
          if (turn === 1) {
            return new ReadableStream<Uint8Array>({ start(controller) { firstStream = controller; } });
          }
          return [
            JSON.stringify({
              kind: "event",
              event: {
                type: "tool_call_completed",
                id: "late-title",
                name: "SetConversationTitle",
                structuredContent: { schema: 1, title: "Agent overwrite" },
              },
            }),
            JSON.stringify({ kind: "finish", finalText: "Done" }),
            "",
          ].join("\n");
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial topic" });
    await waitFor(() => firstStream !== undefined);
    service.patchThread(thread.id, { title: "My permanent title" });
    firstStream?.enqueue(encoder.encode(`${JSON.stringify({
      kind: "event",
      event: {
        type: "tool_call_completed",
        id: "concurrent-title",
        name: "SetConversationTitle",
        structuredContent: { schema: 1, title: "Concurrent agent title" },
      },
    })}\n${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    firstStream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.store.getThread(thread.id)?.title).toBe("My permanent title");

    await service.startTurn(thread.id, { text: "Later topic" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.store.getThread(thread.id)?.title).toBe("My permanent title");
    expect(turnBodies[0]).toMatchObject({
      metadata: { web: { conversationTitle: { schema: 1, writable: true } } },
    });
    expect((turnBodies[1]?.metadata as { web?: Record<string, unknown> } | undefined)?.web)
      .not.toHaveProperty("conversationTitle");
    await service.stop();
  });

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

  it("emits no refresh events for repeated polls of a tombstoned historical cron channel", async () => {
    let currentOverview = operatorCronOverview();
    const delegated = operatorFetch({ cronOverview: currentOverview });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/cron")) return Response.json(currentOverview);
      return await delegated(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const threadId = (await service.cronOverview("agent-one")).jobs[0]!.threadId;
    currentOverview = operatorCronOverview({
      generatedAt: "2026-08-14T10:01:00.000Z",
      jobs: [{
        ...(operatorCronOverview().jobs as Record<string, unknown>[])[0],
        configured: false,
        effectiveEnabled: false,
        health: "disabled",
      }],
    });
    await service.refreshAgents();
    service.patchThread(threadId, { archived: true });
    await service.deleteThread(threadId);

    const database = new DatabaseSync(service.store.paths.database, { readOnly: true });
    const snapshot = () => ({
      overviews: database.prepare("SELECT * FROM cron_overviews ORDER BY source_id").all(),
      channels: database.prepare("SELECT * FROM cron_channels ORDER BY source_id, job_id").all(),
      snapshots: database.prepare("SELECT * FROM cron_job_snapshots ORDER BY source_id, job_id").all(),
      deletions: database.prepare("SELECT * FROM cron_channel_deletions ORDER BY source_id, job_id").all(),
      revisions: database.prepare("SELECT * FROM revisions ORDER BY entity_kind, entity_id, revision").all(),
      pushEvents: database.prepare("SELECT * FROM push_events ORDER BY id").all(),
    });
    const beforePolls = snapshot();
    const events: string[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event.type); });

    currentOverview = operatorCronOverview({ ...currentOverview, generatedAt: "2026-08-14T10:02:00.000Z" });
    await service.refreshAgents();
    currentOverview = operatorCronOverview({ ...currentOverview, generatedAt: "2026-08-14T10:03:00.000Z" });
    await service.refreshAgents();

    expect(events).toEqual([]);
    expect(snapshot()).toEqual(beforePolls);
    unsubscribe();
    database.close();
    await service.stop();
  });

  it("emits no refresh events when repeated overview polls omit a historical cron channel", async () => {
    const digest = (operatorCronOverview().jobs as Record<string, unknown>[])[0]!;
    const report = {
      ...digest,
      jobId: "report",
      conversationId: "cron:report",
    };
    let currentOverview = operatorCronOverview({ jobs: [digest, report] });
    const delegated = operatorFetch({ cronOverview: currentOverview });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/cron")) return Response.json(currentOverview);
      return await delegated(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    expect((await service.cronOverview("agent-one")).jobs.map(({ jobId }) => jobId)).toEqual(["digest", "report"]);
    const events: string[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event.type); });

    currentOverview = operatorCronOverview({
      generatedAt: "2026-08-14T10:01:00.000Z",
      jobs: [digest],
    });
    expect((await service.cronOverview("agent-one")).jobs.map(({ jobId }) => jobId)).toEqual(["digest"]);
    expect(events).toEqual(["cron.changed", "threads.changed"]);
    expect(service.store.storedCronOverview("agent-one")?.jobs).toEqual([
      expect.objectContaining({ jobId: "digest", configured: true }),
      expect.objectContaining({ jobId: "report", configured: false }),
    ]);
    events.length = 0;

    for (const generatedAt of ["2026-08-14T10:02:00.000Z", "2026-08-14T10:03:00.000Z"]) {
      currentOverview = operatorCronOverview({ generatedAt, jobs: [digest] });
      expect((await service.cronOverview("agent-one")).jobs.map(({ jobId }) => jobId)).toEqual(["digest"]);
    }
    expect(events).toEqual([]);

    unsubscribe();
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

  it("appends a process-job card to its origin thread without recordVerbatim", async () => {
    const onVerbatim = vi.fn();
    const service = await createService({
      fetchImpl: operatorFetch({ supportsHistoryAppend: true, onVerbatim }),
    });
    const thread = service.createThread("agent-one");
    const running = fakeProcessJob({ conversationId: `web:${thread.id}` });
    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: running.wake.deliveryKey,
      threadId: thread.id,
      processJob: running,
    })).resolves.toMatchObject({ duplicate: false, thread: { id: thread.id, messageCount: 1 } });
    expect(onVerbatim).not.toHaveBeenCalled();
    expect(service.thread(thread.id).messages).toHaveLength(1);

    const terminal = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
      wakeState: "delivered",
    });
    const replyParts = [
      {
        type: "attachment" as const,
        id: "job-attachment",
        reference: { scheme: "mono-agent-artifact" as const, id: "job-artifact" },
        name: "report.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        integrityId: `sha256:${"a".repeat(64)}`,
      },
      {
        type: "mcp_app" as const,
        id: "11111111-1111-4111-8111-111111111111",
        invocationId: "11111111-1111-4111-8111-111111111111",
        connectionId: "job-connection",
        serverName: "widgets",
        toolName: "show_chart",
        resourceUri: "ui://widgets/chart",
        mediaType: "text/html;profile=mcp-app" as const,
        protocolVersion: "2026-01-26" as const,
        title: "Job chart",
      },
      {
        type: "failure" as const,
        id: "job-failure",
        code: "artifact_missing" as const,
        message: "One optional artifact expired.",
      },
    ] as const satisfies readonly AgentReplyPart[];
    const terminalInput = {
      sourceId: "agent-one",
      triggerKind: "job" as const,
      deliveryKey: terminal.wake.deliveryKey,
      threadId: thread.id,
      processJob: terminal,
      text: "Completed normally.",
      parts: replyParts,
    };
    await expect(service.deliverNotification(terminalInput)).resolves.toMatchObject({ duplicate: false });
    expect(service.thread(thread.id).messages).toHaveLength(1);
    const parts = service.thread(thread.id).messages[0]?.parts;
    expect(parts).toEqual([
      expect.objectContaining({
        type: "process-job",
        job: expect.objectContaining({ state: "succeeded" }),
        responseText: "Completed normally.",
      }),
      expect.objectContaining({
        type: "attachment",
        id: "job-attachment",
        artifactId: "job-artifact",
        contentUrl: expect.stringContaining("/reply-attachments/job-attachment/content?"),
      }),
      expect.objectContaining({
        type: "mcp_app",
        id: "11111111-1111-4111-8111-111111111111",
        resourceUrl: expect.stringContaining("/mcp-apps/11111111-1111-4111-8111-111111111111?"),
        bridgeUrl: expect.stringContaining("/mcp-apps/11111111-1111-4111-8111-111111111111/requests?"),
      }),
      replyParts[2],
    ]);
    expect(JSON.stringify(parts)).not.toContain("mono-agent-artifact");
    await expect(service.deliverNotification(terminalInput)).resolves.toMatchObject({ duplicate: true });
    await expect(service.deliverNotification({
      ...terminalInput,
      parts: [{ ...replyParts[2], message: "A different retry." }],
    })).rejects.toMatchObject({ code: "notification_idempotency_conflict", status: 409 });
    expect(onVerbatim).not.toHaveBeenCalled();
    await service.stop();
  });

  it("steers a process-job wake into the exact active web turn and durably suppresses replay", async () => {
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const liveInputs: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) { stream = controller; },
        }),
        onLiveInput(conversationId, body) {
          liveInputs.push({ conversationId, body });
          return { status: "applied", runId: "active-run" };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial task" });
    await waitFor(() => stream !== undefined);
    const terminal = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
    });
    const input = {
      sourceId: "agent-one",
      triggerKind: "job" as const,
      deliveryKey: terminal.wake.deliveryKey,
      threadId: thread.id,
      processJob: terminal,
      wakePrompt: "Inspect the completed worker result",
    };

    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: false,
      delivery: { delivered: true, disposition: "steered" },
    });
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: true,
      delivery: { delivered: true, disposition: "steered" },
    });
    expect(liveInputs).toEqual([{
      conversationId: `web:${thread.id}`,
      body: expect.objectContaining({
        id: terminal.wake.deliveryKey,
        deliveryKey: terminal.wake.deliveryKey,
        text: "Inspect the completed worker result",
      }),
    }]);
    expect(service.thread(thread.id).messages.filter((message) => message.role === "user"))
      .toHaveLength(1);

    stream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Initial done" })}\n`));
    stream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    await service.stop();
  });

  it("suppresses fallback when an active-turn steering acknowledgement is lost", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({
          start(controller) { stream = controller; },
        }),
        onTurn(body) { turnBodies.push(body); },
        async onLiveInput() {
          throw new Error("connection dropped after delivery");
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Initial task" });
    await waitFor(() => stream !== undefined);
    const terminal = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
    });
    const input = {
      sourceId: "agent-one",
      triggerKind: "job" as const,
      deliveryKey: terminal.wake.deliveryKey,
      threadId: thread.id,
      processJob: terminal,
      wakePrompt: "Inspect the completed worker result",
    };

    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: false,
      delivery: {
        delivered: false,
        ambiguous: true,
        code: "process_job_wake_ambiguous",
        retryable: false,
      },
    });
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: true,
      delivery: {
        delivered: false,
        ambiguous: true,
        code: "process_job_wake_ambiguous",
        retryable: false,
      },
    });
    expect(turnBodies).toHaveLength(1);
    expect(service.thread(thread.id).messages.filter((message) => message.role === "user"))
      .toHaveLength(1);

    stream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status !== "running");
    await service.stop();
  });

  it("runs one visible assistant-only fallback turn when no web turn is active", async () => {
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        onTurn(body) { turnBodies.push(body); },
        turns: () => [
          JSON.stringify({ kind: "event", event: { type: "tool_call_started", id: "t1", name: "Read", arguments: { path: "result.txt" } } }),
          JSON.stringify({ kind: "event", event: { type: "tool_call_completed", id: "t1", name: "Read", result: "ok" } }),
          JSON.stringify({ kind: "finish", finalText: "Worker result processed" }),
          "",
        ].join("\n"),
      }),
    });
    const thread = service.createThread("agent-one");
    const terminal = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      state: "succeeded",
    });
    const input = {
      sourceId: "agent-one",
      triggerKind: "job" as const,
      deliveryKey: terminal.wake.deliveryKey,
      threadId: thread.id,
      processJob: terminal,
      wakePrompt: "Inspect the completed worker result",
    };

    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: false,
      delivery: { delivered: true, disposition: "follow_up" },
    });
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: true,
      delivery: { delivered: true, disposition: "follow_up" },
    });
    expect(turnBodies).toEqual([expect.objectContaining({
      text: "Inspect the completed worker result",
      processJobWakeDeliveryKey: terminal.wake.deliveryKey,
    })]);
    const messages = service.thread(thread.id).messages;
    expect(messages.some((message) => message.role === "user")).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", parts: [expect.objectContaining({ type: "process-job" })] }),
      expect.objectContaining({ role: "assistant", parts: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Worker result processed" }),
      ]) }),
    ]));
    await service.stop();
  });

  it("runs one assistant-only Monitor wake in its exact web thread and durably suppresses replay", async () => {
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        onTurn(body) { turnBodies.push(body); },
        turns: () => `${JSON.stringify({ kind: "finish", finalText: "The watched process is ready." })}\n`,
      }),
    });
    const thread = service.createThread("agent-one");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}`, seq: 6 });
    const input = {
      sourceId: "agent-one",
      triggerKind: "monitor" as const,
      deliveryKey: `monitor:${monitor.monitorId}:6`,
      threadId: thread.id,
      monitor,
      wakePrompt: "untrusted output credential-shape-value",
    };

    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: false,
      thread: { id: thread.id },
      delivery: { delivered: true, disposition: "follow_up" },
    });
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: true,
      delivery: { delivered: true, disposition: "follow_up" },
    });
    expect(turnBodies).toEqual([expect.objectContaining({
      conversationId: `web:${thread.id}`,
      text: input.wakePrompt,
      processJobWakeDeliveryKey: input.deliveryKey,
    })]);
    expect(service.thread(thread.id).messages.some((message) => message.role === "user")).toBe(false);
    expect(service.thread(thread.id).messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        parts: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "The watched process is ready." }),
          {
            type: "monitor-activity",
            monitors: [{ projection: monitor, deliveryKeys: [input.deliveryKey] }],
          },
        ]),
      }),
    ]);
    const raw = new DatabaseSync(service.store.paths.database, { readOnly: true });
    const turns = raw.prepare("SELECT text FROM turns").all() as Array<{ text: string }>;
    const deliveries = raw.prepare("SELECT * FROM monitor_wake_deliveries").all();
    raw.close();
    expect(turns).toEqual([{ text: "[Monitor wake]" }]);
    expect(JSON.stringify(deliveries)).not.toContain("credential-shape-value");
    await service.stop();
  });

  it("rejects conflicting content while the same Monitor delivery key is still active", async () => {
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const service = await createService({
      fetchImpl: operatorFetch({
        turns: () => new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
      }),
    });
    const thread = service.createThread("agent-one");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
    const input = {
      sourceId: "agent-one",
      triggerKind: "monitor" as const,
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: thread.id,
      monitor,
      wakePrompt: "first content",
    };
    const first = service.deliverNotification(input);
    await waitFor(() => stream !== undefined);
    await expect(service.deliverNotification({ ...input, wakePrompt: "different content" }))
      .rejects.toMatchObject({ code: "notification_idempotency_conflict", status: 409 });

    stream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    stream?.close();
    await expect(first).resolves.toMatchObject({ delivery: { delivered: true } });
    await service.stop();
  });

  it("steers a Monitor wake into the exact active web turn", async () => {
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const liveInputs: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
        onLiveInput(conversationId, body) {
          liveInputs.push({ conversationId, body });
          return { status: "applied", runId: "active-run" };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Keep working" });
    await waitFor(() => stream !== undefined);
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}`, seq: 2 });
    const deliveryKey = `monitor:${monitor.monitorId}:2`;

    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey,
      threadId: thread.id,
      monitor,
      wakePrompt: "Inspect the new event.",
    })).resolves.toMatchObject({ delivery: { delivered: true, disposition: "steered" } });
    expect(liveInputs).toEqual([{
      conversationId: `web:${thread.id}`,
      body: expect.objectContaining({ id: deliveryKey, deliveryKey, text: "Inspect the new event." }),
    }]);

    stream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    stream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    expect(service.thread(thread.id).messages.at(-1)?.parts).toEqual(expect.arrayContaining([{
      type: "monitor-activity",
      monitors: [{ projection: monitor, deliveryKeys: [deliveryKey] }],
    }]));
    await service.stop();
  });

  it("queues an oversized Monitor wake as a follow-up instead of ambiguously steering it", async () => {
    const encoder = new TextEncoder();
    let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const turnBodies: Record<string, unknown>[] = [];
    const liveInputs: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        onTurn(body) { turnBodies.push(body); },
        turns: () => turnBodies.length === 1
          ? new ReadableStream<Uint8Array>({ start(controller) { activeStream = controller; } })
          : `${JSON.stringify({ kind: "finish", finalText: "Oversized wake handled" })}\n`,
        onLiveInput(_conversationId, body) {
          liveInputs.push(body);
          return { status: "applied", runId: "active-run" };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Keep working" });
    await waitFor(() => activeStream !== undefined);
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
    const wakePrompt = "x".repeat(AGENT_LIVE_INPUT_MAX_CHARACTERS + 1);
    const delivery = service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: thread.id,
      monitor,
      wakePrompt,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(liveInputs).toEqual([]);
    expect(turnBodies).toHaveLength(1);

    activeStream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    activeStream?.close();
    await expect(delivery).resolves.toMatchObject({
      delivery: { delivered: true, disposition: "follow_up" },
    });
    expect(turnBodies).toHaveLength(2);
    expect(turnBodies[1]).toMatchObject({ text: wakePrompt });
    await service.stop();
  });

  it("abandons a Monitor claim when destination refresh fails before operator delivery", async () => {
    let discovery: "ready" | "offline" = "ready";
    const service = await createService({
      discoverImpl: async () => discovery === "ready" ? [fakeDiscoveredAgent()] : [],
      fetchImpl: operatorFetch({
        turns: () => `${JSON.stringify({ kind: "finish", finalText: "Recovered" })}\n`,
      }),
    });
    const thread = service.createThread("agent-one");
    discovery = "offline";
    await service.refreshAgents();
    const refresh = vi.spyOn(service, "refreshAgents")
      .mockRejectedValueOnce(new Error("discovery unavailable"));
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
    const input = {
      sourceId: "agent-one",
      triggerKind: "monitor" as const,
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: thread.id,
      monitor,
      wakePrompt: "retry after discovery recovers",
    };

    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: false,
      delivery: { delivered: false, code: "destination_channel_unavailable", retryable: true },
    });
    const raw = new DatabaseSync(service.store.paths.database, { readOnly: true });
    const retainedClaims = raw.prepare("SELECT COUNT(*) AS count FROM monitor_wake_deliveries")
      .get() as { count: number };
    raw.close();
    expect(retainedClaims.count).toBe(0);

    refresh.mockRestore();
    discovery = "ready";
    await expect(service.deliverNotification(input)).resolves.toMatchObject({
      duplicate: false,
      delivery: { delivered: true, disposition: "follow_up" },
    });
    await service.stop();
  });

  it("rejects cross-thread origins and exact-key reuse before touching the operator", async () => {
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({ onTurn(body) { turnBodies.push(body); } }),
    });
    const thread = service.createThread("agent-one");
    const other = service.createThread("agent-one");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}`, seq: 5 });

    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:5`,
      threadId: other.id,
      monitor,
      wakePrompt: "must not run",
    })).rejects.toMatchObject({ code: "invalid_notification", status: 409 });
    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:4`,
      threadId: thread.id,
      monitor,
      wakePrompt: "must not run",
    })).rejects.toMatchObject({ code: "invalid_notification", status: 409 });

    service.patchThread(thread.id, { archived: true });
    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:5`,
      threadId: thread.id,
      monitor,
      wakePrompt: "must not run",
    })).resolves.toMatchObject({
      duplicate: false,
      delivery: { delivered: false, code: "monitor_wake_failed", retryable: false },
    });
    await service.deleteThread(thread.id);
    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:5`,
      threadId: thread.id,
      monitor,
      wakePrompt: "must not run",
    })).resolves.toMatchObject({
      duplicate: true,
      tombstoned: true,
      delivery: { delivered: false, code: "monitor_origin_mismatch", retryable: false },
    });
    expect(turnBodies).toEqual([]);
    await service.stop();
  });

  it("suppresses Web Push for a silent Monitor follow-up", async () => {
    const service = await createService({
      fetchImpl: operatorFetch({
        turns: () => `${JSON.stringify({ kind: "finish", finalText: "" })}\n`,
      }),
    });
    const thread = service.createThread("agent-one");
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
    await expect(service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: thread.id,
      monitor,
      wakePrompt: "Nothing changed.",
    })).resolves.toMatchObject({ delivery: { delivered: true } });

    const raw = new DatabaseSync(service.store.paths.database, { readOnly: true });
    const responsePushes = raw.prepare("SELECT COUNT(*) AS count FROM push_events WHERE kind = 'response.ready'")
      .get() as { count: number };
    raw.close();
    expect(responsePushes.count).toBe(0);
    await service.stop();
  });

  it("serializes process-job and Monitor follow-ups through one host-wake lane", async () => {
    const encoder = new TextEncoder();
    let firstStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const turnBodies: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        onTurn(body) { turnBodies.push(body); },
        turns: () => turnBodies.length === 1
          ? new ReadableStream<Uint8Array>({ start(controller) { firstStream = controller; } })
          : `${JSON.stringify({ kind: "finish", finalText: "Monitor handled" })}\n`,
      }),
    });
    const thread = service.createThread("agent-one");
    const job = fakeProcessJob({ conversationId: `web:${thread.id}`, state: "succeeded" });
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
    const jobDelivery = service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: job.wake.deliveryKey,
      threadId: thread.id,
      processJob: job,
      wakePrompt: "Handle the job.",
    });
    await waitFor(() => firstStream !== undefined);
    const monitorDelivery = service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: thread.id,
      monitor,
      wakePrompt: "Handle the monitor.",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(turnBodies).toHaveLength(1);

    firstStream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Job handled" })}\n`));
    firstStream?.close();
    await expect(jobDelivery).resolves.toMatchObject({ delivery: { delivered: true } });
    await expect(monitorDelivery).resolves.toMatchObject({ delivery: { delivered: true } });
    expect(turnBodies.map((body) => body.processJobWakeDeliveryKey)).toEqual([
      job.wake.deliveryKey,
      `monitor:${monitor.monitorId}:1`,
    ]);
    await service.stop();
  });

  it("does not overlap process-job and Monitor steering calls on one active thread", async () => {
    const encoder = new TextEncoder();
    let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settleFirst: ((value: Record<string, unknown>) => void) | undefined;
    const firstSettlement = new Promise<Record<string, unknown>>((resolvePromise) => {
      settleFirst = resolvePromise;
    });
    const liveInputs: Record<string, unknown>[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        supportsLiveInput: true,
        turns: () => new ReadableStream<Uint8Array>({ start(controller) { activeStream = controller; } }),
        onLiveInput(_conversationId, body) {
          liveInputs.push(body);
          return liveInputs.length === 1
            ? firstSettlement
            : { status: "applied", runId: "active-run" };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "Keep working" });
    await waitFor(() => activeStream !== undefined);
    const job = fakeProcessJob({ conversationId: `web:${thread.id}`, state: "succeeded" });
    const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
    const jobDelivery = service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: job.wake.deliveryKey,
      threadId: thread.id,
      processJob: job,
      wakePrompt: "Handle the job.",
    });
    const monitorDelivery = service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: thread.id,
      monitor,
      wakePrompt: "Handle the monitor.",
    });
    await waitFor(() => liveInputs.length > 0);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(liveInputs).toHaveLength(1);

    settleFirst?.({ status: "applied", runId: "active-run" });
    await expect(jobDelivery).resolves.toMatchObject({ delivery: { delivered: true, disposition: "steered" } });
    await expect(monitorDelivery).resolves.toMatchObject({ delivery: { delivered: true, disposition: "steered" } });
    expect(liveInputs.map((body) => body.deliveryKey)).toEqual([
      job.wake.deliveryKey,
      `monitor:${monitor.monitorId}:1`,
    ]);

    activeStream?.enqueue(encoder.encode(`${JSON.stringify({ kind: "finish", finalText: "Done" })}\n`));
    activeStream?.close();
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    await service.stop();
  });

  it("proxies only one retained job bound to the exact source and thread", async () => {
    const requests: Array<{ jobId: string; authorization: string | null }> = [];
    let jobs: readonly ReturnType<typeof fakeProcessJob>[] = [];
    let jobOverride: ReturnType<typeof fakeProcessJob> | undefined;
    const second = fakeDiscoveredAgent();
    const service = await createService({
      discoverImpl: async () => [
        fakeDiscoveredAgent({ processJobsBearer: "owner-token" }),
        {
          ...second,
          source: { ...second.source, sourceId: "agent-two", label: "Agent Two" },
          baseUrl: "http://127.0.0.1:45124/gui",
          processJobsBearer: "other-owner-token",
        },
      ],
      fetchImpl: operatorFetch({
        supportsJobs: true,
        get jobs() { return jobs; },
        jobForRequest: (jobId) => jobOverride ?? jobs.find((candidate) => candidate.jobId === jobId),
        onJobRequest: (jobId, authorization) => requests.push({ jobId, authorization }),
      }),
    });
    const thread = service.createThread("agent-one");
    const running = fakeProcessJob({ conversationId: `web:${thread.id}` });
    jobs = [running];
    await service.deliverNotification({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: running.wake.deliveryKey,
      threadId: thread.id,
      processJob: running,
    });

    await expect(service.threadJob(thread.id, running.jobId)).resolves.toEqual(running);
    expect(requests).toEqual([{ jobId: running.jobId, authorization: "Bearer owner-token" }]);

    const sameSourceOtherThread = service.createThread("agent-one");
    await expect(service.threadJob(sameSourceOtherThread.id, running.jobId))
      .rejects.toMatchObject({ code: "process_job_not_found", status: 404 });
    const otherSourceThread = service.createThread("agent-two");
    await expect(service.threadJob(otherSourceThread.id, running.jobId))
      .rejects.toMatchObject({ code: "process_job_not_found", status: 404 });
    expect(requests).toHaveLength(1);

    jobs = [fakeProcessJob({ conversationId: `web:${sameSourceOtherThread.id}` })];
    await expect(service.threadJob(thread.id, running.jobId))
      .rejects.toMatchObject({ code: "process_job_not_found", status: 404 });
    expect(requests).toHaveLength(2);

    jobOverride = fakeProcessJob({
      conversationId: `web:${thread.id}`,
      jobId: "33333333-3333-4333-8333-333333333333",
    });
    await expect(service.threadJob(thread.id, running.jobId))
      .rejects.toMatchObject({ code: "process_job_not_found", status: 404 });
    expect(requests).toHaveLength(3);
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
    expect(events).toEqual([undefined]);
    await service.refreshAgents();
    expect((await service.bootstrap()).agents[0]).toMatchObject({ sourceId: "agent-one", pinned: true });
    expect(() => service.patchAgent("missing", { pinned: true })).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    unsubscribe();
    await service.stop();
  });

  it("hides an authoritatively removed agent and restores its retained history by source id", async () => {
    const first = fakeDiscoveredAgent();
    const second = fakeDiscoveredAgent({
      source: { ...first.source, sourceId: "agent-two", label: "Agent Two" },
    });
    let discovered = [first, second];
    const service = await createService({ discoverImpl: async () => discovered });
    service.patchAgent("agent-two", { pinned: true });
    const retained = service.createThread("agent-two");
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "agents.changed") events.push(event.payload);
    });

    discovered = [first];
    await service.refreshAgents();
    const removed = await service.bootstrap();
    expect(removed.agents.map((entry) => entry.sourceId)).toEqual(["agent-one"]);
    expect(removed.threads.map((entry) => entry.id)).not.toContain(retained.id);
    expect(removed.currentThreadId).toBeUndefined();
    expect(() => service.patchAgent("agent-two", { pinned: false }))
      .toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    expect(() => service.createThread("agent-two"))
      .toThrowError(expect.objectContaining({ code: "agent_not_found" }));

    const database = new DatabaseSync(service.store.paths.database, { readOnly: true });
    expect(database.prepare("SELECT discovered FROM agents WHERE source_id = 'agent-two'").get())
      .toMatchObject({ discovered: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM threads WHERE source_id = 'agent-two'").get())
      .toMatchObject({ count: 1 });
    database.close();

    discovered = [first, second];
    await service.refreshAgents();
    const restored = await service.bootstrap();
    expect(restored.agents.find((entry) => entry.sourceId === "agent-two"))
      .toMatchObject({ pinned: true });
    expect(restored.threads.map((entry) => entry.id)).toContain(retained.id);
    expect(restored.currentThreadId).toBe(retained.id);
    expect(events).toEqual([undefined, undefined]);
    unsubscribe();
    await service.stop();
  });

  it("keeps agents visible as offline when discovery itself fails", async () => {
    let failDiscovery = false;
    const service = await createService({
      discoverImpl: async () => {
        if (failDiscovery) throw new Error("registry unavailable");
        return [fakeDiscoveredAgent()];
      },
    });
    const thread = service.createThread("agent-one");
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "agents.changed") events.push(event.payload);
    });

    failDiscovery = true;
    await service.refreshAgents();
    expect((await service.bootstrap())).toMatchObject({
      agents: [expect.objectContaining({ sourceId: "agent-one", status: "offline" })],
      threads: [expect.objectContaining({ id: thread.id })],
      currentThreadId: thread.id,
    });
    expect(events).toEqual([undefined]);

    // A repeated failure is not another state transition or invalidation.
    await service.refreshAgents();
    expect(events).toEqual([undefined]);
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

  /**
   * A durable copy of a generated image. `imageBytes` is a real PNG header plus
   * filler so the digest is honest rather than hand-written.
   */
  const replyImage = (): { readonly bytes: Buffer; readonly integrityId: string } => {
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(24, 7),
    ]);
    return { bytes, integrityId: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  };

  const imageTurn = (
    image: { readonly bytes: Buffer; readonly integrityId: string },
    overrides: Record<string, unknown> = {},
  ) => ({
    supportsReplyAttachments: true,
    turns: () => `${JSON.stringify({
      kind: "finish",
      finalText: "Here it is",
      parts: [{
        type: "attachment",
        id: "cover-part",
        reference: { scheme: "mono-agent-artifact", id: "artifact-cover" },
        name: "cover.png",
        mediaType: "image/png",
        sizeBytes: image.bytes.byteLength,
        integrityId: image.integrityId,
        expiresAt: "2026-09-29T12:00:00.000Z",
        ...overrides,
      }],
    })}\n`,
    onReplyArtifact: () => artifactResponse(image, image.bytes),
  });

  /**
   * `body` is deliberately separate from the declared metadata: the operator
   * client only compares headers, so sending honest headers with dishonest bytes
   * is the one way to exercise the service's own digest check.
   */
  const artifactResponse = (
    declared: { readonly bytes: Buffer; readonly integrityId: string },
    body: Buffer,
  ): Response => new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-length": String(declared.bytes.byteLength),
      "x-mono-agent-integrity-id": declared.integrityId,
    },
  });

  it("keeps its own copy of a generated image so it outlives the agent's retention deadline", async () => {
    const image = replyImage();
    let clockMs = Date.parse("2026-08-30T12:00:00.000Z");
    const service = await createService({
      clock: () => new Date(clockMs),
      fetchImpl: operatorFetch(imageTurn(image)),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "make a cover" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const messageId = service.thread(thread.id).messages.at(-1)!.id;
    await waitFor(() => service.store.storedReplyAttachment(messageId, "cover-part") !== undefined);

    const stored = service.store.storedReplyAttachment(messageId, "cover-part")!;
    expect(stored).toMatchObject({ origin: "reply", kind: "image", contentType: "image/png", status: "committed" });
    expect(stored.sizeBytes).toBe(image.bytes.byteLength);
    expect(await readFile(service.store.attachmentPath(stored))).toEqual(image.bytes);

    const part = service.thread(thread.id).messages.at(-1)!.parts
      .find((candidate) => candidate.type === "attachment")!;
    expect(part.storedUrl).toBe(`/api/v1/uploads/${encodeURIComponent(stored.id)}/content`);

    // Re-reading the thread must not fetch or store the same image twice.
    service.thread(thread.id);
    service.thread(thread.id);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(await readdir(service.store.paths.uploads)).toHaveLength(1);
    expect(service.store.storedReplyAttachment(messageId, "cover-part")?.id).toBe(stored.id);

    // Past the retention deadline the capability is gone, which is exactly when
    // the stored copy has to carry the image on its own.
    clockMs = Date.parse("2026-10-01T12:00:00.000Z");
    const expired = service.thread(thread.id).messages.at(-1)!.parts
      .find((candidate) => candidate.type === "attachment")!;
    expect(expired.contentUrl).toBeUndefined();
    expect(expired.storedUrl).toBe(`/api/v1/uploads/${encodeURIComponent(stored.id)}/content`);
  });

  it("refuses to store an image whose bytes do not match the digest the agent declared", async () => {
    const image = replyImage();
    const service = await createService({
      fetchImpl: operatorFetch({
        ...imageTurn(image),
        onReplyArtifact: () => artifactResponse(image, Buffer.alloc(image.bytes.byteLength, 9)),
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "make a cover" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const messageId = service.thread(thread.id).messages.at(-1)!.id;
    await new Promise((settle) => setTimeout(settle, 30));

    // Neither a row nor a file: a corrupt artifact must never reach a stable URL
    // that outlives the source able to contradict it.
    expect(service.store.storedReplyAttachment(messageId, "cover-part")).toBeUndefined();
    expect(await readdir(service.store.paths.uploads)).toEqual([]);
    const part = service.thread(thread.id).messages.at(-1)!.parts
      .find((candidate) => candidate.type === "attachment")!;
    expect(part.storedUrl).toBeUndefined();
    expect(part.contentUrl).toBeDefined();
  });

  it("never stores an SVG reply, which is active content rather than a raster image", async () => {
    const image = replyImage();
    const service = await createService({
      fetchImpl: operatorFetch(imageTurn(image, { mediaType: "image/svg+xml", name: "cover.svg" })),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "make a cover" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const messageId = service.thread(thread.id).messages.at(-1)!.id;
    await new Promise((settle) => setTimeout(settle, 30));

    expect(service.store.storedReplyAttachment(messageId, "cover-part")).toBeUndefined();
    expect(await readdir(service.store.paths.uploads)).toEqual([]);
  });

  it("leaves the turn and the capability path intact when the image cannot be fetched", async () => {
    const image = replyImage();
    const service = await createService({
      fetchImpl: operatorFetch({
        ...imageTurn(image),
        onReplyArtifact: () => new Response("gone", { status: 503 }),
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "make a cover" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    await new Promise((settle) => setTimeout(settle, 30));

    // The turn still succeeded, and the part still has its ordinary capability.
    expect(service.store.getThread(thread.id)?.runState.status).toBe("complete");
    const part = service.thread(thread.id).messages.at(-1)!.parts
      .find((candidate) => candidate.type === "attachment")!;
    expect(part.storedUrl).toBeUndefined();
    expect(part.contentUrl).toBeDefined();
  });

  it("reclaims a stored image and its bytes when the conversation is deleted", async () => {
    const image = replyImage();
    const service = await createService({ fetchImpl: operatorFetch(imageTurn(image)) });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "make a cover" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const messageId = service.thread(thread.id).messages.at(-1)!.id;
    await waitFor(() => service.store.storedReplyAttachment(messageId, "cover-part") !== undefined);
    expect(await readdir(service.store.paths.uploads)).toHaveLength(1);

    service.patchThread(thread.id, { archived: true });
    await service.deleteThread(thread.id);
    expect(service.store.storedReplyAttachment(messageId, "cover-part")).toBeUndefined();
    // Unbounded retention is only defensible while deletion actually reclaims it.
    expect(await readdir(service.store.paths.uploads)).toEqual([]);
  });

  it("persists rich reply references and authorizes attachment/app access by exact message token", async () => {
    const integrityId = `sha256:${"a".repeat(64)}`;
    const bridgeCalls: Array<{ readonly body: Record<string, unknown>; readonly headers: RequestInit["headers"] }> = [];
    let clockMs = Date.parse("2026-08-14T12:00:00.000Z");
    const service = await createService({
      clock: () => new Date(clockMs),
      fetchImpl: operatorFetch({
        supportsReplyAttachments: true,
        supportsMcpApps: true,
        turns: () => `${JSON.stringify({
          kind: "finish",
          finalText: "Ready",
          parts: [
            {
              type: "attachment",
              id: "attachment-part",
              reference: { scheme: "mono-agent-artifact", id: "artifact-one" },
              name: "report.txt",
              mediaType: "text/plain",
              sizeBytes: 6,
              integrityId,
              expiresAt: "2026-08-15T12:00:00.000Z",
            },
            {
              type: "mcp_app",
              id: "11111111-1111-4111-8111-111111111111",
              invocationId: "11111111-1111-4111-8111-111111111111",
              connectionId: "connection-one",
              serverName: "widgets",
              toolName: "show_chart",
              resourceUri: "ui://widgets/chart",
              mediaType: "text/html;profile=mcp-app",
              protocolVersion: "2026-01-26",
              expiresAt: "2026-08-15T12:00:00.000Z",
            },
          ],
        })}\n`,
        onReplyArtifact(_url, init) {
          expect(init?.headers).toMatchObject({ "x-mono-agent-integrity-id": integrityId });
          return new Response("report", {
            headers: { "content-length": "6", "x-mono-agent-integrity-id": integrityId },
          });
        },
        onMcpAppResource(_url, init) {
          expect(init?.headers).toMatchObject({ "x-mono-agent-mcp-connection-id": "connection-one" });
          return {
            app: {
              type: "mcp_app",
              id: "11111111-1111-4111-8111-111111111111",
              invocationId: "11111111-1111-4111-8111-111111111111",
              connectionId: "connection-one",
              serverName: "widgets",
              toolName: "show_chart",
              resourceUri: "ui://widgets/chart",
              mediaType: "text/html;profile=mcp-app",
              protocolVersion: "2026-01-26",
            },
            html: "<!doctype html><p>chart</p>",
            connected: true,
          };
        },
        onMcpAppRequest(_url, body, init) {
          bridgeCalls.push({ body, headers: init?.headers });
          return { refreshed: true };
        },
      }),
    });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "show results" });
    await waitFor(() => service.store.getThread(thread.id)?.runState.status === "complete");
    const message = service.thread(thread.id).messages.at(-1)!;
    const attachment = message.parts.find((part) => part.type === "attachment")!;
    const app = message.parts.find((part) => part.type === "mcp_app")!;
    expect(attachment.contentUrl).toMatch(/^\/api\/v1\/threads\//u);
    expect(app.resourceUrl).toContain("/mcp-apps/");
    expect(app.bridgeUrl).toContain("/requests?");

    const attachmentUrl = new URL(attachment.contentUrl!, "http://console.local");
    const attachmentResult = await service.replyAttachment(
      thread.id,
      message.id,
      attachment.id,
      attachmentUrl.searchParams.get("expires")!,
      attachmentUrl.searchParams.get("token")!,
    );
    expect(await attachmentResult.response.text()).toBe("report");
    await expect(service.replyAttachment(
      thread.id,
      "different-message",
      attachment.id,
      attachmentUrl.searchParams.get("expires")!,
      attachmentUrl.searchParams.get("token")!,
    )).rejects.toMatchObject({ code: "reply_part_not_found" });

    const appUrl = new URL(app.resourceUrl!, "http://console.local");
    await expect(service.mcpAppResource(
      thread.id,
      message.id,
      app.id,
      appUrl.searchParams.get("expires")!,
      appUrl.searchParams.get("token")!,
    )).resolves.toMatchObject({ connected: true, html: expect.stringContaining("chart") });
    await expect(service.mcpAppRequest(
      thread.id,
      message.id,
      app.id,
      appUrl.searchParams.get("expires")!,
      appUrl.searchParams.get("token")!,
      { method: "tools/call", params: { name: "refresh_chart" } },
    )).rejects.toMatchObject({ code: "mcp_app_confirmation_required" });
    await expect(service.mcpAppRequest(
      thread.id,
      message.id,
      app.id,
      appUrl.searchParams.get("expires")!,
      appUrl.searchParams.get("token")!,
      { method: "tools/call", params: { name: "refresh_chart" }, confirmed: true },
    )).resolves.toEqual({ refreshed: true });
    expect(bridgeCalls[0]).toMatchObject({
      body: { method: "tools/call", params: { name: "refresh_chart" }, confirmed: true },
      headers: { "x-mono-agent-mcp-connection-id": "connection-one" },
    });

    clockMs += 11 * 60 * 1_000;
    await expect(service.replyAttachment(
      thread.id,
      message.id,
      attachment.id,
      attachmentUrl.searchParams.get("expires")!,
      attachmentUrl.searchParams.get("token")!,
    )).rejects.toMatchObject({ code: "reply_access_expired", status: 410 });
    await expect(service.mcpAppResource(
      thread.id,
      message.id,
      app.id,
      appUrl.searchParams.get("expires")!,
      appUrl.searchParams.get("token")!,
    )).rejects.toMatchObject({ code: "reply_access_expired", status: 410 });
    await expect(service.mcpAppRequest(
      thread.id,
      message.id,
      app.id,
      appUrl.searchParams.get("expires")!,
      appUrl.searchParams.get("token")!,
      { method: "resources/read", params: { uri: app.resourceUri } },
    )).rejects.toMatchObject({ code: "reply_access_expired", status: 410 });

    const originalToken = attachmentUrl.searchParams.get("token")!;
    const forgedToken = `${originalToken.slice(0, -1)}${originalToken.endsWith("x") ? "y" : "x"}`;
    await expect(service.replyAttachment(
      thread.id,
      message.id,
      attachment.id,
      attachmentUrl.searchParams.get("expires")!,
      forgedToken,
    )).rejects.toMatchObject({ code: "reply_part_not_found", status: 404 });
    const otherThread = service.createThread("agent-one");
    await expect(service.replyAttachment(
      otherThread.id,
      message.id,
      attachment.id,
      attachmentUrl.searchParams.get("expires")!,
      originalToken,
    )).rejects.toMatchObject({ code: "reply_part_not_found", status: 404 });
    await expect(service.replyAttachment(
      thread.id,
      message.id,
      "unknown-part",
      attachmentUrl.searchParams.get("expires")!,
      originalToken,
    )).rejects.toMatchObject({ code: "reply_part_not_found", status: 404 });

    const refreshedAttachment = service.replyPartAccess(thread.id, message.id, attachment.id, "attachment");
    const refreshedApp = service.replyPartAccess(thread.id, message.id, app.id, "mcp_app");
    if (refreshedAttachment.type !== "attachment" || refreshedApp.type !== "mcp_app") {
      throw new Error("Expected refreshed rich reply parts.");
    }
    expect(refreshedAttachment.contentUrl).not.toBe(attachment.contentUrl);
    expect(refreshedApp.resourceUrl).not.toBe(app.resourceUrl);
    const refreshedAttachmentUrl = new URL(refreshedAttachment.contentUrl!, "http://console.local");
    await expect(service.replyAttachment(
      thread.id,
      message.id,
      attachment.id,
      refreshedAttachmentUrl.searchParams.get("expires")!,
      refreshedAttachmentUrl.searchParams.get("token")!,
    )).resolves.toMatchObject({ part: { id: attachment.id } });

    const reconnectedMessage = service.thread(thread.id).messages.find(({ id }) => id === message.id)!;
    const reconnectedApp = reconnectedMessage.parts.find((part) => part.type === "mcp_app")!;
    expect(reconnectedApp.resourceUrl).toBe(refreshedApp.resourceUrl);
    clockMs = Date.parse("2026-08-15T12:00:00.000Z");
    expect(() => service.replyPartAccess(thread.id, message.id, attachment.id, "attachment"))
      .toThrowError(expect.objectContaining({ code: "reply_part_expired", status: 410 }));
    await service.stop();
  });

  it("reconnects a retained reply through a second service instance without extending access TTL", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const integrityId = `sha256:${"c".repeat(64)}`;
    let clockMs = Date.parse("2026-08-14T12:00:00.000Z");
    const fetchImpl = operatorFetch({
      supportsReplyAttachments: true,
      turns: () => `${JSON.stringify({
        kind: "finish",
        finalText: "Ready",
        parts: [{
          type: "attachment",
          id: "restart-file",
          reference: { scheme: "mono-agent-artifact", id: "restart-artifact" },
          name: "restart.txt",
          mediaType: "text/plain",
          sizeBytes: 2,
          integrityId,
          expiresAt: "2026-08-15T12:00:00.000Z",
        }],
      })}\n`,
      onReplyArtifact() {
        return new Response("ok", {
          headers: { "content-length": "2", "x-mono-agent-integrity-id": integrityId },
        });
      },
    });
    const options = {
      stateDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl,
      clock: () => new Date(clockMs),
    };
    const first = await WebService.create(options);
    const thread = first.createThread("agent-one");
    await first.startTurn(thread.id, { text: "restart" });
    await waitFor(() => first.store.getThread(thread.id)?.runState.status === "complete");
    const firstMessage = first.thread(thread.id).messages.at(-1)!;
    const firstPart = firstMessage.parts.find((part) => part.type === "attachment")!;
    const stale = new URL(firstPart.contentUrl!, "http://console.local");
    await first.stop();

    clockMs += 11 * 60 * 1_000;
    const second = await WebService.create(options);
    await expect(second.replyAttachment(
      thread.id,
      firstMessage.id,
      firstPart.id,
      stale.searchParams.get("expires")!,
      stale.searchParams.get("token")!,
    )).rejects.toMatchObject({ code: "reply_access_expired", status: 410 });
    const secondMessage = second.thread(thread.id).messages.find(({ id }) => id === firstMessage.id)!;
    const secondPart = secondMessage.parts.find((part) => part.type === "attachment")!;
    expect(secondPart.contentUrl).not.toBe(firstPart.contentUrl);
    const fresh = new URL(secondPart.contentUrl!, "http://console.local");
    await expect(second.replyAttachment(
      thread.id,
      firstMessage.id,
      secondPart.id,
      fresh.searchParams.get("expires")!,
      fresh.searchParams.get("token")!,
    )).resolves.toMatchObject({ part: { id: "restart-file" } });
    await second.stop();
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
    let cancelSettled = false;
    let turnAbortReason: unknown;
    let turnAbortedAfterCancel = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return operatorFetch()(input, init);
      if (url.endsWith("/cancel")) {
        await Promise.resolve();
        cancelSettled = true;
        return Response.json({ cancelled: true }, { status: 202 });
      }
      if (url.endsWith("/v1/turns")) {
        if (init?.signal?.aborted === true) throw init.signal.reason;
        return new Promise<Response>((_resolvePromise, reject) => {
          init?.signal?.addEventListener("abort", () => {
            turnAbortReason = init.signal?.reason;
            turnAbortedAfterCancel = cancelSettled;
            reject(init.signal?.reason);
          }, { once: true });
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
    expect(isChannelUserCancelReason(turnAbortReason)).toBe(true);
    expect(turnAbortedAfterCancel).toBe(true);
    await service.stop();
  });

  it("keeps web-service shutdown cancellation unbranded", async () => {
    let turnAbortReason: unknown;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return operatorFetch()(input, init);
      if (url.endsWith("/v1/turns")) {
        if (init?.signal?.aborted === true) {
          turnAbortReason = init.signal.reason;
          throw init.signal.reason;
        }
        return new Promise<Response>((_resolvePromise, reject) => {
          init?.signal?.addEventListener("abort", () => {
            turnAbortReason = init.signal?.reason;
            reject(init.signal?.reason);
          }, { once: true });
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const thread = service.createThread("agent-one");
    await service.startTurn(thread.id, { text: "wait" });

    await service.stop();

    expect(turnAbortReason).toMatchObject({ name: "WebTurnCancellation", kind: "shutdown" });
    expect(isChannelUserCancelReason(turnAbortReason)).toBe(false);
  });

  it("proxies the agent model catalog, forwarding bounded params and seeding tier-2 admission", async () => {
    const requests: string[] = [];
    const service = await createService({
      fetchImpl: operatorFetch({
        modelsPage: {
          models: [
            { id: "onlycatalog", name: "Catalog Only", provider: "provider", providerLabel: "Provider" },
          ],
          truncated: true,
        },
        onModelsRequest: (url) => { requests.push(url); },
      }),
    });
    const thread = service.createThread("agent-one");
    await expect(service.startTurn(thread.id, { text: "proto", model: "onlycatalog" })).rejects.toMatchObject({ code: "invalid_model" });

    const page = await service.agentModels("agent-one", { provider: "provider", q: "catalog", cursor: "w1", limit: 77 });
    expect(page).toEqual({
      models: [{ id: "onlycatalog", name: "Catalog Only", provider: "provider", providerLabel: "Provider" }],
      truncated: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("provider=provider");
    expect(requests[0]).toContain("q=catalog");
    expect(requests[0]).toContain("cursor=w1");
    expect(requests[0]).toContain("limit=77");

    const admitted = service.createThread("agent-one");
    await expect(service.startTurn(admitted.id, { text: "catalog", model: "onlycatalog" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });


  it("carries the agent's advertised providers through to the bootstrap summary", async () => {
    // The gap this covers: `/v1/info.providers` was parsed nowhere, so the
    // console never learned which providers existed. The selector's chips and
    // groups are built from that list, so a provider declared purely to widen
    // selection was unreachable -- its catalog page could never be requested.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        providers: [
          { id: "provider", label: "Provider", modelCount: 2, source: "builtin", configured: true },
          { id: "anthropic", label: "Anthropic", modelCount: 13, source: "builtin", configured: true },
          { id: "bad", modelCount: 1, source: "builtin" },
          { label: "no id", modelCount: 1, source: "builtin" },
        ],
        capabilities: { attachments: true },
      });
      return operatorFetch()(input, init);
    }) as typeof fetch;

    const service = await createService({ fetchImpl });
    const summary = (await service.bootstrap()).agents[0];
    expect(summary?.providers?.map((provider) => provider.id))
      .toEqual(["provider", "anthropic", "bad"]);
    // A missing label falls back to the id rather than dropping the provider,
    // and a malformed entry is skipped instead of throwing -- a throw here
    // becomes a 500 for the whole /v1/info response and shows the agent offline.
    expect(summary?.providers?.find((provider) => provider.id === "bad")?.label).toBe("bad");
  });

  it("accepts efforts for a catalog-widened model the shortlist never described", async () => {
    // `modelOptions` covers only the configured shortlist, so a model reached
    // through the catalog had no entry and every effort the selector offered
    // for it came back 400 invalid_effort.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        return Response.json({
          models: [{ id: "widened", name: "Widened", provider: "anthropic", providerLabel: "Anthropic" }],
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    await service.agentModels("agent-one", { provider: "anthropic", limit: 50 });

    // The shortlist model keeps its narrow advertised ladder.
    const narrow = service.createThread("agent-one");
    await expect(service.startTurn(narrow.id, { text: "narrow", model: "provider/default", effort: "max" }))
      .rejects.toMatchObject({ code: "invalid_effort" });

    // A catalog model the shortlist never described accepts the global ladder.
    const widened = service.createThread("agent-one");
    await expect(service.startTurn(widened.id, { text: "widened", model: "anthropic:widened", effort: "high" }))
      .resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("judges a catalog model's effort against the ladder its own page advertised", async () => {
    // The page carries reasoning metadata that tier-2 admission threw away --
    // it kept only the reference -- so effort validation had nothing to judge
    // against and forwarded a grade the model does not support in the turn.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        return Response.json({
          models: [
            {
              id: "graded",
              name: "Graded",
              provider: "anthropic",
              providerLabel: "Anthropic",
              reasoning: true,
              effortLevels: ["low", "high"],
            },
            {
              id: "instant",
              name: "Instant",
              provider: "anthropic",
              providerLabel: "Anthropic",
              reasoning: false,
            },
            { id: "quiet", name: "Quiet", provider: "anthropic", providerLabel: "Anthropic" },
          ],
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    await service.agentModels("agent-one", { provider: "anthropic", limit: 50 });

    // An advertised grade still starts, addressed by the canonical reference
    // every selection surface speaks.
    const graded = service.createThread("agent-one");
    await expect(service.startTurn(graded.id, { text: "graded", model: "anthropic:graded", effort: "high" }))
      .resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);

    // A grade the page did not list is rejected instead of forwarded.
    const ungraded = service.createThread("agent-one");
    await expect(service.startTurn(ungraded.id, { text: "ungraded", model: "anthropic:graded", effort: "ultra" }))
      .rejects.toMatchObject({ code: "invalid_effort" });

    // A non-reasoning catalog model takes no effort at all.
    const instant = service.createThread("agent-one");
    await expect(service.startTurn(instant.id, { text: "instant", model: "anthropic:instant", effort: "low" }))
      .rejects.toMatchObject({ code: "invalid_effort" });

    // A page that advertised no reasoning metadata keeps the permissive floor:
    // silence is not a claim that the model rejects every grade.
    const quiet = service.createThread("agent-one");
    await expect(service.startTurn(quiet.id, { text: "quiet", model: "anthropic:quiet", effort: "ultra" }))
      .resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("applies a conditional run-config patch only while the conversation has no override", async () => {
    // The console adopts a browser-local override into the thread exactly once,
    // and it decides to on a projection it read a round trip earlier. Another
    // tab (or another device) can set a real override in that window, and an
    // unconditional write then makes the adopting tab's stale value final.
    // Only the server can rule on it, so the write carries the precondition.
    const service = await createService({});
    const thread = service.createThread("agent-one");

    expect(service.patchThread(thread.id, { model: "anthropic:opus-5", ifRunConfigUnset: true }))
      .toMatchObject({ runModel: "anthropic:opus-5", runEffort: null });

    // A second adopter finds the conversation already configured: nothing is
    // written, and it is handed the value that won so it can adopt it.
    const contested = service.patchThread(thread.id, {
      model: "anthropic:sonnet-5",
      effort: "high",
      ifRunConfigUnset: true,
    });
    expect(contested).toMatchObject({ runModel: "anthropic:opus-5", runEffort: null });
    expect(service.thread(thread.id)?.thread)
      .toMatchObject({ runModel: "anthropic:opus-5", runEffort: null });

    // The operator's own writes are unconditional and still replace it.
    expect(service.patchThread(thread.id, { model: "anthropic:sonnet-5" }))
      .toMatchObject({ runModel: "anthropic:sonnet-5" });

    // A cleared conversation is adoptable again, so the precondition cannot
    // permanently lock the legacy path out.
    service.patchThread(thread.id, { model: null, effort: null });
    expect(service.patchThread(thread.id, { effort: "low", ifRunConfigUnset: true }))
      .toMatchObject({ runModel: null, runEffort: "low" });

    expect(() => service.patchThread("missing-thread", { model: "x", ifRunConfigUnset: true }))
      .toThrowError(/not found/iu);
    await service.stop();
  });

  it("drops catalog metadata that belonged to a replaced generation of the agent", async () => {
    // A source id is stable across restarts by design, so it cannot scope what
    // the running process told us. Reconfigure an agent and restart it and the
    // NEW process advertises a different catalog under the SAME id -- and the
    // old generation's ladder went on rejecting grades the running agent
    // accepts, with no way to clear it short of restarting the console.
    let generation = 1;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        return Response.json({
          models: generation === 1
            ? [
                {
                  id: "evolving",
                  name: "Evolving",
                  provider: "localx",
                  providerLabel: "Local X",
                  reasoning: true,
                  effortLevels: ["low"],
                },
                { id: "retired", name: "Retired", provider: "localx", providerLabel: "Local X" },
              ]
            : [{ id: "evolving", name: "Evolving", provider: "localx", providerLabel: "Local X" }],
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;

    const first = fakeDiscoveredAgent();
    const second = fakeDiscoveredAgent({
      baseUrl: "http://127.0.0.1:45124/gui",
      source: { ...first.source, pid: 456, startedAt: "2026-07-18T08:00:00.000Z" },
    });
    let discovered = [first];
    const service = await createService({
      fetchImpl,
      discoverImpl: async () => discovered,
    });
    await service.agentModels("agent-one", { provider: "localx", limit: 50 });

    const stale = service.createThread("agent-one");
    await expect(service.startTurn(stale.id, { text: "gen1", model: "localx:evolving", effort: "high" }))
      .rejects.toMatchObject({ code: "invalid_effort" });

    generation = 2;
    discovered = [second];
    await service.refreshAgents();

    // Generation 1's admissions are gone with it: a bare id the new page never
    // served fails the syntactic floor and is no longer selectable.
    const retired = service.createThread("agent-one");
    await expect(service.startTurn(retired.id, { text: "retired", model: "retired" }))
      .rejects.toMatchObject({ code: "invalid_model" });

    // And generation 2's silence about `evolving` restores the permissive
    // floor rather than inheriting generation 1's low-only ladder.
    await service.agentModels("agent-one", { provider: "localx", limit: 50 });
    const fresh = service.createThread("agent-one");
    await expect(service.startTurn(fresh.id, { text: "gen2", model: "localx:evolving", effort: "high" }))
      .resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);

    // A source discovery stops reporting takes its refs with it, so a retired
    // agent cannot hold them for the life of the console process. The bare id
    // proves it: nothing but the cache ever admitted that one.
    const bare = service.createThread("agent-one");
    await expect(service.startTurn(bare.id, { text: "bare", model: "evolving" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    discovered = [];
    await service.refreshAgents();
    discovered = [second];
    await service.refreshAgents();
    const readmitted = service.createThread("agent-one");
    await expect(service.startTurn(readmitted.id, { text: "bare", model: "evolving" }))
      .rejects.toMatchObject({ code: "invalid_model" });
    await service.stop();
  });

  it("never admits a page fetched under one generation into the generation that replaced it", async () => {
    // The page is proxied across an await. A discovery refresh can retire this
    // agent's generation inside that window, and keyed by source id alone the
    // reply -- from a process that no longer exists -- was written straight
    // into the freshly reconciled map, where `source: "page"` overwrites
    // unconditionally. Generation 1's ladder then judged generation 2's turns.
    let heldModelsPage: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { heldModelsPage = resolve; });
    let modelPages = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        modelPages += 1;
        if (modelPages === 1) await held;
        return Response.json({
          models: [{
            id: "strict",
            name: "Strict",
            provider: "localx",
            providerLabel: "Local X",
            reasoning: true,
            effortLevels: ["low"],
          }],
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;

    const first = fakeDiscoveredAgent();
    const second = fakeDiscoveredAgent({
      baseUrl: "http://127.0.0.1:45124/gui",
      source: { ...first.source, pid: 456, startedAt: "2026-07-18T08:00:00.000Z" },
    });
    let discovered = [first];
    const service = await createService({ fetchImpl, discoverImpl: async () => discovered });

    const stalePage = service.agentModels("agent-one", { provider: "localx", limit: 50 });
    await waitFor(() => modelPages === 1);
    discovered = [second];
    await service.refreshAgents();
    heldModelsPage?.();
    await stalePage;

    // Generation 2 has said nothing about `localx:strict`, so the permissive
    // floor applies. If generation 1's page were admitted here, its low-only
    // ladder would reject the grade the running agent accepts.
    const contaminated = service.createThread("agent-one");
    await expect(service.startTurn(contaminated.id, {
      text: "gen2",
      model: "localx:strict",
      effort: "high",
    })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);

    // The other half of the invariant: a page fetched WITHIN generation 2 is
    // still admitted, so this is dropping stale writes rather than all of them.
    await service.agentModels("agent-one", { provider: "localx", limit: 50 });
    const current = service.createThread("agent-one");
    await expect(service.startTurn(current.id, {
      text: "gen2-fresh",
      model: "localx:strict",
      effort: "high",
    })).rejects.toMatchObject({ code: "invalid_effort" });
    await expect(service.startTurn(current.id, {
      text: "gen2-fresh",
      model: "localx:strict",
      effort: "low",
    })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("judges a blank selection against the route the picker offers for it", async () => {
    // A payload that advertises a shortlist but no default. The browser fell
    // back to `models[0]` while this stopped at `defaultModel` and judged
    // against the global ladder, so the picker offered no grade at all while
    // the server accepted every one of them.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        models: ["local:ungraded", "local:graded"],
        modelOptions: {
          "local:ungraded": { reasoning: false },
          "local:graded": { reasoning: true, effortLevels: ["low"] },
        },
        capabilities: { attachments: true },
      });
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });

    const blank = service.createThread("agent-one");
    await expect(service.startTurn(blank.id, { text: "blank", effort: "high" }))
      .rejects.toMatchObject({ code: "invalid_effort" });
    // And the explicit route still governs itself.
    await expect(service.startTurn(blank.id, { text: "explicit", model: "local:graded", effort: "low" }))
      .resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("leaves a lost conditional patch entirely without effect", async () => {
    // The loser must write nothing and announce nothing: an event for a write
    // that did not happen makes every other tab refetch a thread that has not
    // moved, and a revision bump makes it look as if it had.
    const service = await createService({});
    const thread = service.createThread("agent-one");
    // Effort-only, which the precondition has to cover as much as a model.
    service.patchThread(thread.id, { effort: "low" });
    const before = service.thread(thread.id)?.thread;

    const events: string[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event.type); });
    const refused = service.patchThread(thread.id, {
      model: "anthropic:opus-5",
      effort: "high",
      ifRunConfigUnset: true,
    });
    unsubscribe();

    expect(refused).toMatchObject({ runModel: null, runEffort: "low" });
    expect(service.thread(thread.id)?.thread).toEqual(before);
    expect(service.thread(thread.id)?.thread.revision).toBe(before?.revision);
    expect(events).toEqual([]);
    await service.stop();
  });

  it("lets a re-fetched page replace the ladder an earlier page advertised", async () => {
    // Within one generation the newest page is the live word on what it
    // serves. Refusing to replace known metadata with later silence pinned the
    // first page's ladder for the life of the process.
    let graded = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        return Response.json({
          models: [{
            id: "shifting",
            name: "Shifting",
            provider: "localx",
            providerLabel: "Local X",
            ...(graded ? { reasoning: true, effortLevels: ["low"] } : {}),
          }],
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    await service.agentModels("agent-one", { provider: "localx", limit: 50 });
    const narrow = service.createThread("agent-one");
    await expect(service.startTurn(narrow.id, { text: "narrow", model: "localx:shifting", effort: "high" }))
      .rejects.toMatchObject({ code: "invalid_effort" });

    graded = false;
    await service.agentModels("agent-one", { provider: "localx", limit: 50 });
    const widened = service.createThread("agent-one");
    await expect(service.startTurn(widened.id, { text: "widened", model: "localx:shifting", effort: "high" }))
      .resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("applies the thread's persisted override to a turn that omits model and effort", async () => {
    // The override is server state, so a turn this server starts -- a
    // process-job follow-up, any assistant-owned wake -- must honour the
    // selection made in that conversation rather than the agent default.
    const service = await createService({});
    const thread = service.createThread("agent-one");
    service.patchThread(thread.id, { model: "anthropic:claude-sonnet-5", effort: "high" });

    await service.startTurn(thread.id, { text: "no explicit model" });
    await waitFor(() => service.store.listActiveTurnIds().length === 0);

    const stored = service.store.getThread(thread.id);
    expect(stored?.runModel).toBe("anthropic:claude-sonnet-5");
    expect(stored?.runEffort).toBe("high");
    await service.stop();
  });

  it("keeps the syntactic floor no looser than the runtime parser", async () => {
    const service = await createService({});
    for (const model of ["bad provider:model", "UPPER:model", "provider: model", "provider:  "]) {
      const thread = service.createThread("agent-one");
      await expect(service.startTurn(thread.id, { text: "floor", model }))
        .rejects.toMatchObject({ code: "invalid_model" });
    }
    await service.stop();
  });

  it("validates model selection across shortlist, catalog cache, and provider-prefix tiers", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low", "medium", "high"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        return Response.json({
          models: [
            { id: "provider/catalog-widened", name: "Widened", provider: "provider", providerLabel: "Provider" },
            { id: "catalogonly", name: "Catalog Only", provider: "provider", providerLabel: "Provider" },
          ],
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });

    // Tier 1: the configured shortlist is unchanged and always allowed.
    const shortlist = service.createThread("agent-one");
    await expect(service.startTurn(shortlist.id, { text: "tier1", model: "provider/default" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);

    // Tier 3: a well-formed but never-seen provider ref passes the floor.
    const floor = service.createThread("agent-one");
    await expect(service.startTurn(floor.id, { text: "floor", model: "anthropic:claude-sonnet-5" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);

    // Before any catalog proxy the cache-only model is rejected (no shortlist
    // entry, no cache entry, and no colon for the floor).
    const proto = service.createThread("agent-one");
    await expect(service.startTurn(proto.id, { text: "proto", model: "catalogonly" })).rejects.toMatchObject({ code: "invalid_model" });

    const page = await service.agentModels("agent-one", { limit: 50 });
    expect(page.models.map((model) => model.id)).toEqual(["provider/catalog-widened", "catalogonly"]);

    // Tier 2: both proxied models are now selectable, including the no-colon
    // one that only the catalog cache can have admitted.
    const widened = service.createThread("agent-one");
    await expect(service.startTurn(widened.id, { text: "catalog", model: "provider/catalog-widened" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    const cacheOnly = service.createThread("agent-one");
    await expect(service.startTurn(cacheOnly.id, { text: "cache", model: "catalogonly" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    await service.stop();
  });

  it("rejects malformed provider-prefix refs that cannot reach any validation tier", async () => {
    const service = await createService({});
    for (const model of ["no-colon", ":leading", "trailing:", ""]) {
      const thread = service.createThread("agent-one");
      await expect(service.startTurn(thread.id, { text: `model ${model}`, model })).rejects.toMatchObject({ code: "invalid_model" });
    }
    await service.stop();
  });

  it("evicts the oldest catalog-admitted model at the 2048 cap and keeps the newest", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/info")) return Response.json({
        schema: 1,
        model: "provider/default",
        models: ["provider/default"],
        modelOptions: { "provider/default": { effortLevels: ["low", "high"], reasoning: true } },
        capabilities: { attachments: true },
      });
      if (/\/v1\/models(?:\?|$)/u.test(url)) {
        return Response.json({
          models: Array.from({ length: 2_049 }, (_, index) => ({
            id: `pmodel-${String(index)}`,
            name: `Model ${String(index)}`,
            provider: "provider",
            providerLabel: "Provider",
          })),
          truncated: false,
        });
      }
      return operatorFetch()(input, init);
    }) as typeof fetch;
    const service = await createService({ fetchImpl });
    const page = await service.agentModels("agent-one", { limit: 200 });
    expect(page.models).toHaveLength(2_049);

    const newest = service.createThread("agent-one");
    await expect(service.startTurn(newest.id, { text: "newest", model: "pmodel-2048" })).resolves.toBeDefined();
    await waitFor(() => service.store.listActiveTurnIds().length === 0);
    const evicted = service.createThread("agent-one");
    await expect(service.startTurn(evicted.id, { text: "evicted", model: "pmodel-0" })).rejects.toMatchObject({ code: "invalid_model" });
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
    await expect(service.startTurn(cloud.id, { text: "cloud", model: "cloud", effort: "ultra" })).rejects.toMatchObject({ code: "invalid_effort" });
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

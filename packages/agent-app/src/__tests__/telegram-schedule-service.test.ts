import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isTrustedTelegramHumanTurn,
  startTelegramScheduleService,
  type TelegramScheduleCallContext,
  type TelegramScheduleDeliverInput,
  type TelegramScheduleDeliveryResult,
  type TelegramScheduleService,
} from "../telegram-schedule-service.js";
import { openTelegramScheduleStore } from "../telegram-schedule-store.js";
import { openTelegramTopicDirectory, type TelegramTopicDirectoryStore } from "../telegram-topic-directory.js";

const CHAT = "-1001";
const GENERAL: TelegramScheduleCallContext = {
  runId: "run-1",
  producerConversationId: `telegram:${CHAT}`,
  mutate: true,
};
const SCHEDULED: TelegramScheduleCallContext = { ...GENERAL, runId: "run-sched", mutate: false };
const DAILY_8 = { kind: "cron", expression: "0 8 * * *", timezone: "Europe/Budapest" } as const;

type Deliver = (input: TelegramScheduleDeliverInput) => Promise<TelegramScheduleDeliveryResult>;

describe("Telegram schedule service", () => {
  let dir: string;
  let directory: TelegramTopicDirectoryStore;
  let allowed: Set<string>;
  const services: TelegramScheduleService[] = [];

  const start = async (deliver: Deliver, overrides: { readonly maxSchedules?: number } = {}) => {
    const service = await startTelegramScheduleService({
      cwd: dir,
      botId: "111",
      maxSchedules: overrides.maxSchedules ?? 20,
      minIntervalMinutes: 15,
      isChatAllowed: (chatId) => allowed.has(chatId),
      directory,
      deliver,
    });
    services.push(service);
    return service;
  };

  const create = async (service: TelegramScheduleService, args: Record<string, unknown>, context = GENERAL) => {
    const outcome = await service.call("create", args, context);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    return outcome.result!.schedule as Record<string, unknown>;
  };

  const list = async (service: TelegramScheduleService) => {
    const outcome = await service.call("list", {}, SCHEDULED);
    return (outcome.result!.schedules as Array<Record<string, unknown>>);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-09-28T05:00:00.000Z") });
    dir = await mkdtemp(join(tmpdir(), "tg-schedules-"));
    directory = await openTelegramTopicDirectory({ cwd: dir, botId: "111" });
    directory.observe({
      chatId: -1001,
      chatTitle: "Trips",
      topic: { messageThreadId: 77, nameRecord: { name: "Flights", source: "created", messageId: 77 } },
    });
    allowed = new Set([CHAT]);
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop();
    directory.close();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a schedule for a named topic from General without exposing routes", async () => {
    const service = await start(vi.fn<Deliver>());
    const schedule = await create(service, {
      name: "Daily flight check",
      prompt: "Check BUD-LIS fares for 12-19 May and report changes.",
      destination: { topic_name: "flights" },
      schedule: DAILY_8,
    });

    expect(schedule).toMatchObject({
      revision: 1,
      destination: "Trips › Flights",
      status: "active",
      next_run_at: "2026-09-28T06:00:00.000Z",
    });
    expect(String(schedule.id)).toMatch(/^sch_/u);
    const serialized = JSON.stringify(await list(service));
    expect(serialized).not.toMatch(/\b77\b|telegram:/u);
  });

  it("lets scheduled and background turns list but never change schedules", async () => {
    const service = await start(vi.fn<Deliver>());
    const created = await create(service, { name: "A", prompt: "p", schedule: DAILY_8 });
    for (const [operation, args] of [
      ["create", { name: "B", prompt: "p", schedule: DAILY_8 }],
      ["update", { id: created.id, expectedRevision: 1, name: "C" }],
      ["delete", { id: created.id, expectedRevision: 1 }],
    ] as const) {
      await expect(service.call(operation, args, SCHEDULED)).resolves.toMatchObject({ ok: false, code: "not_permitted" });
    }
    expect(await list(service)).toHaveLength(1);
  });

  it("fires in the destination topic, records the outcome and advances", async () => {
    const deliver = vi.fn<Deliver>(async () => ({ delivered: true }));
    const service = await start(deliver);
    await create(service, { name: "Daily", prompt: "Check fares.", destination: { topic_name: "Flights" }, schedule: DAILY_8 });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    const input = deliver.mock.calls[0]![0];
    expect(input.schedule.destination).toMatchObject({ chatId: CHAT, topicId: 77 });
    expect(input.scheduledAt).toBe("2026-09-28T06:00:00.000Z");
    await vi.waitFor(async () => {
      const [schedule] = await list(service);
      expect(schedule).toMatchObject({
        next_run_at: "2026-09-29T06:00:00.000Z",
        last_run: { execution: "succeeded", delivery: "delivered" },
      });
    });
  });

  it("keeps the stored destination after the topic is renamed", async () => {
    const deliver = vi.fn<Deliver>(async () => ({ delivered: true }));
    const service = await start(deliver);
    await create(service, { name: "Daily", prompt: "p", destination: { topic_name: "Flights" }, schedule: DAILY_8 });
    directory.observe({
      chatId: -1001,
      topic: { messageThreadId: 77, nameRecord: { name: "Flight deals", source: "edited", messageId: 500 } },
    });
    directory.observe({
      chatId: -1001,
      topic: { messageThreadId: 90, nameRecord: { name: "Flights", source: "created", messageId: 90 } },
    });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(deliver.mock.calls[0]![0].schedule.destination.topicId).toBe(77);
  });

  it("suppresses a NOTHING_TO_REPORT run and records it", async () => {
    const service = await start(async () => ({ delivered: false, code: "nothing_to_report" }));
    await create(service, { name: "Daily", prompt: "p", schedule: DAILY_8 });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    await vi.waitFor(async () => {
      expect((await list(service))[0]).toMatchObject({ last_run: { execution: "succeeded", delivery: "suppressed" } });
    });
  });

  it("blocks and pauses a schedule whose chat left the allowlist", async () => {
    const deliver = vi.fn<Deliver>(async () => ({ delivered: true }));
    const service = await start(deliver);
    await create(service, { name: "Daily", prompt: "p", schedule: DAILY_8 });
    allowed.delete(CHAT);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(deliver).not.toHaveBeenCalled();
    expect((await list(service))[0]).toMatchObject({
      status: "paused",
      paused_reason: expect.stringContaining("no longer allowlisted"),
      last_run: { execution: "blocked" },
    });
  });

  it("rejects destinations outside the allowlist, unknown names, and conflicting selectors", async () => {
    const service = await start(vi.fn<Deliver>());
    const attempt = async (destination: Record<string, unknown>) =>
      await service.call("create", { name: "X", prompt: "p", destination, schedule: DAILY_8 }, GENERAL);
    await expect(attempt({ chat_id: "-2002" })).resolves.toMatchObject({ ok: false, code: "destination_not_allowed" });
    await expect(attempt({ topic_name: "Trains" })).resolves.toMatchObject({
      ok: false,
      code: "topic_missing",
      error: expect.stringContaining('"Flights"'),
    });
    await expect(attempt({ topic_name: "Flights", main: true })).resolves.toMatchObject({ ok: false, code: "invalid_destination" });
  });

  it("enforces the minimum interval, the schedule limit and idempotent retries", async () => {
    const service = await start(vi.fn<Deliver>(), { maxSchedules: 2 });
    await expect(service.call("create", {
      name: "Too often",
      prompt: "p",
      schedule: { kind: "cron", expression: "*/5 * * * *", timezone: "UTC" },
    }, GENERAL)).resolves.toMatchObject({ ok: false, code: "invalid_schedule" });

    const args = { name: "A", prompt: "p", schedule: DAILY_8 };
    const first = await create(service, args);
    const retried = await create(service, args);
    expect(retried.id).toBe(first.id);
    await create(service, { ...args, name: "B" });
    await expect(service.call("create", { ...args, name: "C" }, GENERAL))
      .resolves.toMatchObject({ ok: false, code: "limit_reached" });
  });

  it("requires the current revision to update or delete", async () => {
    const service = await start(vi.fn<Deliver>());
    const created = await create(service, { name: "A", prompt: "p", schedule: DAILY_8 });
    const updated = await service.call("update", { id: created.id, expectedRevision: 1, name: "B" }, GENERAL);
    expect(updated.result?.schedule).toMatchObject({ name: "B", revision: 2 });
    await expect(service.call("delete", { id: created.id, expectedRevision: 1 }, GENERAL))
      .resolves.toMatchObject({ ok: false, code: "revision_conflict" });
    await expect(service.call("update", { id: created.id, expectedRevision: 2 }, GENERAL))
      .resolves.toMatchObject({ ok: false, code: "no_changes" });
    await expect(service.call("update", { id: created.id, expectedRevision: 2, enabled: false }, GENERAL))
      .resolves.toMatchObject({ ok: true, result: { schedule: { status: "paused" } } });
    await expect(service.call("delete", { id: created.id, expectedRevision: 3 }, GENERAL))
      .resolves.toMatchObject({ ok: true });
    expect(await list(service)).toEqual([]);
  });

  it("cancels an in-flight run of the old revision when the schedule changes", async () => {
    let seen: AbortSignal | undefined;
    const deliver = vi.fn<Deliver>(async ({ signal }) => {
      seen = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { delivered: false, reason: "cancelled" };
    });
    const service = await start(deliver);
    const created = await create(service, { name: "A", prompt: "p", schedule: DAILY_8 });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(seen?.aborted).toBe(false);

    await service.call("update", { id: created.id, expectedRevision: 1, prompt: "new prompt" }, GENERAL);

    expect(seen?.aborted).toBe(true);
    await vi.waitFor(async () => {
      expect((await list(service))[0]).toMatchObject({ last_run: { execution: "cancelled", delivery: "unknown" } });
    });
  });

  it("skips an occurrence while the previous run of the same schedule is still running", async () => {
    const deliver = vi.fn<Deliver>(async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { delivered: false, reason: "cancelled" };
    });
    const service = await start(deliver);
    await create(service, {
      name: "Quarterly",
      prompt: "p",
      schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
    });

    // Created at 05:00; fires at 05:15 and is still running at 05:30.
    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await list(service))[0]).toMatchObject({ last_run: { execution: "skipped_overlap" } });
  });

  it("pauses after repeated delivery failures", async () => {
    const service = await start(async () => ({ delivered: false, reason: "delivery failed" }));
    await create(service, { name: "A", prompt: "p", schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" } });
    for (let hour = 0; hour < 3; hour += 1) {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    }
    await vi.waitFor(async () => {
      expect((await list(service))[0]).toMatchObject({
        status: "paused",
        paused_reason: expect.stringContaining("3 consecutive delivery failures"),
      });
    });
  });

  it("skips occurrences missed while stopped and never runs an overdue one-off late", async () => {
    const deliver = vi.fn<Deliver>(async () => ({ delivered: true }));
    const first = await start(deliver);
    await create(first, { name: "Daily", prompt: "p", schedule: DAILY_8 });
    await create(first, { name: "Once", prompt: "p", schedule: { kind: "once", at: "2026-09-28T09:00:00+02:00" } });
    await first.stop();
    services.length = 0;

    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    const second = await start(deliver);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(deliver).not.toHaveBeenCalled();
    const schedules = await list(second);
    expect(schedules.find((schedule) => schedule.name === "Daily")).toMatchObject({
      status: "active",
      next_run_at: "2026-10-01T06:00:00.000Z",
      last_run: { execution: "missed", delivery: "not_attempted" },
    });
    expect(schedules.find((schedule) => schedule.name === "Once")).toMatchObject({
      status: "missed",
      last_run: { execution: "missed" },
    });
  });

  it("records a run interrupted by a crash without replaying it", async () => {
    const seed = await start(vi.fn<Deliver>());
    const created = await create(seed, { name: "Daily", prompt: "p", schedule: DAILY_8 });
    await seed.stop();
    services.length = 0;
    // Simulate a process that claimed the 08:00 run and died mid-turn.
    const store = await openTelegramScheduleStore({ cwd: dir });
    store.claim({
      scheduleId: String(created.id),
      revision: 1,
      scheduledAt: "2026-09-28T06:00:00.000Z",
      nextRunAt: "2026-09-29T06:00:00.000Z",
      execution: "running",
      delivery: "pending",
      fired: true,
    });
    store.close();

    const deliver = vi.fn<Deliver>(async () => ({ delivered: true }));
    const service = await start(deliver);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(deliver).not.toHaveBeenCalled();
    expect((await list(service))[0]).toMatchObject({ last_run: { execution: "interrupted", delivery: "unknown" } });
  });
});

describe("trusted Telegram human turn", () => {
  const human = {
    conversationId: "telegram:-1001",
    captureSpeakerKind: "human-turn",
    metadata: { telegram: { message: { id: 55 }, from: { id: 7 } } },
  };

  it("accepts only an inbound human Telegram message", () => {
    expect(isTrustedTelegramHumanTurn(human)).toBe(true);
    expect(isTrustedTelegramHumanTurn({ ...human, captureSpeakerKind: "unknown" })).toBe(false);
    expect(isTrustedTelegramHumanTurn({ ...human, conversationId: "web:thread" })).toBe(false);
    expect(isTrustedTelegramHumanTurn({ ...human, metadata: { telegram: { message: { id: 0 }, from: { id: 7 } } } })).toBe(false);
    expect(isTrustedTelegramHumanTurn({ ...human, metadata: { ...human.metadata, channelSchedule: {} } })).toBe(false);
    expect(isTrustedTelegramHumanTurn({ ...human, metadata: { ...human.metadata, cron: {} } })).toBe(false);
    expect(isTrustedTelegramHumanTurn({ ...human, metadata: { telegram: { message: { id: 55 } } } })).toBe(false);
    expect(isTrustedTelegramHumanTurn(undefined)).toBe(false);
  });
});

describe("Telegram schedule listing bounds", () => {
  let dir: string;
  let directory: TelegramTopicDirectoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tg-schedules-bounds-"));
    directory = await openTelegramTopicDirectory({ cwd: dir, botId: "111" });
  });
  afterEach(async () => {
    directory.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("previews long prompts in the list and keeps them whole on create", async () => {
    const service = await startTelegramScheduleService({
      cwd: dir,
      botId: "111",
      maxSchedules: 20,
      minIntervalMinutes: 15,
      isChatAllowed: () => true,
      directory,
      deliver: async () => ({ delivered: true }),
    });
    try {
      const prompt = "p".repeat(2_000);
      const created = await service.call("create", { name: "Long", prompt, schedule: DAILY_8 }, GENERAL);
      expect((created.result?.schedule as { prompt: string }).prompt).toBe(prompt);
      const listed = await service.call("list", {}, SCHEDULED);
      const [schedule] = listed.result?.schedules as Array<{ prompt: string; prompt_truncated?: boolean }>;
      expect(schedule?.prompt_truncated).toBe(true);
      expect(Array.from(schedule!.prompt).length).toBe(601);
    } finally {
      await service.stop();
    }
  });
});

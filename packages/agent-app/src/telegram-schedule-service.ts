import { createHash } from "node:crypto";

import * as z from "zod/v4";

import { telegramTargetFromConversation } from "./telegram-destination.js";
import {
  describeTopicResolutionFailure,
  resolveTopicByName,
  sanitizeTelegramLabel,
  telegramDestinationLabel,
  type TelegramTopicDirectoryStore,
} from "./telegram-topic-directory.js";
import {
  openTelegramScheduleStore,
  TelegramScheduleConflictError,
  type TelegramScheduleDelivery,
  type TelegramScheduleDestination,
  type TelegramScheduleExecution,
  type TelegramScheduleRecord,
  type TelegramScheduleStore,
} from "./telegram-schedule-store.js";
import {
  nextTelegramScheduleOccurrence,
  TelegramScheduleTimingError,
  validateTelegramScheduleTiming,
  type TelegramScheduleTiming,
} from "./telegram-schedule-timing.js";

/**
 * Agent-managed Telegram schedules (`telegram.schedules`).
 *
 * The service owns the durable store (and its exclusive lease), answers the
 * schedule tools through the interaction bridge, and fires due schedules.
 * Trust model: single user, like the web console. Any human turn admitted from
 * an allowlisted chat may manage every schedule of this agent; the chat
 * allowlist is the only boundary and is re-checked at create/update, before
 * firing and before delivery. Scheduled and other background turns receive a
 * list-only capability, so a schedule cannot create more schedules.
 *
 * Firing never runs late: a recurring occurrence missed by more than the grace
 * window is skipped, an overdue one-off becomes `missed`, and a run the agent
 * was stopped in the middle of is recorded `interrupted` with unknown delivery
 * and never replayed.
 */

export const TELEGRAM_SCHEDULE_TOOL_NAMES = [
  "TelegramListSchedules",
  "TelegramCreateSchedule",
  "TelegramUpdateSchedule",
  "TelegramDeleteSchedule",
] as const;
export const TELEGRAM_SCHEDULE_MUTATION_TOOL_NAMES: readonly string[] = [
  "TelegramCreateSchedule",
  "TelegramUpdateSchedule",
  "TelegramDeleteSchedule",
];

/**
 * Whether a request is a turn a person started by sending a message in a
 * Telegram chat. Only such a turn may create, change or delete schedules. The
 * fields read here are stamped by the host adapter, never by the model:
 * scheduled, cron, webhook and process-job turns carry no inbound message and
 * no human speaker, and a scheduled turn is additionally marked.
 */
export function isTrustedTelegramHumanTurn(request: {
  readonly conversationId?: string;
  readonly captureSpeakerKind?: string;
  readonly metadata?: Record<string, unknown>;
} | undefined): boolean {
  if (request === undefined || request.captureSpeakerKind !== "human-turn") return false;
  if (typeof request.conversationId !== "string" || !request.conversationId.startsWith("telegram:")) return false;
  const metadata = request.metadata;
  if (metadata === undefined
    || metadata.channelSchedule !== undefined
    || metadata.cron !== undefined
    || metadata.webhook !== undefined) {
    return false;
  }
  const telegram = metadata.telegram;
  if (typeof telegram !== "object" || telegram === null) return false;
  const message = (telegram as { message?: unknown }).message;
  const from = (telegram as { from?: unknown }).from;
  const messageId = typeof message === "object" && message !== null ? (message as { id?: unknown }).id : undefined;
  return typeof messageId === "number" && messageId > 0 && typeof from === "object" && from !== null;
}

export const TELEGRAM_SCHEDULE_NAME_MAX_CHARS = 100;
export const TELEGRAM_SCHEDULE_PROMPT_MAX_BYTES = 8_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_WATCHDOG_MS = 20 * 60 * 1_000;
const DEFAULT_MISSED_GRACE_MS = 2 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 60 * 60 * 1_000;
const DELIVERY_FAILURE_PAUSE_THRESHOLD = 3;
const STOP_SETTLE_TIMEOUT_MS = 5_000;
const MAX_DETAIL_CHARS = 300;
/** Finished one-offs shown by the list tool, newest first. */
const LIST_FINISHED_MAX = 10;
/** Prompt characters shown per schedule by the list tool; create/update return it whole. */
const LIST_PROMPT_PREVIEW_CHARS = 600;

/** What the Telegram delivery path reports for one scheduled turn. */
export interface TelegramScheduleDeliveryResult {
  readonly delivered: boolean;
  readonly reason?: string;
  readonly code?: string;
}

export interface TelegramScheduleDeliverInput {
  readonly schedule: TelegramScheduleRecord;
  readonly scheduledAt: string;
  readonly signal: AbortSignal;
}

export interface TelegramScheduleServiceOptions {
  readonly cwd: string;
  readonly botId: string;
  readonly maxSchedules: number;
  readonly minIntervalMinutes: number;
  readonly isChatAllowed: (chatId: string) => boolean;
  readonly directory: TelegramTopicDirectoryStore;
  /** Run the schedule's turn in its destination conversation and deliver the answer. */
  readonly deliver: (input: TelegramScheduleDeliverInput) => Promise<TelegramScheduleDeliveryResult>;
  readonly now?: () => Date;
  readonly maxConcurrentRuns?: number;
  readonly watchdogMs?: number;
  readonly missedGraceMs?: number;
  readonly logger?: {
    info?: (message: string, metadata?: Record<string, unknown>) => void;
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
  };
  /** Test seam: an already-open store. */
  readonly store?: TelegramScheduleStore;
}

/** Trusted, host-bound context for one bridge call; never taken from tool arguments. */
export interface TelegramScheduleCallContext {
  readonly runId: string;
  readonly producerConversationId: string;
  /** False for scheduled/background turns: listing only. */
  readonly mutate: boolean;
}

export interface TelegramScheduleCallResult {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly code?: string;
}

export interface TelegramScheduleService {
  call(operation: string, args: unknown, context: TelegramScheduleCallContext): Promise<TelegramScheduleCallResult>;
  stop(): Promise<void>;
}

const destinationSchema = z.object({
  chat_id: z.union([z.string().min(1), z.number().int()]).optional(),
  topic_name: z.string().min(1).max(256).optional(),
  main: z.literal(true).optional(),
}).strict();

const timingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().min(1).max(64) }).strict(),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1).max(128),
    timezone: z.string().min(1).max(64),
  }).strict(),
]);

const nameSchema = z.string().trim().min(1).max(TELEGRAM_SCHEDULE_NAME_MAX_CHARS);
const promptSchema = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= TELEGRAM_SCHEDULE_PROMPT_MAX_BYTES,
  { message: `prompt must be at most ${String(TELEGRAM_SCHEDULE_PROMPT_MAX_BYTES)} UTF-8 bytes` },
);

const createArgsSchema = z.object({
  name: nameSchema,
  prompt: promptSchema,
  destination: destinationSchema.optional(),
  schedule: timingSchema,
}).strict();

const updateArgsSchema = z.object({
  id: z.string().min(1).max(64),
  expectedRevision: z.number().int().positive(),
  name: nameSchema.optional(),
  prompt: promptSchema.optional(),
  destination: destinationSchema.optional(),
  schedule: timingSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

const deleteArgsSchema = z.object({
  id: z.string().min(1).max(64),
  expectedRevision: z.number().int().positive(),
}).strict();

class ScheduleRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface InFlightRun {
  readonly runId: string;
  readonly revision: number;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  timedOut: boolean;
}

export async function startTelegramScheduleService(
  options: TelegramScheduleServiceOptions,
): Promise<TelegramScheduleService> {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? await openTelegramScheduleStore({ cwd: options.cwd, now });
  const maxConcurrent = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const graceMs = options.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
  const inFlight = new Map<string, InFlightRun>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let ticking = false;

  const interrupted = store.reconcileInterrupted();
  if (interrupted > 0) {
    options.logger?.warn?.("Telegram schedules: runs interrupted by the last stop were recorded, not replayed.", {
      interrupted,
    });
  }

  function arm(): void {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    let earliest: number | undefined;
    for (const schedule of store.list(options.botId)) {
      if (schedule.state !== "active" || schedule.nextRunAt === undefined) continue;
      const at = Date.parse(schedule.nextRunAt);
      if (earliest === undefined || at < earliest) earliest = at;
    }
    if (earliest === undefined) return;
    const delay = Math.min(Math.max(earliest - now().getTime(), 0), MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, delay);
    timer.unref?.();
  }

  function tick(): void {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const current = now();
      for (const schedule of store.list(options.botId)) {
        if (schedule.state !== "active" || schedule.nextRunAt === undefined) continue;
        if (Date.parse(schedule.nextRunAt) > current.getTime()) continue;
        try {
          fire(schedule, current);
        } catch (error) {
          options.logger?.warn?.("Telegram schedules: a due schedule could not be processed.", {
            scheduleId: schedule.id,
            error: errorText(error),
          });
        }
      }
    } finally {
      ticking = false;
      arm();
    }
  }

  function fire(schedule: TelegramScheduleRecord, current: Date): void {
    const scheduledAt = schedule.nextRunAt!;
    const scheduledMs = Date.parse(scheduledAt);
    const next = schedule.timing.kind === "cron"
      ? nextTelegramScheduleOccurrence(schedule.timing, new Date(Math.max(current.getTime(), scheduledMs)))
      : undefined;
    const skip = (execution: TelegramScheduleExecution, detail: string): void => {
      store.claim({
        scheduleId: schedule.id,
        revision: schedule.revision,
        scheduledAt,
        nextRunAt: next?.toISOString(),
        execution,
        delivery: "not_attempted",
        detail,
        fired: false,
      });
    };
    if (current.getTime() - scheduledMs > graceMs) {
      skip("missed", "The agent was not running at the scheduled time; missed runs are skipped, never run late.");
      return;
    }
    if (inFlight.has(schedule.id)) {
      skip("skipped_overlap", "The previous run of this schedule was still in progress.");
      return;
    }
    if (inFlight.size >= maxConcurrent) {
      skip("skipped_capacity", `Too many scheduled runs were in progress (limit ${String(maxConcurrent)}).`);
      return;
    }
    if (schedule.timing.kind === "cron"
      && schedule.lastFiredAt !== undefined
      && current.getTime() - Date.parse(schedule.lastFiredAt) < options.minIntervalMinutes * 60_000) {
      skip("skipped_interval", "The configured minimum interval had not elapsed since the previous run.");
      return;
    }
    if (!options.isChatAllowed(schedule.destination.chatId)) {
      skip("blocked", "The destination chat is no longer allowlisted.");
      store.recordDeliveryStreak(schedule.id, schedule.revision, true, "Paused: the destination chat is no longer allowlisted.");
      return;
    }
    const run = store.claim({
      scheduleId: schedule.id,
      revision: schedule.revision,
      scheduledAt,
      nextRunAt: next?.toISOString(),
      execution: "running",
      delivery: "pending",
      fired: true,
    });
    if (run === undefined) return;
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const entry: InFlightRun = { runId: run.runId, revision: schedule.revision, controller, settled, timedOut: false };
    inFlight.set(schedule.id, entry);
    const watchdog = setTimeout(() => {
      entry.timedOut = true;
      controller.abort(new Error("scheduled run exceeded its watchdog"));
    }, watchdogMs);
    watchdog.unref?.();
    void (async () => {
      let outcome: { execution: TelegramScheduleExecution; delivery: TelegramScheduleDelivery; detail?: string };
      try {
        // Revalidate immediately before model work and delivery.
        if (!options.isChatAllowed(schedule.destination.chatId)) {
          outcome = { execution: "blocked", delivery: "not_attempted", detail: "The destination chat is no longer allowlisted." };
        } else {
          const result = await options.deliver({ schedule, scheduledAt, signal: controller.signal });
          outcome = classifyDelivery(result, entry.timedOut);
        }
      } catch (error) {
        outcome = { execution: "failed", delivery: "unknown", detail: bounded(errorText(error)) };
      } finally {
        clearTimeout(watchdog);
      }
      try {
        store.finishRun(run.runId, outcome);
        if (outcome.delivery === "failed" || outcome.execution === "blocked") {
          const streak = (store.get(schedule.id)?.consecutiveDeliveryFailures ?? 0) + 1;
          store.recordDeliveryStreak(
            schedule.id,
            schedule.revision,
            true,
            outcome.execution === "blocked"
              ? "Paused: the destination chat is no longer allowlisted."
              : streak >= DELIVERY_FAILURE_PAUSE_THRESHOLD
                ? `Paused after ${String(streak)} consecutive delivery failures to ${schedule.destination.label}.`
                : undefined,
          );
        } else if (outcome.delivery === "delivered" || outcome.delivery === "suppressed") {
          store.recordDeliveryStreak(schedule.id, schedule.revision, false);
        }
      } catch (error) {
        options.logger?.warn?.("Telegram schedules: a run outcome could not be recorded.", {
          scheduleId: schedule.id,
          error: errorText(error),
        });
      } finally {
        if (inFlight.get(schedule.id) === entry) inFlight.delete(schedule.id);
        resolveSettled();
        arm();
      }
    })();
  }

  /** Abort an in-flight run whose schedule changed, so its result is never delivered. */
  function fenceInFlight(scheduleId: string): void {
    const entry = inFlight.get(scheduleId);
    entry?.controller.abort(new Error("schedule changed while its run was in flight"));
  }

  function resolveDestination(
    destination: z.infer<typeof destinationSchema> | undefined,
    context: TelegramScheduleCallContext,
  ): TelegramScheduleDestination {
    const producer = telegramTargetFromConversation(context.producerConversationId);
    const chatId = destination?.chat_id === undefined
      ? producer === undefined ? undefined : String(producer.chatId)
      : String(destination.chat_id).trim();
    if (chatId === undefined) {
      throw new ScheduleRequestError("destination_required", "destination.chat_id is required outside a Telegram conversation.");
    }
    if (!options.isChatAllowed(chatId)) {
      throw new ScheduleRequestError("destination_not_allowed", "destination.chat_id is not an allowlisted Telegram chat.");
    }
    if (destination?.topic_name !== undefined && destination.main === true) {
      throw new ScheduleRequestError("invalid_destination", "Use either destination.topic_name or destination.main, not both.");
    }
    const snapshot = options.directory.chatSnapshot(chatId);
    if (destination?.topic_name !== undefined) {
      const resolution = resolveTopicByName(snapshot, destination.topic_name);
      if (resolution.kind !== "found") {
        throw new ScheduleRequestError(
          `topic_${resolution.kind}`,
          describeTopicResolutionFailure("destination.topic_name", destination.topic_name, resolution, snapshot),
        );
      }
      return {
        chatId,
        topicId: resolution.topic.topicId,
        label: telegramDestinationLabel(snapshot, chatId, resolution.topic.name, false),
      };
    }
    const sameChat = producer !== undefined && String(producer.chatId) === chatId;
    const topicId = destination?.main === true || !sameChat ? undefined : producer?.messageThreadId;
    if (topicId === undefined) {
      return { chatId, label: telegramDestinationLabel(snapshot, chatId, undefined, true) };
    }
    const topicName = snapshot.topics.find((topic) => topic.topicId === topicId)?.name;
    return { chatId, topicId, label: telegramDestinationLabel(snapshot, chatId, topicName, false) };
  }

  function validateTiming(timing: TelegramScheduleTiming): { timing: TelegramScheduleTiming; nextRunAt: string } {
    const current = now();
    let normalized: TelegramScheduleTiming;
    try {
      normalized = validateTelegramScheduleTiming(timing, { now: current, minIntervalMinutes: options.minIntervalMinutes });
    } catch (error) {
      if (error instanceof TelegramScheduleTimingError) throw new ScheduleRequestError("invalid_schedule", error.message);
      throw error;
    }
    const next = nextTelegramScheduleOccurrence(normalized, current);
    if (next === undefined) {
      throw new ScheduleRequestError("invalid_schedule", "The schedule has no future occurrence.");
    }
    return { timing: normalized, nextRunAt: next.toISOString() };
  }

  async function handle(
    operation: string,
    args: unknown,
    context: TelegramScheduleCallContext,
  ): Promise<Record<string, unknown>> {
    const actor = `telegram-turn:${context.producerConversationId}`;
    if (operation === "list") {
      const schedules = store.list(options.botId);
      const live = schedules.filter((schedule) => schedule.state === "active" || schedule.state === "paused");
      const finished = schedules
        .filter((schedule) => schedule.state === "completed" || schedule.state === "missed")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, LIST_FINISHED_MAX);
      return {
        schedules: [...live, ...finished].map((schedule) => scheduleView(schedule, { promptPreview: true })),
        limit: options.maxSchedules,
        live: live.length,
      };
    }
    if (!context.mutate) {
      throw new ScheduleRequestError(
        "not_permitted",
        "Schedules can only be changed from a message a person sends in an allowlisted Telegram chat, not from a scheduled or background run.",
      );
    }
    if (operation === "create") {
      const parsed = parseArgs(createArgsSchema, args);
      const destination = resolveDestination(parsed.destination, context);
      const { timing, nextRunAt } = validateTiming(parsed.schedule);
      const created = store.create({
        botId: options.botId,
        name: parsed.name,
        prompt: parsed.prompt,
        timing,
        destination,
        producerConversationId: context.producerConversationId,
        nextRunAt,
        createKey: `${context.runId}:${createHash("sha256").update(JSON.stringify(args)).digest("base64url")}`,
      }, options.maxSchedules, actor);
      arm();
      return { schedule: scheduleView(created) };
    }
    if (operation === "update") {
      const parsed = parseArgs(updateArgsSchema, args);
      const { id, expectedRevision, enabled, ...changes } = parsed;
      if (Object.keys(changes).length === 0 && enabled === undefined) {
        throw new ScheduleRequestError("no_changes", "Provide at least one field to change.");
      }
      const existing = store.get(id);
      if (existing === undefined || existing.botId !== options.botId) {
        throw new ScheduleRequestError("not_found", "No schedule has that id.");
      }
      const destination = changes.destination === undefined ? undefined : resolveDestination(changes.destination, context);
      const retimed = changes.schedule === undefined ? undefined : validateTiming(changes.schedule);
      const finished = existing.state === "completed" || existing.state === "missed";
      const nextState: "active" | "paused" | undefined = enabled === false
        ? "paused"
        : enabled === true || (finished && retimed !== undefined)
          ? "active"
          : undefined;
      if (nextState === "active" && finished && retimed === undefined) {
        throw new ScheduleRequestError("invalid_schedule", "This one-off schedule already finished; give it a new schedule.");
      }
      let nextRunAt: string | null | undefined = retimed?.nextRunAt;
      if (nextRunAt === undefined && nextState === "active" && existing.state === "paused") {
        const next = nextTelegramScheduleOccurrence(existing.timing, now());
        if (next === undefined) {
          throw new ScheduleRequestError("invalid_schedule", "The one-off time has passed; give the schedule a new time.");
        }
        nextRunAt = next.toISOString();
      }
      const updated = store.update(id, expectedRevision, {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.prompt === undefined ? {} : { prompt: changes.prompt }),
        ...(retimed === undefined ? {} : { timing: retimed.timing }),
        ...(destination === undefined ? {} : { destination }),
        ...(nextState === undefined ? {} : { state: nextState }),
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        ...(nextState === "paused" ? { pausedReason: "Paused by request." } : {}),
      }, actor);
      fenceInFlight(id);
      arm();
      return { schedule: scheduleView(updated) };
    }
    if (operation === "delete") {
      const parsed = parseArgs(deleteArgsSchema, args);
      const existing = store.get(parsed.id);
      if (existing === undefined || existing.botId !== options.botId) {
        throw new ScheduleRequestError("not_found", "No schedule has that id.");
      }
      store.delete(parsed.id, parsed.expectedRevision, actor);
      fenceInFlight(parsed.id);
      arm();
      return { deleted: true, id: parsed.id };
    }
    throw new ScheduleRequestError("unknown_operation", "Unknown schedule operation.");
  }

  // Start: fire (or skip as missed) anything already due, then arm the timer.
  tick();

  return {
    async call(operation, args, context) {
      if (stopped) {
        return { ok: false, code: "unavailable", error: "Telegram schedules are stopping." };
      }
      try {
        return { ok: true, result: await handle(operation, args, context) };
      } catch (error) {
        if (error instanceof ScheduleRequestError) return { ok: false, code: error.code, error: error.message };
        if (error instanceof TelegramScheduleConflictError) return { ok: false, code: error.code, error: error.message };
        options.logger?.warn?.("Telegram schedules: a tool request failed.", { operation, error: errorText(error) });
        return { ok: false, code: "internal_error", error: "The schedule request failed on the host." };
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const pending = [...inFlight.values()];
      for (const entry of pending) entry.controller.abort(new Error("agent is stopping"));
      await Promise.race([
        Promise.allSettled(pending.map((entry) => entry.settled)),
        new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS).unref?.()),
      ]);
      if (options.store === undefined) store.close();
    },
  };
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new ScheduleRequestError("invalid_arguments", `${path.length > 0 ? `${path}: ` : ""}${issue?.message ?? "invalid arguments"}`);
  }
  return parsed.data;
}

function classifyDelivery(
  result: TelegramScheduleDeliveryResult,
  timedOut: boolean,
): { execution: TelegramScheduleExecution; delivery: TelegramScheduleDelivery; detail?: string } {
  if (result.delivered) return { execution: "succeeded", delivery: "delivered" };
  if (result.code === "nothing_to_report") {
    return { execution: "succeeded", delivery: "suppressed", detail: "The run reported nothing to deliver." };
  }
  if (result.reason === "agent produced no answer") {
    return { execution: "succeeded", delivery: "suppressed", detail: "The run produced no answer." };
  }
  if (result.code === "conversation_busy") {
    return { execution: "skipped_busy", delivery: "not_attempted", detail: "The destination conversation was at its queue limit." };
  }
  if (result.code === "destination_not_allowlisted" || result.reason === "telegram chat is not in the adapter allowlist") {
    return { execution: "blocked", delivery: "not_attempted", detail: "The destination chat is no longer allowlisted." };
  }
  if (result.reason === "cancelled") {
    return timedOut
      ? { execution: "timed_out", delivery: "unknown", detail: "The run exceeded its watchdog and was cancelled." }
      : { execution: "cancelled", delivery: "unknown", detail: "The run was cancelled (schedule changed, agent stopping, or /cancel)." };
  }
  if (result.reason === "responder failed") {
    return { execution: "failed", delivery: "not_attempted", detail: "The agent run failed." };
  }
  if (result.reason === "delivery failed") {
    return { execution: "succeeded", delivery: "failed", detail: "Telegram delivery failed after a successful run." };
  }
  if (result.reason === "adapter stopped") {
    return { execution: "cancelled", delivery: "not_attempted", detail: "Telegram was stopping." };
  }
  return { execution: "failed", delivery: "unknown", detail: bounded(result.reason ?? result.code ?? "unknown outcome") };
}

/** Model-visible schedule: opaque id and revision, labels and timing, never routes. */
export function scheduleView(
  schedule: TelegramScheduleRecord,
  options: { readonly promptPreview?: boolean } = {},
): Record<string, unknown> {
  const promptChars = Array.from(schedule.prompt);
  const truncated = options.promptPreview === true && promptChars.length > LIST_PROMPT_PREVIEW_CHARS;
  return {
    id: schedule.id,
    revision: schedule.revision,
    name: sanitizeTelegramLabel(schedule.name),
    prompt: truncated ? `${promptChars.slice(0, LIST_PROMPT_PREVIEW_CHARS).join("")}…` : schedule.prompt,
    ...(truncated ? { prompt_truncated: true } : {}),
    destination: schedule.destination.label,
    schedule: schedule.timing.kind === "once"
      ? { kind: "once", at: schedule.timing.at }
      : { kind: "cron", expression: schedule.timing.expression, timezone: schedule.timing.timezone },
    status: schedule.state,
    ...(schedule.pausedReason === undefined ? {} : { paused_reason: schedule.pausedReason }),
    ...(schedule.nextRunAt === undefined || schedule.state !== "active" ? {} : { next_run_at: schedule.nextRunAt }),
    ...(schedule.lastRun === undefined
      ? {}
      : {
          last_run: {
            scheduled_at: schedule.lastRun.scheduledAt,
            execution: schedule.lastRun.execution,
            delivery: schedule.lastRun.delivery,
            ...(schedule.lastRun.detail === undefined ? {} : { detail: schedule.lastRun.detail }),
          },
        }),
  };
}

function bounded(text: string): string {
  return Array.from(text).slice(0, MAX_DETAIL_CHARS).join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { OwnedStateError } from "./owned-state-sqlite.js";
import {
  inspectTelegramSchedules,
  openTelegramScheduleStore,
  TelegramScheduleConflictError,
  type TelegramScheduleRecord,
} from "./telegram-schedule-store.js";

/**
 * `mono-agent schedules list [--json]` and `mono-agent schedules delete <id>`:
 * operator access to agent-managed Telegram schedules in this agent folder.
 *
 * Listing reads the store without its lease, so it works while the agent runs.
 * Deleting takes the store's exclusive lease: it is refused while the agent is
 * running (ask the agent, or stop it first), so an operator edit can never race
 * the live scheduler.
 */

export interface RunSchedulesCommandOptions {
  readonly cwd: string;
  readonly positionals: readonly string[];
  readonly json?: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const USAGE = "Usage: mono-agent schedules [list] [--json] | mono-agent schedules delete <schedule-id>\n";

export async function runSchedulesCommand(options: RunSchedulesCommandOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const [action = "list", scheduleId, ...extra] = options.positionals;
  if (extra.length > 0 || (action === "list" && scheduleId !== undefined)
    || (action === "delete" && scheduleId === undefined) || (action !== "list" && action !== "delete")) {
    stderr(USAGE);
    return 2;
  }
  if (action === "delete" && options.json === true) {
    stderr("--json is only supported for `mono-agent schedules list`.\n");
    return 2;
  }

  if (action === "list") {
    let schedules: readonly TelegramScheduleRecord[] | undefined;
    try {
      schedules = await inspectTelegramSchedules(options.cwd);
    } catch (error) {
      return failure(stdout, stderr, options.json === true, "schedules_unreadable", reasonOf(error));
    }
    const records = schedules ?? [];
    if (options.json === true) {
      stdout(`${JSON.stringify({ ok: true, schedules: records.map(operatorView) }, null, 2)}\n`);
      return 0;
    }
    if (records.length === 0) {
      stdout("No Telegram schedules.\n");
      return 0;
    }
    for (const schedule of records) {
      stdout(`${formatSchedule(schedule)}\n`);
    }
    return 0;
  }

  let store: Awaited<ReturnType<typeof openTelegramScheduleStore>>;
  try {
    store = await openTelegramScheduleStore({ cwd: options.cwd });
  } catch (error) {
    if (error instanceof OwnedStateError && error.kind === "lease_conflict") {
      stderr("The agent is running and owns its schedules. Ask the agent to delete it, or stop the agent and retry.\n");
      return 1;
    }
    stderr(`Cannot open Telegram schedules: ${reasonOf(error)}\n`);
    return 1;
  }
  try {
    store.delete(scheduleId!, undefined, "operator-cli");
    stdout(`Deleted schedule ${scheduleId!}.\n`);
    return 0;
  } catch (error) {
    if (error instanceof TelegramScheduleConflictError && error.code === "not_found") {
      stderr(`No schedule has id ${scheduleId!}.\n`);
      return 1;
    }
    stderr(`Cannot delete schedule: ${reasonOf(error)}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function operatorView(schedule: TelegramScheduleRecord): Record<string, unknown> {
  return {
    id: schedule.id,
    revision: schedule.revision,
    name: schedule.name,
    status: schedule.state,
    ...(schedule.pausedReason === undefined ? {} : { pausedReason: schedule.pausedReason }),
    destination: schedule.destination.label,
    chatId: schedule.destination.chatId,
    schedule: schedule.timing,
    ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt }),
    ...(schedule.lastFiredAt === undefined ? {} : { lastFiredAt: schedule.lastFiredAt }),
    ...(schedule.lastRun === undefined
      ? {}
      : {
          lastRun: {
            scheduledAt: schedule.lastRun.scheduledAt,
            execution: schedule.lastRun.execution,
            delivery: schedule.lastRun.delivery,
            ...(schedule.lastRun.detail === undefined ? {} : { detail: schedule.lastRun.detail }),
          },
        }),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function formatSchedule(schedule: TelegramScheduleRecord): string {
  const timing = schedule.timing.kind === "once"
    ? `once at ${schedule.timing.at}`
    : `cron "${schedule.timing.expression}" ${schedule.timing.timezone}`;
  const next = schedule.state === "active" && schedule.nextRunAt !== undefined ? `, next ${schedule.nextRunAt}` : "";
  const last = schedule.lastRun === undefined
    ? ""
    : `, last ${schedule.lastRun.execution}/${schedule.lastRun.delivery}`;
  const paused = schedule.pausedReason === undefined ? "" : ` (${schedule.pausedReason})`;
  return `${schedule.id}  ${schedule.state}${paused}  ${schedule.name} → ${schedule.destination.label}  [${timing}${next}${last}]`;
}

function failure(
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  json: boolean,
  code: string,
  reason: string,
): number {
  if (json) {
    stdout(`${JSON.stringify({ ok: false, error: { code, message: reason } })}\n`);
  } else {
    stderr(`Cannot read Telegram schedules: ${reason}\n`);
  }
  return 1;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

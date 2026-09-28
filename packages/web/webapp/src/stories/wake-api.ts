import type { WebWakeSchedule } from "../../../src/contracts.js";
import { ApiError, api } from "../api";
import type { ThreadSummary } from "../types";

/**
 * Storybook-only wake-up schedule API.
 *
 * Installed by a story's `beforeEach` and removed by the cleanup it returns,
 * so no story mutates the shared `api` object while React renders. Every
 * server-computed value (next fire time, outcome) comes from the fixture that
 * configured the story: this is a scripted server, not a second scheduler.
 */
export interface WakeStoryServer {
  /** What the first read returns. */
  readonly schedule: WebWakeSchedule | null;
  readonly read?: "ok" | "pending" | "error";
  readonly save?: "ok" | "pending" | "conflict" | "invalid" | "error";
  /** The schedule a later read returns after `wakeStoryRemoteChange()`. */
  readonly remote?: WebWakeSchedule | null;
  /** The next fire time a successful save or resume reports. */
  readonly nextFireAt?: string | null;
}

const REMOTE_EVENT = "wake-story:remote-change";
const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

export function installWakeStoryApi(server: WakeStoryServer): () => void {
  const original = {
    wakeSchedule: api.wakeSchedule, saveWakeSchedule: api.saveWakeSchedule,
    setWakeState: api.setWakeState, deleteWakeSchedule: api.deleteWakeSchedule,
  };
  let current = server.schedule;
  const remote = () => { if (server.remote !== undefined) current = server.remote; };
  window.addEventListener(REMOTE_EVENT, remote);
  api.wakeSchedule = async () => {
    if (server.read === "pending") return never();
    if (server.read === "error") throw new Error("The example schedule service is unavailable.");
    return { schedule: current };
  };
  api.saveWakeSchedule = async (threadId, definition, expectedRevision) => {
    if (server.save === "pending") return never();
    if (server.save === "conflict") throw new ApiError("Schedule changed; reload and retry.", 409, "wake_revision_conflict");
    if (server.save === "invalid") {
      throw new ApiError("localAt: This local time does not exist in the selected timezone (daylight-saving gap).", 400, "invalid_wake_schedule");
    }
    if (server.save === "error") throw new Error("The example console is offline.");
    current = {
      scheduleId: current?.scheduleId ?? "example-schedule", threadId, sourceId: current?.sourceId ?? "atlas",
      definition, state: "active", revision: (expectedRevision ?? 0) + 1,
      nextFireAt: server.nextFireAt ?? null, lastOutcome: null, createdAt: current?.createdAt ?? "2031-01-06T09:00:00Z",
    };
    return { schedule: current };
  };
  api.setWakeState = async (_threadId, expectedRevision, state) => {
    if (current === null) throw new ApiError("No schedule exists for this conversation.", 404, "wake_schedule_not_found");
    current = { ...current, state, revision: expectedRevision + 1, lastOutcome: null,
      nextFireAt: state === "paused" ? null : server.nextFireAt ?? server.schedule?.nextFireAt ?? null };
    return { schedule: current };
  };
  api.deleteWakeSchedule = async () => { current = null; };
  return () => {
    window.removeEventListener(REMOTE_EVENT, remote);
    Object.assign(api, original);
  };
}

/** Pretend another client (or a fired wake-up) changed the schedule. */
export function wakeStoryRemoteChange(target: Window = window): void {
  target.dispatchEvent(new Event(REMOTE_EVENT));
}
export const WAKE_REMOTE_EVENT = REMOTE_EVENT;

const schedule = (id: string, overrides: Partial<WebWakeSchedule> & Pick<WebWakeSchedule, "definition">): WebWakeSchedule => ({
  scheduleId: `example-${id}`, threadId: id, sourceId: "atlas", state: "active", revision: 3,
  nextFireAt: null, lastOutcome: null, createdAt: "2031-01-06T09:00:00Z", ...overrides,
});

/** Fictional schedules; far-future dates keep the saved ones in the future. */
export const wakeFixtures = {
  activeWeekly: schedule("garden-weekly", {
    definition: { kind: "weekly", timezone: "America/Chicago", days: [1, 3, 5], times: ["07:30", "12:00", "18:15"],
      message: "Check the fictional seedling trays and note which ones need water." },
    nextFireAt: "2031-05-12T12:30:00Z", lastOutcome: "fired",
  }),
  activeOnce: schedule("garden-once", {
    definition: { kind: "once", timezone: "UTC", localAt: "2031-05-14T09:00", message: "Review the garden plan with Morgan." },
    nextFireAt: "2031-05-14T09:00:00Z",
  }),
  activeOnceDue: schedule("garden-due", {
    definition: { kind: "once", timezone: "UTC", localAt: "2031-05-14T09:00", message: "Review the garden plan." },
    nextFireAt: null,
  }),
  pausedWeekly: schedule("garden-paused", {
    definition: { kind: "weekly", timezone: "Asia/Tokyo", days: [1, 3], times: ["09:00"], message: "Check the fictional greenhouse log." },
    state: "paused",
  }),
  pausedExpiredOnce: schedule("garden-expired", {
    definition: { kind: "once", timezone: "Europe/Lisbon", localAt: "2026-03-02T08:00", message: "Order the fictional seed packets." },
    state: "paused",
  }),
  completedOnce: schedule("garden-completed", {
    definition: { kind: "once", timezone: "Europe/Lisbon", localAt: "2026-03-02T08:00", message: "Order the fictional seed packets." },
    state: "completed", lastOutcome: "uncertain",
  }),
  everyDayEight: schedule("garden-eight", {
    definition: { kind: "weekly", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6],
      times: ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"] },
    nextFireAt: "2031-05-12T06:00:00Z",
  }),
} satisfies Record<string, WebWakeSchedule>;

/** The thread summary a schedule implies, as the conversation list would carry it. */
export const wakeSummary = (value: WebWakeSchedule): NonNullable<ThreadSummary["wakeSchedule"]> => ({
  state: value.state, kind: value.definition.kind, revision: value.revision, nextFireAt: value.nextFireAt,
});

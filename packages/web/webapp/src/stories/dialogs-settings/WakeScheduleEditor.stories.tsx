import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { WakeScheduleEditor } from "../../components/WakeScheduleEditor";
import type { ThreadSummary } from "../../types";
import { gardenThread } from "../fixtures";
import { WAKE_REMOTE_EVENT, type WakeStoryServer, installWakeStoryApi, wakeFixtures, wakeStoryRemoteChange, wakeSummary } from "../wake-api";

/**
 * The editor opens from a persistent trigger, like the conversation header's
 * actions button, and can be closed and reopened: Save, Cancel, Escape and a
 * backdrop click all really close it here.
 */
function WakeEditorHarness({ thread }: { readonly thread: ThreadSummary }) {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1);
    window.addEventListener(WAKE_REMOTE_EVENT, bump);
    return () => window.removeEventListener(WAKE_REMOTE_EVENT, bump);
  }, []);
  const live = thread.wakeSchedule === undefined ? thread
    : { ...thread, wakeSchedule: { ...thread.wakeSchedule, revision: thread.wakeSchedule.revision + revision } };
  return <div style={{ display: "grid", gap: 12, justifyItems: "start" }}>
    <button ref={trigger} type="button" className="secondary-button" onClick={() => setOpen(true)}>Open wake-up schedule</button>
    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{open ? "Editor open" : "Editor closed"}</span>
    {open && <WakeScheduleEditor supportsManualCompaction thread={live} returnFocusRef={trigger} onClose={() => setOpen(false)} />}
  </div>;
}

type Args = { readonly thread: ThreadSummary; readonly server: WakeStoryServer };
const threadFor = (server: WakeStoryServer, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  ...gardenThread, archivedAt: null,
  ...(server.schedule === null ? {} : { id: server.schedule.threadId, wakeSchedule: wakeSummary(server.schedule) }),
  ...overrides,
});
/**
 * The scripted server reports the fixture's own next fire time after a
 * successful save or resume unless a story states another, so a saved
 * weekly schedule reopens with a next wake-up rather than an impossible
 * "waiting" state. New schedules state theirs explicitly.
 */
type StoryServer = Omit<WakeStoryServer, "nextFireAt"> & { readonly nextFireAt?: string | null };
const story = (input: StoryServer, extra: Partial<StoryObj<Args>> = {}, overrides: Partial<ThreadSummary> = {}): StoryObj<Args> => {
  const server: WakeStoryServer = { ...input, nextFireAt: input.nextFireAt !== undefined ? input.nextFireAt : input.schedule?.nextFireAt ?? null };
  return { args: { server, thread: threadFor(server, overrides) }, ...extra };
};
const body = (canvasElement: HTMLElement) => within(canvasElement.ownerDocument.body);
const loaded = async (canvasElement: HTMLElement) => {
  await waitFor(() => expect(body(canvasElement).getByLabelText("Message")).toBeEnabled());
};

export default {
  title: "Dialogs & Settings/WakeScheduleEditor",
  // A modal renders into the preview body; isolated canvases only, no inline docs.
  parameters: { docs: { disable: true } },
  beforeEach: ({ args }) => installWakeStoryApi((args as Args).server),
  render: (args) => <WakeEditorHarness thread={(args as Args).thread} />,
} satisfies Meta<Args>;
type Story = StoryObj<Args>;

export const NewOnce: Story = story({ schedule: null, nextFireAt: "2031-05-14T09:00:00Z" });
export const NewWeekly: Story = story({ schedule: null, nextFireAt: "2031-05-12T09:00:00Z" }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.click(view.getByRole("radio", { name: "Weekly" }));
    await userEvent.click(view.getByLabelText("Monday"));
    await userEvent.click(view.getByLabelText("Wednesday"));
  },
});
export const WeeklyNeedsDays: Story = story({ schedule: null }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    await userEvent.click(body(canvasElement).getByRole("radio", { name: "Weekly" }));
  },
});
export const ActiveWeekly: Story = story({ schedule: wakeFixtures.activeWeekly });
export const ActiveOnce: Story = story({ schedule: wakeFixtures.activeOnce });
export const ActiveOnceDueNow: Story = story({ schedule: wakeFixtures.activeOnceDue });
export const PausedWeekly: Story = story({ schedule: wakeFixtures.pausedWeekly, nextFireAt: "2031-05-12T00:00:00Z" });
export const PausedExpiredOnce: Story = story({ schedule: wakeFixtures.pausedExpiredOnce });
export const CompletedOnce: Story = story({ schedule: wakeFixtures.completedOnce });
export const LastWakeSkipped: Story = story({ schedule: { ...wakeFixtures.activeWeekly, lastOutcome: "skipped" } });
export const LastWakeFailed: Story = story({ schedule: { ...wakeFixtures.activeWeekly, lastOutcome: "failed" } });
export const EightTimes: Story = story({ schedule: wakeFixtures.everyDayEight });
export const DuplicateTimes: Story = story({ schedule: wakeFixtures.activeWeekly }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Add time" }));
    fireEvent.change(view.getByLabelText("Time 4"), { target: { value: "07:30" } });
  },
});
export const LongMessage: Story = story({ schedule: { ...wakeFixtures.activeOnce, definition: { ...wakeFixtures.activeOnce.definition,
  message: `${"Walk through the fictional allotment plan bed by bed, note what Morgan planted, and list anything that needs attention. ".repeat(8)}Thanks! 🌱` } } });
export const Loading: Story = story({ schedule: wakeFixtures.activeWeekly, read: "pending" });
export const LoadError: Story = story({ schedule: wakeFixtures.activeWeekly, read: "error" });
export const Saving: Story = story({ schedule: wakeFixtures.activeWeekly, save: "pending" }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.type(view.getByLabelText("Message"), " Include the compost bin.");
    await userEvent.click(view.getByRole("button", { name: "Save" }));
  },
});
export const ServerValidationError: Story = story({ schedule: wakeFixtures.activeOnce, save: "invalid" }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.type(view.getByLabelText("Message"), " Bring the soil test.");
    await userEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.getByRole("alert")).toBeVisible());
  },
});
// The agent edits the schedule just before this Save arrives, so the server
// answers with a stale revision; Load latest then Save succeeds.
const staleServer: StoryServer = { schedule: wakeFixtures.activeWeekly, changeBeforeFirstSave: true,
  remote: { ...wakeFixtures.activeWeekly, revision: 4, definition: { ...wakeFixtures.activeWeekly.definition, message: "Changed by the agent." } } };
const saveIntoConflict = async (canvasElement: HTMLElement) => {
  await loaded(canvasElement);
  const view = body(canvasElement);
  await userEvent.type(view.getByLabelText("Message"), " Also check the tomatoes.");
  await userEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(view.getByRole("button", { name: "Load latest" })).toBeVisible());
};
export const StaleConflict: Story = story(staleServer, { play: async ({ canvasElement }) => saveIntoConflict(canvasElement) });
export const StaleConflictRecovered: Story = story(staleServer, {
  play: async ({ canvasElement }) => {
    await saveIntoConflict(canvasElement);
    const view = body(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(view.getByLabelText("Message")).toHaveValue("Changed by the agent."));
    await userEvent.type(view.getByLabelText("Message"), " Also check the tomatoes.");
    await userEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.getByText("Editor closed")).toBeVisible());
  },
});
export const ChangedElsewhere: Story = story({ schedule: wakeFixtures.activeWeekly,
  remote: { ...wakeFixtures.activeWeekly, revision: 4, lastOutcome: "fired", nextFireAt: "2031-05-14T12:30:00Z" } }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.type(view.getByLabelText("Message"), " Also check the tomatoes.");
    wakeStoryRemoteChange(canvasElement.ownerDocument.defaultView ?? window);
    await waitFor(() => expect(view.getByRole("status")).toBeVisible());
  },
});
export const DeleteConfirm: Story = story({ schedule: wakeFixtures.activeWeekly }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    await userEvent.click(body(canvasElement).getByRole("button", { name: "Delete schedule" }));
  },
});
export const DeletePending: Story = story({ schedule: wakeFixtures.activeWeekly, remove: "pending" }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Delete schedule" }));
    await userEvent.click(view.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(view.getByRole("button", { name: /Pause/u })).toBeDisabled());
  },
});
export const LongTimezone: Story = story({ schedule: { ...wakeFixtures.activeWeekly,
  definition: { ...wakeFixtures.activeWeekly.definition, timezone: "America/Argentina/ComodRivadavia" } } });
export const Archived: Story = story({ schedule: wakeFixtures.pausedWeekly }, {}, { archivedAt: "2031-02-01T10:00:00Z" });
export const SaveClosesEditor: Story = story({ schedule: wakeFixtures.activeWeekly, nextFireAt: "2031-05-12T12:30:00Z" }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    const view = body(canvasElement);
    await userEvent.click(view.getByLabelText("Tuesday"));
    await userEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.getByText("Editor closed")).toBeVisible());
  },
});

export const MobileNewOnce: Story = { ...NewOnce, globals: { viewport: { value: "phone" } } };
export const MobileActiveWeekly: Story = { ...ActiveWeekly, globals: { viewport: { value: "phone" } } };
export const MobileEightTimes: Story = { ...EightTimes, globals: { viewport: { value: "phone" } } };
export const MobileDeleteConfirm: Story = { ...DeleteConfirm, globals: { viewport: { value: "phone" } } };
export const DarkActiveWeekly: Story = { ...ActiveWeekly, globals: { scheme: "dark" } };
export const TerracottaDarkMobileNewOnce: Story = { ...NewOnce, globals: { scheme: "dark", theme: "terracotta", viewport: { value: "phone" } } };

export const CompactFirst: Story = story({ schedule: { ...wakeFixtures.activeWeekly,
  definition: { ...wakeFixtures.activeWeekly.definition, compactFirst: true } } }, {
  play: async ({ canvasElement }) => {
    await loaded(canvasElement);
    expect(body(canvasElement).getByRole("checkbox", { name: "Compact conversation first" })).toBeChecked();
    expect(body(canvasElement).getByRole("region", { name: "Schedule summary" })).toHaveTextContent("Compact conversation first");
  },
});

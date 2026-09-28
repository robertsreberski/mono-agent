import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon } from "../../components/Icon";
import { WakeScheduleStatus } from "../../components/WakeScheduleStatus";
import { gardenThread } from "../fixtures";

/** The hint lives in the conversation menu's wake-up row; show it there. */
export default {
  title: "Chat & Messages/WakeScheduleStatus", component: WakeScheduleStatus, tags: ["autodocs"],
  decorators: [(Story) => <div className="conversation-menu-popup" style={{ position: "static" }}>
    <div className="conversation-menu-item is-wake"><Icon name="clock" size={16} />
      <span className="wake-menu-copy"><span>Edit wake-up schedule</span><Story /></span>
    </div>
  </div>],
} satisfies Meta<typeof WakeScheduleStatus>;
type Story = StoryObj<typeof WakeScheduleStatus>;
export const ActiveWeekly: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "active", revision: 1, kind: "weekly", nextFireAt: "2031-05-12T12:30:00Z" } } } };
export const ActiveOnce: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "active", revision: 1, kind: "once", nextFireAt: "2031-05-14T09:00:00Z" } } } };
export const ActiveOnceDueNow: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "active", revision: 1, kind: "once", nextFireAt: null } } } };
export const Paused: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "paused", revision: 1, kind: "weekly", nextFireAt: null } } } };
export const Completed: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "completed", revision: 1, kind: "once", nextFireAt: null } } } };

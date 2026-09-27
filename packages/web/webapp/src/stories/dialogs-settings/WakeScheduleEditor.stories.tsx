import type { Meta, StoryObj } from "@storybook/react-vite";
import { WakeScheduleEditor } from "../../components/WakeScheduleEditor";
import { gardenThread } from "../fixtures";
export default { title: "Dialogs & Settings/WakeScheduleEditor", component: WakeScheduleEditor, tags: ["autodocs"] } satisfies Meta<typeof WakeScheduleEditor>;
type Story = StoryObj<typeof WakeScheduleEditor>;
export const NewSchedule: Story = { args: { thread: gardenThread, onClose: () => {} } };
export const ActiveOnce: Story = { args: { ...NewSchedule.args!, thread: { ...gardenThread, id: "garden-active", wakeSchedule: { kind: "once", state: "active", revision: 1, nextFireAt: "2026-10-15T09:00:00Z" } } } };
export const PausedWeekly: Story = { args: { ...NewSchedule.args!, thread: { ...gardenThread, id: "garden-paused", wakeSchedule: { kind: "weekly", state: "paused", revision: 1, nextFireAt: null } } } };
export const Mobile: Story = { args: { ...NewSchedule.args! }, globals: { viewport: { value: "phone" } } };

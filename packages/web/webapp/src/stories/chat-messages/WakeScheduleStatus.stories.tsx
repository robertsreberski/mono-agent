import type { Meta, StoryObj } from "@storybook/react-vite";
import { WakeScheduleStatus } from "../../components/WakeScheduleStatus";
import { gardenThread } from "../fixtures";
export default { title: "Chat & Messages/WakeScheduleStatus", component: WakeScheduleStatus, tags: ["autodocs"] } satisfies Meta<typeof WakeScheduleStatus>;
type Story = StoryObj<typeof WakeScheduleStatus>;
export const Active: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "active", revision: 1, kind: "weekly", nextFireAt: "2026-01-16T10:00:00Z" } } } };
export const Paused: Story = { args: { thread: { ...gardenThread, wakeSchedule: { state: "paused", revision: 1, kind: "weekly", nextFireAt: null } } } };

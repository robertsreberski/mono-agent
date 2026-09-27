import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityElapsed } from "../../components/assistant-ui/ActivityElapsed";

export default { title: "Primitives/ActivityElapsed", component: ActivityElapsed, tags: ["autodocs"] } satisfies Meta<typeof ActivityElapsed>;
type Story = StoryObj<typeof ActivityElapsed>;
export const Complete: Story = { args: { timing: { startedAt: Date.parse("2026-01-15T10:00:00Z"), finishedAt: Date.parse("2026-01-15T10:00:02Z") }, live: false } };
export const Running: Story = { args: { timing: { startedAt: Date.now() - 12000 }, live: true } };

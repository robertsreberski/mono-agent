import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentStrip } from "../../components/dashboard/AgentStrip";
export default { title: "Dashboard/AgentStrip", component: AgentStrip, tags: ["autodocs"] } satisfies Meta<typeof AgentStrip>;
type Story = StoryObj<typeof AgentStrip>;
export const Connected: Story = { args: { runningCounts: new Map([["atlas", 1]]) } };
export const Idle: Story = { args: {} };

import type { Meta, StoryObj } from "@storybook/react-vite";
import { RestartAgentCard } from "../../components/RestartAgentCard";
export default { title: "Dialogs & Settings/RestartAgentCard", component: RestartAgentCard, tags: ["autodocs"] } satisfies Meta<typeof RestartAgentCard>;
type Story = StoryObj<typeof RestartAgentCard>;
export const Unavailable: Story = { args: { sourceId: "atlas", agentLabel: "Atlas", reason: "Apply a local configuration change", unavailableReason: "No supervisor available in preview" } };
export const Confirmation: Story = { args: { ...Unavailable.args!, approximateRunningCount: 2 } };

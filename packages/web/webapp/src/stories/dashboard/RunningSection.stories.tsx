import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunningSection } from "../../components/dashboard/RunningSection";
import { atlas, runningThread } from "../fixtures";
export default { title: "Dashboard/RunningSection", component: RunningSection, tags: ["autodocs"] } satisfies Meta<typeof RunningSection>;
type Story = StoryObj<typeof RunningSection>;
export const Running: Story = { args: { groups: [{ agent: atlas, threads: [runningThread] }], expandedAgentIds: new Set(), onToggleAgent: () => {}, onOpen: () => {}, total: 1, catalogModels: {}, catalogSourceId: "atlas" } };
export const Empty: Story = { args: { ...Running.args!, groups: [], total: 0 } };
export const Overflow: Story = { args: { ...Running.args!, total: 12, truncated: true } };

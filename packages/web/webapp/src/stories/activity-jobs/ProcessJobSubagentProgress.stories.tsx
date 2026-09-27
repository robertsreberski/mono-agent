import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobSubagentProgress } from "../../components/ProcessJobSubagentProgress";

export default { title: "Activity & Jobs/ProcessJobSubagentProgress", component: ProcessJobSubagentProgress, tags: ["autodocs"] } satisfies Meta<typeof ProcessJobSubagentProgress>;
type Story = StoryObj<typeof ProcessJobSubagentProgress>;
export const Unavailable: Story = { args: { open: true } };
export const Collapsed: Story = { args: { open: false } };

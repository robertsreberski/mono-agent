import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobMetaLine } from "../../components/ProcessJobSubagentProgress";

export default { title: "Activity & Jobs/ProcessJobMetaLine", component: ProcessJobMetaLine, tags: ["autodocs"] } satisfies Meta<typeof ProcessJobMetaLine>;
type Story = StoryObj<typeof ProcessJobMetaLine>;
export const Running: Story = { args: { status: "running", supplements: ["Garden planner"] } };
export const Empty: Story = { args: { status: "complete" } };

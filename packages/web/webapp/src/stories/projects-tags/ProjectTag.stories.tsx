import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectTag } from "../../components/project/ProjectTag";

export default { title: "Projects & Tags/ProjectTag", component: ProjectTag, tags: ["autodocs"] } satisfies Meta<typeof ProjectTag>;
type Story = StoryObj<typeof ProjectTag>;
export const Default: Story = { args: { name: "Garden planner", color: "blue" } };
export const Overflow: Story = { args: { name: "Garden planner and community planting calendar with notes and drafts", color: "purple" } };

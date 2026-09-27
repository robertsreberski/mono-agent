import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectsSection } from "../../components/dashboard/ProjectsSection";

export default { title: "Dashboard/ProjectsSection", component: ProjectsSection, tags: ["autodocs"] } satisfies Meta<typeof ProjectsSection>;
type Story = StoryObj<typeof ProjectsSection>;
export const Projects: Story = {};

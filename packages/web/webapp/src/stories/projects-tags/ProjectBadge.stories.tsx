import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectBadge } from "../../components/project/ProjectIdentity";
export default { title: "Projects & Tags/ProjectBadge", component: ProjectBadge, tags: ["autodocs"] } satisfies Meta<typeof ProjectBadge>;
type Story = StoryObj<typeof ProjectBadge>;
export const GardenProject: Story = {};
export const Mobile: Story = { globals: { viewport: { value: "phone" } } };

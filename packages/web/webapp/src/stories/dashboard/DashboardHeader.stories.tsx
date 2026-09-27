import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashboardHeader } from "../../components/dashboard/DashboardHeader";

export default { title: "Dashboard/DashboardHeader", component: DashboardHeader, tags: ["autodocs"] } satisfies Meta<typeof DashboardHeader>;
type Story = StoryObj<typeof DashboardHeader>;
export const Default: Story = {};

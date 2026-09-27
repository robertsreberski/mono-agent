import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashboardFooter } from "../../components/dashboard/DashboardFooter";

export default { title: "Dashboard/DashboardFooter", component: DashboardFooter, tags: ["autodocs"] } satisfies Meta<typeof DashboardFooter>;
type Story = StoryObj<typeof DashboardFooter>;
export const Default: Story = { args: { archiveShelf: true } };
export const WithoutArchive: Story = { args: { archiveShelf: false } };

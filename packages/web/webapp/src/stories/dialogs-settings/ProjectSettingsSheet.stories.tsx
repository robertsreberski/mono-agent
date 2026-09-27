import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectSettingsSheet } from "../../components/project/ProjectSettingsSheet";
const dialogRef = { current: null };
export default { title: "Dialogs & Settings/ProjectSettingsSheet", component: ProjectSettingsSheet, tags: ["autodocs"] } satisfies Meta<typeof ProjectSettingsSheet>;
type Story = StoryObj<typeof ProjectSettingsSheet>;
export const Create: Story = { args: { sheet: { mode: "create", sourceId: "atlas" }, onClose: () => {}, dialogRef } };
export const Edit: Story = { args: { ...Create.args!, sheet: { mode: "edit", projectId: "garden" } } };
export const Closed: Story = { args: { ...Create.args!, sheet: null } };
export const Mobile: Story = { args: { ...Create.args! }, globals: { viewport: { value: "phone" } } };

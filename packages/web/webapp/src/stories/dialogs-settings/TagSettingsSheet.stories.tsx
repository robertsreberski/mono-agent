import type { Meta, StoryObj } from "@storybook/react-vite";
import { TagSettingsSheet } from "../../components/tag/TagSettingsSheet";
const dialogRef = { current: null };
export default { title: "Dialogs & Settings/TagSettingsSheet", component: TagSettingsSheet, tags: ["autodocs"] } satisfies Meta<typeof TagSettingsSheet>;
type Story = StoryObj<typeof TagSettingsSheet>;
export const Create: Story = { args: { sheet: { mode: "create", sourceId: "atlas" }, onClose: () => {}, dialogRef } };
export const Edit: Story = { args: { ...Create.args!, sheet: { mode: "edit", tagId: "research" } } };
export const Closed: Story = { args: { ...Create.args!, sheet: null } };
export const Mobile: Story = { args: { ...Create.args! }, globals: { viewport: { value: "phone" } } };

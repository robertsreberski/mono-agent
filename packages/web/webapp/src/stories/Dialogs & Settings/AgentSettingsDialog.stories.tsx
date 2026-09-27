import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentSettingsDialog } from "../../components/AgentSettingsDialog";
const dialogRef = { current: null };
export default { title: "Dialogs & Settings/AgentSettingsDialog", component: AgentSettingsDialog, tags: ["autodocs"] } satisfies Meta<typeof AgentSettingsDialog>;
type Story = StoryObj<typeof AgentSettingsDialog>;
export const Open: Story = { args: { open: true, onClose: () => {}, dialogRef } };
export const Closed: Story = { args: { ...Open.args!, open: false } };
export const Mobile: Story = { args: { ...Open.args! }, globals: { viewport: { value: "phone" } } };

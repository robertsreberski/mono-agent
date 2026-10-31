import type { Meta, StoryObj } from "@storybook/react-vite";
import { CaptureStatus } from "../../components/VoiceComposer";
export default {
  title: "Primitives/Audio attachment capture (synthetic)", component: CaptureStatus,
  parameters: { docs: { description: { component: "Synthetic attachment-area recording status. Stop prepares a normal removable attachment; only ordinary Send transcribes/submits. No device/provider is used by these stories." } } },
  decorators: [(Story) => <div style={{ width: "min(620px, 100%)" }}><Story /></div>],
} satisfies Meta<typeof CaptureStatus>;
type Story = StoryObj<typeof CaptureStatus>;
export const Permission: Story = { args: { phase: "permission", seconds: 0 } };
export const Recording: Story = { args: { phase: "recording", seconds: 181 } };
export const Attaching: Story = { args: { phase: "attaching", seconds: 181 } };

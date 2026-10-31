import type { Meta, StoryObj } from "@storybook/react-vite";
import { VoiceMessagePanel } from "../../components/VoiceComposer";

export default {
  title: "Primitives/VoiceMessage (synthetic states)", component: VoiceMessagePanel, tags: ["autodocs"],
  decorators: [(Story) => <div style={{ width: "min(620px, 100%)" }}><Story /></div>],
  parameters: { docs: { description: { component: "Synthetic presentation fixtures only. No microphone or provider is used; these states do not prove device support or transcription accuracy." } } },
} satisfies Meta<typeof VoiceMessagePanel>;
type Story = StoryObj<typeof VoiceMessagePanel>;
export const Permission: Story = { args: { phase: "permission" } };
export const Recording: Story = { args: { phase: "recording", seconds: 17 } };
export const Ready: Story = { args: { phase: "ready", seconds: 17 } };
export const Transcribing: Story = { args: { phase: "transcribing", seconds: 17 } };
export const Submitting: Story = { args: { phase: "submitting", dispatched: true } };
export const ProviderFailure: Story = { args: { phase: "ready", error: "Transcription failed. Check that the local service supports this recording format, then retry Send." } };
export const ReceiptRecovery: Story = { args: { phase: "uncertain", dispatched: true, error: "Request acknowledgement unavailable." } };

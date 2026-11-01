import type { Meta, StoryObj } from "@storybook/react-vite";
import { VoiceNote } from "../../components/VoiceNote";
import { Icon } from "../../components/Icon";
import { syntheticAudio } from "../../test/synthetic-audio";

const file = new File([syntheticAudio()], "recording.webm", { type: "audio/webm" });
export default {
  title: "Primitives/Voice note (synthetic audio)", component: VoiceNote,
  parameters: { docs: { description: { component: "Generated seven-second tone; no microphone or transcription provider. Peaks decode eagerly from the local fixture; remote notes use visible dwell and respect Data Saver. The native recording formats and the normal Send lifecycle are unchanged." } } },
  decorators: [(Story) => <div style={{ width: "min(340px, 100%)" }}><Story /></div>],
  args: { id: "synthetic-story-note", name: file.name, contentType: file.type, file, recorded: true },
} satisfies Meta<typeof VoiceNote>;
type Story = StoryObj<typeof VoiceNote>;
const remove = <button type="button" className="icon-button" aria-label="Remove file"><Icon name="close" size={14} /></button>;
export const Draft: Story = { args: { actions: remove } };
export const Uploading: Story = { args: { uploading: 48, actions: remove } };
export const Failed: Story = { args: { failed: true, onRetry: () => undefined, actions: remove } };
export const Sent: Story = { args: { actions: <a href="#synthetic-download" className="icon-button" aria-label="Download recording.webm"><Icon name="download" size={14} /></a> } };
export const Playing: Story = {
  ...Draft,
  play: async ({ canvasElement }) => { canvasElement.querySelector<HTMLButtonElement>(".voice-note-play")?.click(); },
};
export const TranscriptCaption: Story = { ...Sent, args: { ...Sent.args, caption: "Add basil and keep mint in its own pot." } };
export const LongTranscript: Story = { ...Sent, args: { ...Sent.args, caption: "Start with a small collection of herbs. ".repeat(12) } };
export const UploadedAudio: Story = { args: { recorded: false, name: "garden-notes.ogg" } };

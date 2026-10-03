import type { Meta, StoryObj } from "@storybook/react-vite";
import { Preview, waitForButton } from "./AgentSettingsStoryFixture";

/** Section fixtures use the real settings screen so save, drafts and focus share their production owners. */
export default { title: "Dialogs & Settings/NewConversationsSection", component: Preview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
const base = { variant: "base" as const, section: "new-conversations" as const, layout: "split" as const };
export const AgentConfig: Story = { args: base };
export const Override: Story = { args: { ...base, variant: "override" } };
export const DraftCustom: Story = { args: { ...base, variant: "unsaved" } };
export const DraftUseAgentConfig: Story = { args: { ...base, variant: "draft-use" } };
export const LoadingCatalog: Story = { args: { ...base, variant: "loading" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Model and reasoning effort")).click(); } };
export const Saving: Story = { args: { ...base, variant: "saving" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Save for new conversations")).click(); } };
export const SaveError: Story = { args: { ...base, variant: "save-error" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Save for new conversations")).click(); } };
export const Offline: Story = { args: { ...base, variant: "offline" } };

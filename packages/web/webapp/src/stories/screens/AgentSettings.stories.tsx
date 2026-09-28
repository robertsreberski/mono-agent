import type { Meta, StoryObj } from "@storybook/react-vite";
import { Preview } from "../dialogs-settings/AgentSettingsStoryFixture";

/** Full shell composition with a live Dashboard and covered conversation column. */
export default { title: "Screens/AgentSettings", component: Preview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
export const Desktop: Story = { args: { variant: "base", section: "new-conversations", layout: "split" } };
export const Phone: Story = { args: { variant: "base", section: null, layout: "stacked" }, globals: { viewport: { value: "phone" } } };
export const DenseProviders: Story = { args: { variant: "dense", section: "providers", layout: "split" } };
export const PhoneDenseProviders: Story = { args: { variant: "dense", section: "providers", layout: "stacked" } };
export const Unsaved: Story = { args: { variant: "unsaved", section: null, layout: "split" } };
export const PhoneUnsaved: Story = { args: { variant: "unsaved", section: null, layout: "stacked" } };
export const PhoneOffline: Story = { args: { variant: "offline", section: null, layout: "stacked" } };
export const RestartFailure: Story = { args: { variant: "failure", section: "agent", layout: "split" } };

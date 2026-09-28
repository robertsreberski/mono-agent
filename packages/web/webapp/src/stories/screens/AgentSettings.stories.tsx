import type { Meta, StoryObj } from "@storybook/react-vite";
import { Preview } from "../dialogs-settings/AgentSettingsStoryFixture";

/** Full shell composition with a live Dashboard and covered conversation column. */
export default { title: "Screens/AgentSettings", component: Preview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
export const Desktop: Story = { args: { variant: "base", section: "new-conversations", layout: "split" } };
export const Phone: Story = { args: { variant: "base", section: null, layout: "stacked" }, globals: { viewport: { value: "phone" } } };

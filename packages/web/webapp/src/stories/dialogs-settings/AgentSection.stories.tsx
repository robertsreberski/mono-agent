import type { Meta, StoryObj } from "@storybook/react-vite";
import { Preview, waitForButton } from "./AgentSettingsStoryFixture";

/** Restart operations are API fixtures; only a new confirmed operation gets success styling. */
export default { title: "Dialogs & Settings/AgentSection", component: Preview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
const base = { variant: "base" as const, section: "agent" as const, layout: "split" as const };
export const Pinned: Story = { args: base };
export const Unpinned: Story = { args: { ...base, variant: "unpinned" } };
export const Confirm: Story = { args: { ...base, variant: "confirm" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); } };
export const InProgress: Story = { args: { ...base, variant: "progress" } };
export const Succeeded: Story = { args: { ...base, variant: "success" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); (await waitForButton(canvasElement, "Confirm restart")).click(); } };
export const FailedRetained: Story = { args: { ...base, variant: "failure" } };
export const NotConfirmed: Story = { args: { ...base, variant: "not-confirmed" } };
export const Unsupported: Story = { args: { ...base, variant: "unsupported" } };
export const Offline: Story = { args: { ...base, variant: "offline" } };
export const ReadError: Story = { args: { ...base, variant: "read-error" } };

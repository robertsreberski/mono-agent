import type { Meta, StoryObj } from "@storybook/react-vite";
import { Preview, waitForButton } from "./AgentSettingsStoryFixture";

/** Restart operations are API fixtures; only a new confirmed operation gets success styling. */
export default { title: "Dialogs & Settings/AgentSection", component: Preview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
const base = { variant: "base" as const, section: "agent" as const, layout: "split" as const };
export const Pinned: Story = { args: { ...base, section: null } };
export const Unpinned: Story = { args: { ...base, variant: "unpinned", section: null } };
export const Confirm: Story = { args: { ...base, variant: "confirm" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); } };
export const InProgress: Story = { args: { ...base, variant: "progress" } };
export const Succeeded: Story = { args: { ...base, variant: "success" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); (await waitForButton(canvasElement, "Confirm restart")).click(); } };
export const FailedRetained: Story = { args: { ...base, variant: "failure" } };
export const NotConfirmed: Story = { args: { ...base, variant: "not-confirmed" } };
export const Unsupported: Story = { args: { ...base, variant: "unsupported" } };
export const Offline: Story = { args: { ...base, variant: "offline" } };
export const ReadError: Story = { args: { ...base, variant: "read-error" } };
export const PinPending: Story = { args: { ...base, variant: "pin-pending", section: null }, play: async ({ canvasElement }) => { const pin = canvasElement.querySelector<HTMLElement>('[role="switch"]'); if (!pin) throw new Error("Pin control missing"); pin.click(); for (let attempt = 0; attempt < 40 && pin.getAttribute("aria-busy") !== "true"; attempt++) await new Promise((resolve) => setTimeout(resolve, 50)); if (pin.getAttribute("aria-busy") !== "true") throw new Error("Pin pending state missing"); } };
export const PinFailed: Story = { args: { ...base, variant: "pin-failed", section: null }, play: async ({ canvasElement }) => { const pin = canvasElement.querySelector<HTMLElement>('[role="switch"]'); if (!pin) throw new Error("Pin control missing"); pin.click(); for (let attempt = 0; attempt < 40 && !canvasElement.querySelector('.toast[role="alert"]'); attempt++) await new Promise((resolve) => setTimeout(resolve, 50)); if (!canvasElement.querySelector('.toast[role="alert"]')) throw new Error("Pin failure state missing"); } };
export const NoRecent: Story = { args: { ...base, variant: "no-recent" } };
export const Loading: Story = { args: { ...base, variant: "restart-loading" } };
export const ConfirmNoRunning: Story = { args: { ...base, variant: "confirm-no-running" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); } };
export const Idle: Story = { args: { ...base, variant: "idle" } };

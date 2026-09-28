import type { Meta, StoryObj } from "@storybook/react-vite";
import { Preview, waitForEnabledButton } from "./AgentSettingsStoryFixture";

/** Provider examples intentionally render the real owner and read-only API fixture. */
export default { title: "Dialogs & Settings/ProvidersSection", component: Preview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
const base = { variant: "dense" as const, section: "providers" as const, layout: "split" as const };
export const Dense: Story = { args: base };
export const NeedsAction: Story = { args: { ...base, variant: "needs-action" } };
export const UsageStale: Story = { args: { ...base, variant: "usage-stale" } };
export const UsageOnly: Story = { args: { ...base, variant: "usage-only" } };
export const NoUsageCapability: Story = { args: { ...base, variant: "no-usage" } };
export const Offline: Story = { args: { ...base, variant: "offline" } };
export const Loading: Story = { args: { ...base, variant: "provider-loading" } };
export const ChecksRunning: Story = { args: { ...base, variant: "checks-running" }, play: async ({ canvasElement }) => { (await waitForEnabledButton(canvasElement, "Check access")).click(); } };
export const ChecksComplete: Story = { args: { ...base, variant: "checks-complete" }, play: async ({ canvasElement }) => { (await waitForEnabledButton(canvasElement, "Check access")).click(); } };
export const DeviceCode: Story = { args: { ...base, variant: "device-code" }, play: async ({ canvasElement }) => { (await waitForEnabledButton(canvasElement, "Re-authenticate Claude")).click(); } };
export const Prompt: Story = { args: { ...base, variant: "prompt" }, play: async ({ canvasElement }) => { (await waitForEnabledButton(canvasElement, "Re-authenticate Claude")).click(); } };
export const Unsupported: Story = { args: { ...base, variant: "provider-unsupported" } };
export const PhoneStress: Story = { args: { ...base, variant: "stress", layout: "stacked" }, globals: { viewport: { value: "phone" } } };

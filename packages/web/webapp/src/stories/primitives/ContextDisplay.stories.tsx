import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextDisplay } from "../../components/assistant-ui/ContextDisplay";
import { atlas } from "../fixtures";
import { openOverlay, waitForOverlay } from "../overlay-play";

const moderate = { status: "current" as const, usage: { total: 6400, contextWindow: 32000, model: "atlas/standard", input: 4200, cachedInput: 1100, output: 1100 } };
const processed = { input: 3200, cachedInput: 600, output: 1200, cacheHitRatio: 0.16 };
const providerAgent = { ...atlas, sourceId: "atlas-story-usage", supportsProviderUsage: true as const, status: "online" as const };
const providerUsage = { agent: providerAgent, providerId: "anthropic" };
const open: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await openOverlay(canvasElement, '[data-slot="context-display-trigger"]', '.context-display-popover');
};
const compact: NonNullable<Story["play"]> = async (context) => {
  await open(context);
  const button = context.canvasElement.ownerDocument.querySelector<HTMLButtonElement>('.context-display-compact button');
  if (!button) throw new Error("Compact control missing");
  button.click();
};

export default {
  title: "Primitives/ContextDisplay",
  component: ContextDisplay,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "Context usage dialog in the chat composer toolbar. Choose an open story to inspect the popup, its provider usage meters and compaction feedback." } } },
} satisfies Meta<typeof ContextDisplay>;
type Story = StoryObj<typeof ContextDisplay>;
export const Closed: Story = { args: { context: moderate, processed } };
export const Current: Story = { args: { context: moderate, processed }, play: open };
export const NearlyFull: Story = { args: { context: { ...moderate, usage: { ...moderate.usage, total: 29440 } }, processed }, play: open };
export const Updating: Story = { args: { context: { ...moderate, status: "updating", reason: "Waiting for a fresh provider measurement." }, processed }, play: open };
export const LastMeasured: Story = { args: { context: { ...moderate, status: "last_measured", reason: "The most recent completed turn supplied this value." }, processed }, play: open };
export const AwaitingMeasurement: Story = { args: { context: { status: "awaiting_measurement" } }, play: open };
export const WithCost: Story = { args: { context: moderate, processed, conversationCost: 0.24 }, play: open };
export const WithCompact: Story = { args: { context: moderate, compactThreadId: "garden-compact-result" }, play: open };
export const CompactResult: Story = { args: WithCompact.args, play: async (context) => { await compact(context); await waitForOverlay(context.canvasElement, '.context-display-compact [role="status"]'); } };
export const CompactError: Story = { args: { context: moderate, compactThreadId: "garden-compact-error" }, play: async (context) => { await compact(context); await waitForOverlay(context.canvasElement, '.context-display-compact [role="alert"]'); } };
export const CompactBlocked: Story = { args: { context: moderate, compactThreadId: "garden-compact-result", compactBlocked: true }, play: open };
export const WithProviderUsage: Story = { args: { context: moderate, processed, conversationCost: 0.24, providerUsage }, play: async (context) => { await open(context); await waitForOverlay(context.canvasElement, '.context-display-provider-usage .provider-usage'); } };
export const ProviderUsageLoading: Story = { args: { context: moderate, providerUsage: { agent: { ...providerAgent, sourceId: "atlas-story-usage-loading" }, providerId: "anthropic" } }, play: async (context) => { await open(context); await waitForOverlay(context.canvasElement, '.context-display-provider-loading'); } };
export const Mobile: Story = { args: WithProviderUsage.args, play: WithProviderUsage.play, globals: { viewport: { value: "phone" } } };

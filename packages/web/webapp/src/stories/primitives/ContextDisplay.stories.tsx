import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WebThreadUsage } from "../../../../src/contracts.js";
import { ContextDisplay } from "../../components/assistant-ui/ContextDisplay";
import { atlas } from "../fixtures";
import { openOverlay, waitForOverlay } from "../overlay-play";

const moderate = { status: "current" as const, measuredModel: "atlas/standard", usage: { total: 84_210, contextWindow: 200_000, model: "atlas/standard" } };
const typical: WebThreadUsage = { total: { tokens: { input: 68_000, cacheRead: 45_000, cacheWrite: 2_000, output: 11_000 }, costUsd: 2.24 },
  byModel: [{ model: "atlas/standard", costUsd: 2.24 }], computedAt: "2026-09-19T12:00:00Z" };
const mixed: WebThreadUsage = { total: { tokens: { input: 89_000, cacheRead: 72_000, cacheWrite: 3_000, output: 22_000 }, tokensPartial: true, costUsd: 4.18 },
  subagents: { runs: 3, costUsd: 1.12, tokensPartial: true }, byModel: [
    { model: "atlas/standard", costUsd: 3.06 }, { model: "grove/fast", costUsd: 1.12 },
  ], computedAt: "2026-09-19T12:00:00Z" };
const providerAgent = { ...atlas, sourceId: "atlas-story-usage", supportsProviderUsage: true as const, status: "online" as const };
const providerUsage = { agent: providerAgent, providerId: "anthropic" };
const open: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await openOverlay(canvasElement, '[data-slot="context-display-trigger"]', '.context-display-popover');
};
const withPlan: NonNullable<Story["play"]> = async (context) => {
  await open(context);
  await waitForOverlay(context.canvasElement, '.context-display-plan-windows');
};
const compact: NonNullable<Story["play"]> = async (context) => {
  await open(context);
  const button = context.canvasElement.ownerDocument.querySelector<HTMLButtonElement>('.context-display-compact-button');
  if (!button) throw new Error("Compact control missing");
  button.click();
};
const base = { context: moderate, totals: typical, compactThreadId: "garden-compact-result", providerUsage };

export default {
  title: "Primitives/ContextDisplay",
  component: ContextDisplay,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "Conversation context occupancy, processed tokens, estimated cost, provider plan and manual compaction. Fictional data only." } } },
} satisfies Meta<typeof ContextDisplay>;
type Story = StoryObj<typeof ContextDisplay>;
export const Closed: Story = { args: base };
export const Typical: Story = { args: { ...base, threadId: "garden-usage-typical", totals: undefined }, play: withPlan };
export const Current: Story = Typical;
export const WithCost: Story = Typical;
export const WithProviderUsage: Story = Typical;
export const MultiModelSubagents: Story = { args: { ...base, context: { ...moderate, usage: { ...moderate.usage, total: 132_000 } }, threadId: "garden-usage-mixed", totals: undefined }, play: withPlan };
export const NearlyFull: Story = { args: { ...base, totals: mixed, context: { ...moderate, usage: { ...moderate.usage, total: 184_000 } } }, play: withPlan };
export const Critical: Story = { args: { ...base, context: { ...moderate, usage: { ...moderate.usage, total: 192_000 } } }, play: withPlan };
export const Running: Story = { args: { ...base, context: { ...moderate, status: "updating" }, running: true, compactBlocked: true }, play: withPlan };
export const FirstTurn: Story = { args: { context: { status: "updating" }, running: true, compactBlocked: true, totals: { total: {}, byModel: [], computedAt: typical.computedAt }, compactThreadId: "garden-compact-result",
  providerUsage: { ...providerUsage, agent: { ...providerAgent, sourceId: "atlas-story-usage-loading" } } }, play: open };
export const AutoCompacting: Story = { args: { ...base, context: { status: "awaiting_measurement", usage: moderate.usage, compaction: { running: true } }, compactBlocked: true }, play: withPlan };
export const Compacting: Story = { args: { ...base, compactThreadId: "garden-compact-pending" }, play: compact };
export const Compacted: Story = { args: { ...base, context: { status: "awaiting_measurement", usage: { total: 41_300, contextWindow: 200_000 }, compaction: { running: false, tokensBefore: 183_400, tokensAfter: 41_300 }, reason: "Estimated after compaction. Measured exactly on the next turn." } }, play: withPlan };
export const CompactBlocked: Story = { args: { ...base, compactBlocked: true }, play: withPlan };
export const CompactSkipped: Story = { args: { ...base, compactThreadId: "garden-compact-skipped" }, play: compact };
export const CompactModelChanged: Story = { args: { ...base, compactThreadId: "garden-compact-model" }, play: compact };
export const CompactFailed: Story = { args: { ...base, compactThreadId: "garden-compact-failed" }, play: compact };
export const CompactError: Story = { args: { ...base, compactThreadId: "garden-compact-error" }, play: compact };
export const CompactConnectionLost: Story = { args: { ...base, compactThreadId: "garden-compact-lost" }, play: compact };
export const LastMeasured: Story = { args: { ...base, context: { status: "last_measured", usage: moderate.usage,
  reason: "This measurement belongs to atlas/standard; the next turn is set to grove/fast." } }, play: withPlan };
export const Unavailable: Story = { args: { context: { status: "unavailable" }, totals: typical }, play: open };
export const PartialData: Story = { args: { ...base, context: { status: "last_measured", usage: { total: 142_300, contextWindow: 200_000 }, reason: "The latest turn did not complete, so this is the last successful provider measurement." },
  totals: { ...mixed, total: { ...mixed.total, costPartial: true }, byModel: [{ model: "atlas/standard", costUsd: 3.06, costPartial: true }, mixed.byModel[1]!] },
  providerUsage: { ...providerUsage, agent: { ...providerAgent, sourceId: "atlas-story-usage-stale" } } }, play: withPlan };
export const CostUnknown: Story = { args: { ...base, totals: { total: { tokens: typical.total.tokens, costPartial: true }, byModel: [], computedAt: typical.computedAt } }, play: open };
export const TotalsLoading: Story = { args: { context: moderate, threadId: "garden-usage-pending", providerUsage }, play: open };
export const ProviderUsageLoading: Story = { args: { ...base, providerUsage: { ...providerUsage, agent: { ...providerAgent, sourceId: "atlas-story-usage-loading" } } }, play: open };
export const ProviderUsageStale: Story = { args: { ...base, providerUsage: { ...providerUsage, agent: { ...providerAgent, sourceId: "atlas-story-usage-stale" } } }, play: withPlan };
export const ProviderUsageError: Story = { args: { ...base, providerUsage: { ...providerUsage, agent: { ...providerAgent, sourceId: "atlas-story-usage-error" } } }, play: open };
export const Mobile: Story = { args: MultiModelSubagents.args, play: MultiModelSubagents.play, globals: { viewport: { value: "phone" } } };
export const MobileNearlyFull: Story = { args: NearlyFull.args, play: NearlyFull.play, globals: { viewport: { value: "phone" } } };

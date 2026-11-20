import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageAnalyticsView } from "../../components/usage-analytics/UsageAnalyticsView";
import { jitteredQuotaHistoryFixture, usageAnalyticsFixture } from "../../test/usage-analytics-fixtures";

const fixture = usageAnalyticsFixture();
export default { title: "Screens/Usage analytics", component: UsageAnalyticsView, tags: ["autodocs"], parameters: { layout: "fullscreen" },
  decorators: [Story => <div style={{ height: "100dvh" }}><Story /></div>],
  args: { ...fixture, agentLabel: "Fictional sample agent · synthetic data", range: "24h", onRange: () => undefined, onRefresh: () => undefined, onClose: () => undefined,
    onVendorRefresh: () => undefined, onClear: async () => undefined, onOpenConversation: () => undefined, onOpenProject: () => undefined },
} satisfies Meta<typeof UsageAnalyticsView>;
type Story = StoryObj<typeof UsageAnalyticsView>;
export const Desktop: Story = {};
export const Mobile: Story = { globals: { viewport: { value: "phone" } } };
export const JitteredQuotaHistory: Story = {
  args: { history: jitteredQuotaHistoryFixture(), data: null, range: "7d" },
  globals: { scheme: "light" },
};
export const JitteredQuotaHistoryDark: Story = { ...JitteredQuotaHistory, globals: { scheme: "dark" } };
export const PartialStaleAccountBoundary: Story = { args: usageAnalyticsFixture(true, true) };
export const Empty: Story = { args: { data: { ...fixture.data, total: {}, topConversations: [], topProjects: [], buckets: fixture.data.buckets.map(b => ({ ...b, total: {}, models: [] })), coverage: { messages: 0, conversations: 0, projects: 0, containsRunningUsage: false, tokensPartial: false, costPartial: false } }, history: { ...fixture.history, providers: fixture.history.providers.map(p => ({ ...p, samples: [], accountChanges: [] })) } } };
export const OlderOfflineAgent: Story = { args: { history: null, historyError: "Quota history needs a live supporting agent. Retained conversation accounting is still available.", onVendorRefresh: undefined, onClear: undefined } };
export const StorageUnavailable: Story = { args: { history: { ...fixture.history, storage: "unavailable", providers: [] } } };

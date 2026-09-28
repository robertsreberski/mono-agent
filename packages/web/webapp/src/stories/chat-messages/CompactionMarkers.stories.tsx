import type { Meta, StoryObj } from "@storybook/react-vite";
import { CompactionMarkerRow } from "../../components/Messages";

export default { title: "Chat & Messages/CompactionMarkers", component: CompactionMarkerRow, tags: ["autodocs"] } satisfies Meta<typeof CompactionMarkerRow>;
type Story = StoryObj<typeof CompactionMarkerRow>;
const base = { type: "conversation-marker" as const, kind: "compaction" as const, at: "2026-01-15T10:00:00Z", operationId: "fictional-compaction", trigger: "manual" as const, status: "succeeded" as const, tokensBefore: 183_400, tokensAfter: 41_300 };
export const ManualSucceeded: Story = { args: { marker: base } };
export const AutomaticSucceeded: Story = { args: { marker: { ...base, trigger: "automatic" } } };
export const ManualSkipped: Story = { args: { marker: { ...base, status: "skipped" } } };
export const AutomaticSkipped: Story = { args: { marker: { ...base, trigger: "automatic", status: "skipped" } } };
export const ManualFailed: Story = { args: { marker: { ...base, status: "failed" } } };
export const AutomaticFailed: Story = { args: { marker: { ...base, trigger: "automatic", status: "failed" } } };
